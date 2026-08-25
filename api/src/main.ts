import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import helmet from 'helmet';
import * as express from 'express';
import { AppModule } from './app.module';
import { DEFAULT_API_JSON_LIMIT_MB } from '@meowbox/shared';
import { assertCredentialKeyConfigured } from './common/crypto/credentials-cipher';
import { isReleaseMaintenanceActive } from './common/release-maintenance';
import { declaredContentLength, requestBodyBudget } from './common/http/payload-budget';
import { hasFederationAssertionAttempt } from './federation/federation-delegation.guard';

// Прогреваем DNS-credentials key до старта Nest. Если файла .dns-key нет —
// он будет автогенерирован сейчас, чтобы первый запрос пользователя на /api/dns
// не делал I/O в hot-path и не нарвался на гонку при многопроцессовом запуске.
try {
  assertCredentialKeyConfigured();
} catch (err) {
  // Невалидный ENV override (плохой base64 или неправильная длина) — фейлим
  // громко, чтобы юзер сразу понял проблему, а не ловил 500 в DNS-роутах.
  // eslint-disable-next-line no-console
  console.error('[bootstrap] Credentials cipher init failed:', (err as Error).message);
  process.exit(1);
}

// Prisma BigInt fields need JSON serialization support
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
  return Number(this);
};

// Глобальная сетка безопасности: любой Promise без catch не должен ронять API.
// Раньше Prisma-таймауты (SQLite-локи под нагрузкой db-dump-import) уходили в
// unhandledRejection → процесс умирал → PM2 рестарт → миграционный item
// помечался orphan FAILED. Теперь только пишем в лог и продолжаем работать.
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error(
    '[unhandledRejection]',
    reason instanceof Error ? reason.stack || reason.message : reason,
  );
});
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('[uncaughtException]', err.stack || err.message);
});

