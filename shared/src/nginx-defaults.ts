/**
 * Дефолты для layered nginx-конфигов сайтов.
 *
 * Используются:
 *  - агентом при генерации `/etc/nginx/meowbox/{siteName}/*.conf` если в БД
 *    значение поля null/0 (юзер не задал кастом);
 *  - API при возвращении настроек в UI (resolved value, чтобы юзер видел
 *    актуальный effective default).
 *
 * При смене значений здесь — поведение существующих сайтов меняется только
 * после регенерации nginx-конфига (через `make migrate-system` или ручной
 * PUT /sites/:id/nginx/settings).
 */
export const NGINX_DEFAULTS = Object.freeze({
  /** client_max_body_size — общий лимит для всего сайта. */
  clientMaxBodySize: '32M',

  /** fastcgi_*_timeout (сек). 60 — стандарт; долгие импорты в админках MODX/WP могут потребовать больше. */
  fastcgiReadTimeout: 60,
  fastcgiSendTimeout: 60,
  fastcgiConnectTimeout: 60,

  /** fastcgi_buffer_size в KB. Дефолт 32 — справляется с типичными PHP-ответами. */
  fastcgiBufferSizeKb: 32,
  /** fastcgi_buffers count. Размер каждого = bufferSizeKb / 2 (округляется до целого). */
  fastcgiBufferCount: 16,

  /** HTTP/2 включён по дефолту (только при SSL). */
  http2: true,

  /** HSTS выключен по дефолту — включается ручкой в UI после того, как юзер уверен. */
  hsts: false,

  /** Gzip включён. */
  gzip: true,

  /** Rate limiting включён по умолчанию. */
  rateLimitEnabled: true,
  /** Запросов в секунду на IP (limit_req_zone rate). */
  rateLimitRps: 30,
  /** Burst (`limit_req ... burst=`). */
  rateLimitBurst: 60,
} as const);

export type NginxDefaults = typeof NGINX_DEFAULTS;

/**
 * Соединяет per-site override с дефолтом. null/undefined/0 трактуются как
 * "взять дефолт". Для строкового `clientMaxBodySize` пустая строка тоже = дефолт.
 */
export interface SiteNginxOverrides {
  clientMaxBodySize?: string | null;
  fastcgiReadTimeout?: number | null;
  fastcgiSendTimeout?: number | null;
  fastcgiConnectTimeout?: number | null;
  fastcgiBufferSizeKb?: number | null;
  fastcgiBufferCount?: number | null;
  http2?: boolean | null;
  hsts?: boolean | null;
  gzip?: boolean | null;
  rateLimitEnabled?: boolean | null;
  rateLimitRps?: number | null;
  rateLimitBurst?: number | null;
}

export interface ResolvedNginxSettings {
  clientMaxBodySize: string;
  fastcgiReadTimeout: number;
  fastcgiSendTimeout: number;
  fastcgiConnectTimeout: number;
  fastcgiBufferSizeKb: number;
  fastcgiBufferCount: number;
  http2: boolean;
  hsts: boolean;
  gzip: boolean;
  rateLimitEnabled: boolean;
  rateLimitRps: number;
  rateLimitBurst: number;
}

export function resolveNginxSettings(overrides: SiteNginxOverrides): ResolvedNginxSettings {
  return {
    clientMaxBodySize:
      typeof overrides.clientMaxBodySize === 'string' && overrides.clientMaxBodySize.trim()
        ? overrides.clientMaxBodySize.trim()
        : NGINX_DEFAULTS.clientMaxBodySize,
    fastcgiReadTimeout:
      typeof overrides.fastcgiReadTimeout === 'number' && overrides.fastcgiReadTimeout > 0
        ? overrides.fastcgiReadTimeout
        : NGINX_DEFAULTS.fastcgiReadTimeout,
    fastcgiSendTimeout:
      typeof overrides.fastcgiSendTimeout === 'number' && overrides.fastcgiSendTimeout > 0
        ? overrides.fastcgiSendTimeout
        : NGINX_DEFAULTS.fastcgiSendTimeout,
    fastcgiConnectTimeout:
      typeof overrides.fastcgiConnectTimeout === 'number' && overrides.fastcgiConnectTimeout > 0
        ? overrides.fastcgiConnectTimeout
        : NGINX_DEFAULTS.fastcgiConnectTimeout,
    fastcgiBufferSizeKb:
      typeof overrides.fastcgiBufferSizeKb === 'number' && overrides.fastcgiBufferSizeKb > 0
        ? overrides.fastcgiBufferSizeKb
        : NGINX_DEFAULTS.fastcgiBufferSizeKb,
    fastcgiBufferCount:
      typeof overrides.fastcgiBufferCount === 'number' && overrides.fastcgiBufferCount > 0
        ? overrides.fastcgiBufferCount
        : NGINX_DEFAULTS.fastcgiBufferCount,
    http2: typeof overrides.http2 === 'boolean' ? overrides.http2 : NGINX_DEFAULTS.http2,
    hsts: typeof overrides.hsts === 'boolean' ? overrides.hsts : NGINX_DEFAULTS.hsts,
    gzip: typeof overrides.gzip === 'boolean' ? overrides.gzip : NGINX_DEFAULTS.gzip,
    rateLimitEnabled:
      typeof overrides.rateLimitEnabled === 'boolean'
        ? overrides.rateLimitEnabled
        : NGINX_DEFAULTS.rateLimitEnabled,
    rateLimitRps:
      typeof overrides.rateLimitRps === 'number' && overrides.rateLimitRps > 0
        ? overrides.rateLimitRps
        : NGINX_DEFAULTS.rateLimitRps,
    rateLimitBurst:
      typeof overrides.rateLimitBurst === 'number' && overrides.rateLimitBurst > 0
        ? overrides.rateLimitBurst
        : NGINX_DEFAULTS.rateLimitBurst,
  };
}

