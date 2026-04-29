/**
 * Layered nginx config templates.
 *
 * Структура на диске:
 *
 *   /etc/nginx/sites-available/{siteName}.conf   ← главный файл (генерится панелью)
 *       содержит:
 *         server { listen 80; ... return 301 https; }                  (если SSL on)
 *         server { listen 443 ssl http2; ...
 *             include /etc/nginx/meowbox/{siteName}/*.conf;            (тело)
 *         }
 *         server { ... }   (alias-redirects, если есть)
 *
 *   /etc/nginx/meowbox/{siteName}/   ← фрагменты тела основного server-блока
 *       ├── 00-server.conf      root, index, charset, body size, log paths, ACME
 *       ├── 10-ssl.conf         ssl_protocols, ciphers, stapling, HSTS (если SSL on)
 *       ├── 20-php.conf         location ~ \.php$ { fastcgi_pass ... }   (если phpEnabled)
 *       ├── 40-static.conf      gzip, cache headers для статики
 *       ├── 50-security.conf    deny dotfiles, rate limit, security headers
 *       └── 95-custom.conf      ← редактируется юзером в UI
 *
 *   Главный файл инклюдит meowbox/{siteName}/*.conf — nginx сам отсортирует по имени.
 *   Файлы 00–90 принадлежат панели и регенерируются при настройках/SSL/смене домена.
 *   Файл 95-custom.conf принадлежит юзеру — НИКОГДА не перезаписывается панелью
 *   после первоначальной установки CMS.
 */

import { resolveNginxSettings, type SiteNginxOverrides } from '@meowbox/shared';
import { DEFAULT_PHP_VERSION } from '../config';

// =============================================================================
// Public types
// =============================================================================

export type NginxAliasInput = string | { domain: string; redirect?: boolean };

export interface NginxLayeredParams {
  siteName: string;
  domain: string;
  aliases: NginxAliasInput[];
  rootPath: string;
  filesRelPath?: string;
  phpVersion?: string;
  phpEnabled?: boolean;
  appPort?: number;
  sslEnabled?: boolean;
  httpsRedirect?: boolean;
  certPath?: string;
  keyPath?: string;
  /** Per-site overrides → resolveNginxSettings подставит дефолты для null/0. */
  settings?: SiteNginxOverrides;
}

/**
 * Результат рендеринга — карта `имя_файла → содержимое`. NginxManager пишет
 * каждый файл в нужное место; перед reload делает `nginx -t`.
 */
export interface RenderedNginxBundle {
  /** Главный файл — `/etc/nginx/sites-available/{siteName}.conf`. */
  mainConfig: string;
  /** Чанки внутри meowbox/{siteName}/ — ключ = filename типа `00-server.conf`. */
  chunks: Record<string, string>;
  /**
   * Кастом-файл выделен отдельно — пишется ТОЛЬКО при первой установке
   * сайта (если на диске нет файла или БД-значение отличается). При
   * регенерации после смены настроек существующий 95-custom.conf не трогается.
   */
  customChunk?: { filename: '95-custom.conf'; content: string };
}

// =============================================================================
// Helpers
// =============================================================================

function splitAliases(aliases: NginxAliasInput[] | undefined): {
  serverAliases: string[];
  redirectAliases: string[];
} {
  const serverAliases: string[] = [];
  const redirectAliases: string[] = [];
  for (const item of aliases || []) {
    if (typeof item === 'string') {
      const d = item.trim();
      if (d) serverAliases.push(d);
    } else if (item && typeof item === 'object' && typeof item.domain === 'string') {
      const d = item.domain.trim();
      if (!d) continue;
      if (item.redirect === true) redirectAliases.push(d);
      else serverAliases.push(d);
    }
  }
  return { serverAliases, redirectAliases };
}

function resolveWebRoot(rootPath: string, filesRelPath?: string): string {
  const rel = (filesRelPath || 'www').replace(/^\/+/, '').replace(/\.\.+/g, '').replace(/\/+$/, '');
  return `${rootPath}/${rel || 'www'}`;
}

function serverNames(domain: string, aliases: string[]): string {
  return [domain, ...aliases].join(' ');
}

function phpSocketPath(phpVersion: string, anchor: string): string {
  return `/var/run/php/php${phpVersion}-fpm-${anchor}.sock`;
}

const MEOWBOX_INCLUDE_DIR = '/etc/nginx/meowbox';

// =============================================================================
// Chunk renderers (содержимое meowbox/{siteName}/*.conf)
// =============================================================================