async function bootstrap() {
  // bodyParser: false — отключаем дефолтный JSON-парсер NestJS, чтобы он
  // не «съедал» raw body для /api/proxy/* (multipart, бинарь). Парсеры
  // подключаем вручную с правильным порядком: raw для proxy, json/urlencoded
  // для всего остального.
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
    bodyParser: false,
  });

  // Включаем NestJS shutdown hooks — без этого pm2 reload не мог остановить
  // старый воркер: SIGINT/SIGTERM не вызывали app.close(), активные таймеры
  // (setInterval в panel-update watcher, sessions GC) держали event loop,
  // и Node висел до SIGKILL по kill_timeout (5s). После SIGKILL pm2 спавнил
  // новый воркер, но из-за этого reload занимал 5+ секунд и часто валил
  // graceful gate. Теперь NestJS получает сигнал → вызывает onModuleDestroy
  // на всех модулях → закрывает HTTP сервер → процесс выходит сразу.
  app.enableShutdownHooks();

  // --- Security: trust proxy (loopback) ---
  // API живёт за nginx на 127.0.0.1. Без trust-proxy req.ip всегда 127.0.0.1
  // → IpAllowlistGuard всегда пропускает по loopback bypass'у → allowlist
  // бесполезен. Доверяем только loopback, чтобы X-Forwarded-For нельзя было
  // подделать с публичных IP (внешние L7-балансеры на отдельной IP — вне
  // дефолтного сетапа Meowbox).
  const expressApp = app.getHttpAdapter().getInstance() as { set: (k: string, v: string | boolean) => void };
  expressApp.set('trust proxy', 'loopback');

  app.use(
    (
      req: { method?: string },
      res: {
        setHeader: (name: string, value: string) => void;
        status: (code: number) => { json: (body: unknown) => void };
      },
      next: () => void,
    ) => {
      const method = (req.method || 'GET').toUpperCase();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && isReleaseMaintenanceActive()) {
        res.setHeader('Retry-After', '30');
        res.status(503).json({
          success: false,
          error: {
            code: 'RELEASE_MAINTENANCE',
            message: 'Panel writes are temporarily paused for a release migration',
          },
        });
        return;
      }
      next();
    },
  );

  // --- Security: HTTP headers ---
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", 'wss:', 'ws:'],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: true,
      crossOriginOpenerPolicy: true,
      crossOriginResourcePolicy: { policy: 'same-origin' },
      dnsPrefetchControl: true,
      frameguard: { action: 'deny' },
      hidePoweredBy: true,
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
      ieNoOpen: true,
      noSniff: true,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      xssFilter: true,
    }),
  );

  // --- Security: CORS ---
  // FAIL-FAST: если PANEL_DOMAIN не задана — стартовать опасно. До этого при
  // пустом domain получали `origin: false` (запрет всех → web не работает) ИЛИ
  // в некоторых конфигах любое origin проходило. Теперь явно требуем env.
  const panelDomain = process.env.PANEL_DOMAIN?.trim();
  const extraOrigins = (process.env.CORS_EXTRA_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bootLogger = new Logger('Bootstrap');

  if (!panelDomain && extraOrigins.length === 0) {
    bootLogger.error(
      'PANEL_DOMAIN is not set. Set PANEL_DOMAIN=example.com in .env ' +
        '(or CORS_EXTRA_ORIGINS=https://host1,https://host2 for dev). ' +
        'Refusing to start with unknown CORS origin.',
    );
    process.exit(1);
  }

  const webPort = process.env.WEB_PORT;
  const corsOrigins: string[] = [];
  if (panelDomain) {
    corsOrigins.push(`https://${panelDomain}`, `http://${panelDomain}`);
    if (webPort) {
      corsOrigins.push(
        `https://${panelDomain}:${webPort}`,
        `http://${panelDomain}:${webPort}`,
      );
    }
  }
  corsOrigins.push(...extraOrigins);

  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Proxy-Token'],
    maxAge: 3600,
  });

  // --- Security: Global validation pipe ---
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      disableErrorMessages: process.env.NODE_ENV === 'production',
    }),
  );

  // --- Security: Limit payload size ---
  app.use(
    (
      req: {
        method?: string;
        url?: string;
        headers: Record<string, string | string[] | undefined>;
      },
      res: { status: (code: number) => { json: (body: unknown) => void } },
      next: () => void,
    ) => {
      const contentLength = declaredContentLength(req.headers['content-length']);
      const maxSize = requestBodyBudget(req);
      if (contentLength !== null && contentLength > BigInt(maxSize)) {
        res.status(413).json({ success: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } });
        return;
      }
      next();
    },
  );

  // --- Body parsers (после отключения дефолтного через bodyParser: false) ---
  // Порядок важен: для /api/proxy/* — raw (Buffer); для остальных — json + urlencoded.
  // Лимиты совпадают с тем, что было в дефолтном парсере NestJS.
  const jsonLimitMb = Number(process.env.API_JSON_LIMIT_MB) || DEFAULT_API_JSON_LIMIT_MB;

  // 1) Signed target control requests must reach FederationDelegationGuard as
  //    exact bounded bytes. The guard validates and only then JSON-decodes.
  app.use(
    express.raw({
      type: (req) => hasFederationAssertionAttempt(req.headers),
      limit: '1mb',
      inflate: false,
    }),
  );

  // 2) Remote control bodies are bounded to the protocol-1 1 MiB contract.
  //    Multipart, binary and large payloads require transfer sessions.
  app.use(
    '/api/proxy',
    express.raw({
      type: '*/*',
      limit: '1mb',
      inflate: false,
    }),
  );

  // 3) Provider webhook signatures bind the exact request bytes. Capture
  //    both the stable master ingress and the legacy direct-target route
  //    before any JSON parser can normalize whitespace or Unicode escapes.
  for (const webhookPath of ['/api/public/v1/webhooks', '/api/deploy/webhook']) {
    app.use(
      webhookPath,
      express.raw({
        type: '*/*',
        limit: '64kb',
        inflate: false,
      }),
    );
  }

  // 4) Стандартный JSON для всего остального API. Multer (file-uploads) сам
  //    обрабатывает multipart per-controller через FileInterceptor — поэтому
  //    json-парсер тут безопасен (он не трогает multipart bodies).
  app.use(express.json({ limit: `${jsonLimitMb}mb` }));
  app.use(express.urlencoded({ extended: true, limit: `${jsonLimitMb}mb` }));

  app.setGlobalPrefix('api');

  // API_PORT — новое каноническое имя. PANEL_PORT оставлен для обратной совместимости со старыми .env.
  const port = parseInt(process.env.API_PORT || process.env.PANEL_PORT || '11860', 10);
  const host = process.env.API_HOST || (process.env.PROXY_TOKEN ? '0.0.0.0' : '127.0.0.1');
  await app.listen(port, host);

  // Сигнал PM2 о готовности процесса.
  //
  // В ecosystem.config.js для meowbox-api стоит `wait_ready: true` +
  // `listen_timeout: 10000` — без этого сигнала pm2 reload зависает на 10
  // секунд, считает реплику не поднявшейся и валит rolling-restart. Из-за
  // этого update.sh стабильно ловил "PM2 reload failed" на стадии reload,
  // хотя сам апдейт уже был накачен. Один process.send('ready') решает.
  //
  // wait_ready нам нужен, чтобы pm2 не убивал старый воркер пока новый
  // не открыл порт — это защищает от 502 во время graceful reload.
  if (typeof process.send === 'function') {
    try { process.send('ready'); } catch { /* IPC может быть закрыт — pm2 fallback на listen_timeout */ }
  }
}

bootstrap();