/**
 * Маппинг столбцов БД (snake_case Prisma → camelCase Override). Принимает
 * частичную выборку Site (только nginx*-поля), чтобы можно было использовать
 * с любым `select` без strict-типизации модели.
 */
export interface SiteNginxColumns {
  nginxClientMaxBodySize?: string | null;
  nginxFastcgiReadTimeout?: number | null;
  nginxFastcgiSendTimeout?: number | null;
  nginxFastcgiConnectTimeout?: number | null;
  nginxFastcgiBufferSizeKb?: number | null;
  nginxFastcgiBufferCount?: number | null;
  nginxHttp2?: boolean | null;
  nginxHsts?: boolean | null;
  nginxGzip?: boolean | null;
  nginxRateLimitEnabled?: boolean | null;
  nginxRateLimitRps?: number | null;
  nginxRateLimitBurst?: number | null;
}

export function siteNginxOverrides(site: SiteNginxColumns): SiteNginxOverrides {
  return {
    clientMaxBodySize: site.nginxClientMaxBodySize ?? null,
    fastcgiReadTimeout: site.nginxFastcgiReadTimeout ?? null,
    fastcgiSendTimeout: site.nginxFastcgiSendTimeout ?? null,
    fastcgiConnectTimeout: site.nginxFastcgiConnectTimeout ?? null,
    fastcgiBufferSizeKb: site.nginxFastcgiBufferSizeKb ?? null,
    fastcgiBufferCount: site.nginxFastcgiBufferCount ?? null,
    http2: site.nginxHttp2 ?? null,
    hsts: site.nginxHsts ?? null,
    gzip: site.nginxGzip ?? null,
    rateLimitEnabled: site.nginxRateLimitEnabled ?? null,
    rateLimitRps: site.nginxRateLimitRps ?? null,
    rateLimitBurst: site.nginxRateLimitBurst ?? null,
  };
}

/**
 * CMS-стартовые правила для 95-custom.conf — пишутся при первой установке сайта,
 * дальше юзер сам редактирует. Панель НИКОГДА их не перетирает после.
 */
export const CMS_INITIAL_CUSTOM_CONFIG: Record<string, string> = {
  MODX_REVO: `# MODX Revolution — friendly URLs + защита core/manager
location / {
    try_files $uri $uri/ @modx_rewrite;
}
location @modx_rewrite {
    rewrite ^/(.*)$ /index.php?q=$1 last;
}
# /core/ — наружу не отдаём ничего (^~ важнее regex-локейшнов с .php)
location ^~ /core/ {
    return 404;
}
`,
  MODX_3: `# MODX 3 — friendly URLs + защита core. Connectors открыты — manager их дёргает.
location / {
    try_files $uri $uri/ @modx_rewrite;
}
location @modx_rewrite {
    rewrite ^/(.*)$ /index.php?q=$1 last;
}
location ^~ /core/ {
    return 404;
}
`,
  WORDPRESS: `# WordPress
location / {
    try_files $uri $uri/ /index.php?$args;
}
# Запрет PHP в /uploads/ и /files/
location ~* /(?:uploads|files)/.*\\.php$ { deny all; }
location = /xmlrpc.php { deny all; }
`,
  LARAVEL: `# Laravel / Symfony
location / {
    try_files $uri $uri/ /index.php?$query_string;
}
`,
  STATIC_HTML: `# Статика — без PHP
location / {
    try_files $uri $uri/ =404;
}
`,
  CUSTOM: `# Кастомный сайт — добавь свои правила здесь.
# Пример:
#
# location / {
#     try_files $uri $uri/ =404;
# }
`,
};

/**
 * Возвращает стартовый кастом для указанного типа сайта или generic если тип неизвестен.
 */
export function initialCustomConfigFor(siteType: string): string {
  return CMS_INITIAL_CUSTOM_CONFIG[siteType] ?? CMS_INITIAL_CUSTOM_CONFIG.CUSTOM;
}