/** 00-server.conf — root, index, charset, client_max_body_size, log paths, ACME. */
function chunk00Server(p: NginxLayeredParams, webRoot: string, settings: ReturnType<typeof resolveNginxSettings>): string {
  const phpEnabled = !!p.phpEnabled && !!p.phpVersion;
  const indexDirective = phpEnabled ? 'index.php index.html' : 'index.html index.htm';
  return `# === 00-server.conf — базовые директивы (управляется Meowbox) ===
root ${webRoot};
index ${indexDirective};
charset utf-8;
client_max_body_size ${settings.clientMaxBodySize};

access_log /var/log/nginx/${p.siteName}-access.log;
error_log /var/log/nginx/${p.siteName}-error.log;

# ACME HTTP-01 (Let's Encrypt). Должно быть ВЫШЕ deny /\\. (regex, который
# в 50-security.conf), чтобы валидация LE не упёрлась в deny.
location ^~ /.well-known/acme-challenge/ {
    default_type "text/plain";
    allow all;
    try_files $uri =404;
}
`;
}

/** 10-ssl.conf — SSL ciphers, stapling, HSTS (если включено). Listen в main файле. */
function chunk10Ssl(settings: ReturnType<typeof resolveNginxSettings>): string {
  return `# === 10-ssl.conf — SSL параметры (управляется Meowbox) ===
ssl_protocols TLSv1.2 TLSv1.3;
ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
ssl_prefer_server_ciphers on;
ssl_session_cache shared:SSL:10m;
ssl_session_timeout 1d;
ssl_session_tickets off;
ssl_stapling on;
ssl_stapling_verify on;
${settings.hsts ? 'add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;\n' : ''}`;
}

/** 20-php.conf — fastcgi для .php. Только если phpEnabled. */
function chunk20Php(p: NginxLayeredParams, settings: ReturnType<typeof resolveNginxSettings>): string {
  const phpVersion = p.phpVersion || DEFAULT_PHP_VERSION;
  const sock = phpSocketPath(phpVersion, p.siteName);
  // Размер каждого fastcgi_buffer = bufferSize / 2 (классическая формула, но не меньше 4k).
  const bufSizeKb = settings.fastcgiBufferSizeKb;
  const subBufKb = Math.max(4, Math.floor(bufSizeKb / 2));
  return `# === 20-php.conf — PHP-FPM handler (управляется Meowbox) ===
location ~ \\.php$ {
    try_files $uri =404;
    fastcgi_split_path_info ^(.+\\.php)(/.+)$;
    fastcgi_pass unix:${sock};
    fastcgi_index index.php;
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    fastcgi_param PATH_INFO $fastcgi_path_info;

    fastcgi_read_timeout ${settings.fastcgiReadTimeout}s;
    fastcgi_send_timeout ${settings.fastcgiSendTimeout}s;
    fastcgi_connect_timeout ${settings.fastcgiConnectTimeout}s;

    fastcgi_buffer_size ${bufSizeKb}k;
    fastcgi_buffers ${settings.fastcgiBufferCount} ${subBufKb}k;
    fastcgi_busy_buffers_size ${bufSizeKb}k;
}
`;
}

/** 40-static.conf — gzip + кэш статики. */
function chunk40Static(settings: ReturnType<typeof resolveNginxSettings>): string {
  return `# === 40-static.conf — gzip + cache (управляется Meowbox) ===
${settings.gzip ? `gzip on;
gzip_vary on;
gzip_proxied any;
gzip_comp_level 4;
gzip_min_length 256;
gzip_types text/plain text/css application/json application/javascript text/xml application/xml text/javascript image/svg+xml;
` : '# gzip отключён в настройках сайта\n'}
location ~* \\.(?:js|css|png|jpg|jpeg|gif|ico|svg|webp|avif|woff|woff2|ttf|eot|otf)$ {
    expires 30d;
    add_header Cache-Control "public, immutable";
    access_log off;
}
`;
}

/** 50-security.conf — deny dotfiles + security headers + rate limit. */
function chunk50Security(): string {
  return `# === 50-security.conf — security (управляется Meowbox) ===
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-XSS-Protection "1; mode=block" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

# Rate limiting (zone определена в /etc/nginx/nginx.conf глобально).
limit_req zone=site_limit burst=60 nodelay;

# Deny hidden files (.git, .env, .htaccess) и опасные расширения.
location ~ /\\. { deny all; }
location ~ \\.(htaccess|htpasswd|ini|log|sh|sql|env)$ { deny all; }
`;
}

// =============================================================================
// Main file (server-блоки) — /etc/nginx/sites-available/{siteName}.conf
// =============================================================================

function listenDirective(sslEnabled: boolean, http2: boolean): string {
  if (sslEnabled) {
    const h2 = http2 ? ' http2' : '';
    return `    listen 443 ssl${h2};
    listen [::]:443 ssl${h2};`;
  }
  return `    listen 80;
    listen [::]:80;`;
}

function httpRedirectServer(p: NginxLayeredParams, webRoot: string, serverAliases: string[]): string {
  return `# Auto-generated HTTP→HTTPS redirect (Meowbox).
server {
    listen 80;
    listen [::]:80;
    server_name ${serverNames(p.domain, serverAliases)};

    location ^~ /.well-known/acme-challenge/ {
        root ${webRoot};
        default_type "text/plain";
        allow all;
        try_files $uri =404;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}
`;
}

