import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import helmet from 'helmet';
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

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
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
      req: { headers: Record<string, string | undefined> },
      res: { status: (code: number) => { json: (body: unknown) => void } },
      next: () => void,
    ) => {
      const contentType = req.headers['content-type'] || '';
      const contentLength = parseInt(req.headers['content-length'] || '0', 10);
      // Allow larger payloads for file uploads (multipart/form-data).
      // Переопределяется env API_JSON_LIMIT_MB / API_UPLOAD_LIMIT_MB.
      const jsonLimitMb = Number(process.env.API_JSON_LIMIT_MB) || DEFAULT_API_JSON_LIMIT_MB;
      const uploadLimitMb = Number(process.env.API_UPLOAD_LIMIT_MB) || DEFAULT_API_UPLOAD_LIMIT_MB;
      const maxSize = contentType.includes('multipart/form-data')
        ? uploadLimitMb * 1024 * 1024
        : jsonLimitMb * 1024 * 1024;
      if (contentLength > maxSize) {
        res.status(413).json({ success: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } });
        return;
      }
      next();
    },
  );

  app.setGlobalPrefix('api');

  // API_PORT — новое каноническое имя. PANEL_PORT оставлен для обратной совместимости со старыми .env.
  const port = parseInt(process.env.API_PORT || process.env.PANEL_PORT || '11860', 10);
  const host = process.env.API_HOST || (process.env.PROXY_TOKEN ? '0.0.0.0' : '127.0.0.1');
  await app.listen(port, host);
}

bootstrap();
