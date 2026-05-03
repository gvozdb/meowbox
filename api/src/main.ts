import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import helmet from 'helmet';
import * as express from 'express';
import { AppModule } from './app.module';
import {
  DEFAULT_API_JSON_LIMIT_MB,
  DEFAULT_API_UPLOAD_LIMIT_MB,
} from '@meowbox/shared';
import { assertCredentialKeyConfigured } from './common/crypto/credentials-cipher';

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
      req: { url?: string; headers: Record<string, string | undefined> },
      res: { status: (code: number) => { json: (body: unknown) => void } },
      next: () => void,
    ) => {
      // Proxy-роут пропускает любые типы тел (multipart, бинарь, JSON) —
      // не ограничиваем JSON-лимитом, ориентируемся только на upload-лимит.
      const isProxy = (req.url ?? '').startsWith('/api/proxy/');
      const contentType = req.headers['content-type'] || '';
      const contentLength = parseInt(req.headers['content-length'] || '0', 10);
      // Allow larger payloads for file uploads (multipart/form-data).
      // Переопределяется env API_JSON_LIMIT_MB / API_UPLOAD_LIMIT_MB.
      const jsonLimitMb = Number(process.env.API_JSON_LIMIT_MB) || DEFAULT_API_JSON_LIMIT_MB;
      const uploadLimitMb = Number(process.env.API_UPLOAD_LIMIT_MB) || DEFAULT_API_UPLOAD_LIMIT_MB;
      const maxSize = isProxy || contentType.includes('multipart/form-data')
        ? uploadLimitMb * 1024 * 1024
        : jsonLimitMb * 1024 * 1024;
      if (contentLength > maxSize) {
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
  const uploadLimitMb = Number(process.env.API_UPLOAD_LIMIT_MB) || DEFAULT_API_UPLOAD_LIMIT_MB;

  // 1) Raw body для proxy: нужен ОРИГИНАЛЬНЫЙ Buffer с оригинальным
  //    Content-Type, чтобы 1:1 ретранслировать на slave (multipart, бинарь, JSON).
  //    inflate=false: если slave когда-нибудь будет gzip-ить запрос — мы
  //    ретранслируем его как есть (без распаковки, с сохранением CE).
  app.use(
    '/api/proxy',
    express.raw({
      type: '*/*',
      limit: `${uploadLimitMb}mb`,
      inflate: false,
    }),
  );

  // 2) Стандартный JSON для всего остального API. Multer (file-uploads) сам
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