function aliasRedirectServer(
  redirectAliases: string[],
  mainDomain: string,
  sslEnabled: boolean,
  certPath?: string,
  keyPath?: string,
): string {
  if (!redirectAliases.length) return '';
  const names = redirectAliases.join(' ');
  const scheme = sslEnabled ? 'https' : 'http';
  const ssl443 =
    sslEnabled && certPath && keyPath
      ? `
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name ${names};
    ssl_certificate ${certPath};
    ssl_certificate_key ${keyPath};
    ssl_protocols TLSv1.2 TLSv1.3;
    return 301 ${scheme}://${mainDomain}$request_uri;
}
`
      : '';
  return `
# Auto-generated alias redirect → ${mainDomain} (Meowbox).
server {
    listen 80;
    listen [::]:80;
    server_name ${names};
    return 301 ${scheme}://${mainDomain}$request_uri;
}
${ssl443}`;
}

function mainServerBlock(p: NginxLayeredParams, serverAliases: string[]): string {
  const sslEnabled = !!p.sslEnabled && !!p.certPath && !!p.keyPath;
  const settings = resolveNginxSettings(p.settings || {});
  const sslLines = sslEnabled
    ? `    ssl_certificate ${p.certPath};
    ssl_certificate_key ${p.keyPath};
`
    : '';
  // appPort proxy_pass — если задан, добавляем как кастомный location перед include
  const proxyBlock = p.appPort
    ? `
    # Reverse proxy на приложение (порт задан в настройках сайта)
    location / {
        proxy_pass http://127.0.0.1:${p.appPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout ${settings.fastcgiReadTimeout}s;
    }
`
    : '';
  return `server {
${listenDirective(sslEnabled, settings.http2)}
    server_name ${serverNames(p.domain, serverAliases)};
${sslLines}${proxyBlock}
    # Подключаем все управляемые чанки + 95-custom.conf — сортировка по имени файла.
    include ${MEOWBOX_INCLUDE_DIR}/${p.siteName}/*.conf;
}
`;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Рендерит полный набор файлов для сайта. Главный файл всегда есть; чанки
 * заполнены по настройкам/SSL; customChunk возвращается только если в БД
 * нет существующего значения и нужно проинициализировать стартовым CMS-шаблоном
 * (NginxManager сам решит, писать ли его на диск).
 */
export function renderNginxBundle(p: NginxLayeredParams): RenderedNginxBundle {
  const { serverAliases, redirectAliases } = splitAliases(p.aliases);
  const webRoot = resolveWebRoot(p.rootPath, p.filesRelPath);
  const settings = resolveNginxSettings(p.settings || {});
  const sslEnabled = !!p.sslEnabled && !!p.certPath && !!p.keyPath;
  const doHttpRedirect = sslEnabled && p.httpsRedirect !== false;

  const chunks: Record<string, string> = {
    '00-server.conf': chunk00Server(p, webRoot, settings),
  };
  if (sslEnabled) chunks['10-ssl.conf'] = chunk10Ssl(settings);
  // appPort proxy_pass убирает необходимость в php-локации — но если оба, php имеет приоритет
  // (проксируется только корень, php-файлы матчатся раньше регекспом).
  if (!!p.phpEnabled && !!p.phpVersion) chunks['20-php.conf'] = chunk20Php(p, settings);
  chunks['40-static.conf'] = chunk40Static(settings);
  chunks['50-security.conf'] = chunk50Security();

  const serverBlocks: string[] = [];
  if (doHttpRedirect) serverBlocks.push(httpRedirectServer(p, webRoot, serverAliases));
  serverBlocks.push(mainServerBlock(p, serverAliases));
  const aliasBlock = aliasRedirectServer(redirectAliases, p.domain, sslEnabled, p.certPath, p.keyPath);
  if (aliasBlock) serverBlocks.push(aliasBlock);

  const mainConfig = `# Сгенерировано Meowbox для сайта ${p.siteName} (${p.domain}).
# НЕ редактировать вручную: файл перезаписывается при изменении настроек сайта.
# Кастомные правила пиши в /etc/nginx/meowbox/${p.siteName}/95-custom.conf
# (вкладка «Nginx» на странице сайта в панели).

${serverBlocks.join('\n')}`;

  return { mainConfig, chunks };
}

/**
 * Backward-compat обёртка: старый API `generateNginxConfig(siteType, params)`
 * возвращал одну строку. Кое-где в кодовой базе он ещё может вызываться
 * (legacy), поэтому даём упрощённую совместимость — возвращает mainConfig.
 *
 * Лучше — везде переходить на `renderNginxBundle()`.
 */
export function generateNginxConfig(_siteType: string, params: NginxLayeredParams): string {
  return renderNginxBundle(params).mainConfig;
}

export const NGINX_LAYERED_INCLUDE_DIR = MEOWBOX_INCLUDE_DIR;

// Re-exports (legacy)
export { MEOWBOX_INCLUDE_DIR };
