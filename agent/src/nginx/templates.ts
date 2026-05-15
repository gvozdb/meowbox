/**
 * Layered nginx config templates — МНОГО-ДОМЕННАЯ модель.
 *
 * Один сайт (`Site`) имеет N «основных» доменов (`SiteDomain`). Каждый домен —
 * это отдельный server-блок, отдельный SSL-серт, отдельный набор layered-чанков
 * и собственный 95-custom.conf. Linux-домашка у сайта общая; домены различаются
 * только `filesRelPath` (web-root относительно общего `Site.rootPath`).
 *
 * Структура на диске:
 *
 *   /etc/nginx/sites-available/{siteName}.conf   ← главный файл (генерится панелью)
 *       содержит для КАЖДОГО домена:
 *         server { listen 80; ... return 301 https; }            (если SSL+redirect)
 *         server { listen 443 ssl http2; ...
 *             include /etc/nginx/meowbox/{siteName}/{domainId}/*.conf;
 *         }
 *         server { ... }   (alias-redirects, если есть)
 *
 *   /etc/nginx/meowbox/{siteName}/{domainId}/   ← чанки тела server-блока домена
 *       ├── 00-server.conf      root, index, charset, body size, log paths, ACME
 *       ├── 10-ssl.conf         ssl_protocols, ciphers, stapling, HSTS (если SSL)
 *       ├── 20-php.conf         location ~ \.php$ { fastcgi_pass ... } (если phpEnabled)
 *       ├── 40-static.conf      gzip, cache headers для статики
 *       ├── 50-security.conf    deny dotfiles, rate limit, security headers
 *       └── 95-custom.conf      ← редактируется юзером в UI
 *
 *   `domainId` — стабильный uuid; директория чанков НИКОГДА не переименовывается.
 *   Файлы 00–50 принадлежат панели и регенерируются при настройках/SSL/смене домена.
 *   Файл 95-custom.conf принадлежит юзеру — НИКОГДА не перезаписывается панелью
 *   после первоначальной установки (кроме явного forceWriteCustom).
 */

import { resolveNginxSettings, type SiteNginxOverrides } from '@meowbox/shared';
import { DEFAULT_PHP_VERSION } from '../config';

// =============================================================================
// Public types
// =============================================================================

/** Алиас домена: redirect=true → 301 на основной домен, иначе — server_name. */
export interface NginxDomainAlias {
  domain: string;
  redirect: boolean;
}

/** Один «основной» домен сайта — собственный server-блок + чанки. */
export interface NginxDomainParams {
  /** Стабильный uuid домена — имя директории чанков. */
  domainId: string;
  domain: string;
  aliases: NginxDomainAlias[];
  /** Web-root относительно `Site.rootPath`. Уже разрешён API, не бывает null. */
  filesRelPath: string;
  /** Если задан — добавляем reverse-proxy `location /` на 127.0.0.1:{appPort}. */
  appPort?: number | null;
  sslEnabled: boolean;
  certPath?: string | null;
  keyPath?: string | null;
  httpsRedirect: boolean;
  /** Имя rate-limit зоны для этого домена — приходит из API, НЕ вычисляем. */
  zoneName: string;
  /** Per-site overrides → resolveNginxSettings подставит дефолты для null/0. */
  settings: SiteNginxOverrides;
  /** Стартовый кастом-блок — пишется только при первой установке домена. */
  customConfig?: string | null;
  /** Если true — существующий 95-custom.conf будет перезаписан. */
  forceWriteCustom?: boolean;
}

/** Параметры рендеринга всего сайта (все домены сразу). */
export interface NginxSiteParams {
  siteName: string;
  /** Общий корень сайта; web-root домена = rootPath + '/' + filesRelPath. */
  rootPath: string;
  phpEnabled: boolean;
  phpVersion?: string;
  systemUser?: string;
  domains: NginxDomainParams[];
}

/** Отрендеренные чанки одного домена. */
export interface RenderedDomain {
  domainId: string;
  /** Управляемые чанки 00..50 — ключ = filename. */
  chunks: Record<string, string>;
  /**
   * Кастом-файл выделен отдельно — пишется ТОЛЬКО при первой установке
   * домена (если на диске нет файла) либо при forceWriteCustom=true.
   */
  customChunk?: { filename: '95-custom.conf'; content: string };
}

/**
 * Результат рендеринга всего сайта. NginxManager пишет главный файл и чанки
 * каждого домена; перед reload делает `nginx -t` с откатом.
 */
export interface RenderedNginxSite {
  /** Главный файл — `/etc/nginx/sites-available/{siteName}.conf`. */
  mainConfig: string;
  /** Отрендеренные домены в порядке payload. */
  domains: RenderedDomain[];
}

// =============================================================================
// Helpers
// =============================================================================

function splitAliases(aliases: NginxDomainAlias[] | undefined): {
  serverAliases: string[];
  redirectAliases: string[];
} {
  const serverAliases: string[] = [];
  const redirectAliases: string[] = [];
  for (const item of aliases || []) {
    if (!item || typeof item.domain !== 'string') continue;
    const d = item.domain.trim();
    if (!d) continue;
    if (item.redirect === true) redirectAliases.push(d);
    else serverAliases.push(d);
  }
  return { serverAliases, redirectAliases };
}

function resolveWebRoot(rootPath: string, filesRelPath: string): string {
  const rel = (filesRelPath || 'www').replace(/^\/+/, '').replace(/\.\.+/g, '').replace(/\/+$/, '');
  return `${rootPath}/${rel || 'www'}`;
}

function serverNames(domain: string, aliases: string[]): string {
  return [domain, ...aliases].join(' ');
}

function phpSocketPath(phpVersion: string, anchor: string): string {
  return `/var/run/php/php${phpVersion}-fpm-${anchor}.sock`;
}

/** Санитайзит домен под имя файла лога (no slashes/dots-as-path). */
function sanitizeForFilename(domain: string): string {
  return String(domain).toLowerCase().replace(/[^a-z0-9._-]/g, '_') || 'domain';
}

const MEOWBOX_INCLUDE_DIR = '/etc/nginx/meowbox';

/** Директория чанков домена: meowbox/{siteName}/{domainId}/ */
export function domainChunkDir(siteName: string, domainId: string): string {
  return `${MEOWBOX_INCLUDE_DIR}/${siteName}/${domainId}`;
}

// =============================================================================
// Chunk renderers (содержимое meowbox/{siteName}/{domainId}/*.conf)
// =============================================================================

/** 00-server.conf — root, index, charset, client_max_body_size, log paths, ACME. */
function chunk00Server(
  site: NginxSiteParams,
  d: NginxDomainParams,
  webRoot: string,
  settings: ReturnType<typeof resolveNginxSettings>,
): string {
  const phpEnabled = !!site.phpEnabled;
  const indexDirective = phpEnabled ? 'index.php index.html' : 'index.html index.htm';
  // Лог-файл включает домен → у каждого домена сайта свои логи.
  const logBase = `${site.siteName}__${sanitizeForFilename(d.domain)}`;
  return `# === 00-server.conf — базовые директивы (управляется Meowbox) ===
root ${webRoot};
index ${indexDirective};
charset utf-8;
client_max_body_size ${settings.clientMaxBodySize};

access_log /var/log/nginx/${logBase}-access.log;
error_log /var/log/nginx/${logBase}-error.log;

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

/** 20-php.conf — fastcgi для .php. Только если phpEnabled. Socket per-SITE. */
function chunk20Php(
  site: NginxSiteParams,
  settings: ReturnType<typeof resolveNginxSettings>,
): string {
  const phpVersion = site.phpVersion || DEFAULT_PHP_VERSION;
  // Socket — один на сайт (один php-fpm pool на сайт), имя по siteName.
  const sock = phpSocketPath(phpVersion, site.siteName);
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
function chunk50Security(
  d: NginxDomainParams,
  settings: ReturnType<typeof resolveNginxSettings>,
): string {
  // Per-domain rate limit. Зона объявлена в /etc/nginx/conf.d/meowbox-zones.conf;
  // имя зоны приходит из API в payload — НЕ вычисляем здесь.
  const zoneName = d.zoneName;
  const rateLimitLine = settings.rateLimitEnabled && zoneName
    ? `limit_req zone=${zoneName} burst=${settings.rateLimitBurst} nodelay;`
    : `# Rate limiting отключён в настройках сайта.`;
  return `# === 50-security.conf — security (управляется Meowbox) ===
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-XSS-Protection "1; mode=block" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

# Rate limiting (zone объявлена в /etc/nginx/conf.d/meowbox-zones.conf глобально).
${rateLimitLine}

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

function httpRedirectServer(d: NginxDomainParams, webRoot: string, serverAliases: string[]): string {
  return `# Auto-generated HTTP→HTTPS redirect (Meowbox).
server {
    listen 80;
    listen [::]:80;
    server_name ${serverNames(d.domain, serverAliases)};

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
  certPath?: string | null,
  keyPath?: string | null,
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

/** Главный server-блок одного домена. */
function mainServerBlock(
  site: NginxSiteParams,
  d: NginxDomainParams,
  serverAliases: string[],
  settings: ReturnType<typeof resolveNginxSettings>,
): string {
  const sslEnabled = !!d.sslEnabled && !!d.certPath && !!d.keyPath;
  const sslLines = sslEnabled
    ? `    ssl_certificate ${d.certPath};
    ssl_certificate_key ${d.keyPath};
`
    : '';
  // appPort proxy_pass — если задан, добавляем как кастомный location перед include.
  const proxyBlock = d.appPort
    ? `
    # Reverse proxy на приложение (порт задан в настройках сайта)
    location / {
        proxy_pass http://127.0.0.1:${d.appPort};
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
    server_name ${serverNames(d.domain, serverAliases)};
${sslLines}${proxyBlock}
    # Подключаем все управляемые чанки + 95-custom.conf — сортировка по имени файла.
    include ${domainChunkDir(site.siteName, d.domainId)}/*.conf;
}
`;
}

// =============================================================================
// Public API
// =============================================================================

/** Рендерит чанки одного домена. */
function renderDomainChunks(
  site: NginxSiteParams,
  d: NginxDomainParams,
  settings: ReturnType<typeof resolveNginxSettings>,
): RenderedDomain {
  const webRoot = resolveWebRoot(site.rootPath, d.filesRelPath);
  const sslEnabled = !!d.sslEnabled && !!d.certPath && !!d.keyPath;

  const chunks: Record<string, string> = {
    '00-server.conf': chunk00Server(site, d, webRoot, settings),
  };
  if (sslEnabled) chunks['10-ssl.conf'] = chunk10Ssl(settings);
  // appPort proxy_pass и php могут сосуществовать — php матчится регекспом раньше.
  if (site.phpEnabled) chunks['20-php.conf'] = chunk20Php(site, settings);
  chunks['40-static.conf'] = chunk40Static(settings);
  chunks['50-security.conf'] = chunk50Security(d, settings);

  const rendered: RenderedDomain = { domainId: d.domainId, chunks };
  if (typeof d.customConfig === 'string') {
    rendered.customChunk = { filename: '95-custom.conf', content: d.customConfig };
  }
  return rendered;
}

/**
 * Рендерит полный конфиг сайта со ВСЕМИ доменами: главный файл + чанки каждого
 * домена. `customChunk` возвращается в каждом домене только если в payload
 * передан `customConfig` (NginxManager сам решит, писать ли его на диск —
 * только при первой установке или forceWriteCustom).
 */
export function renderNginxSite(site: NginxSiteParams): RenderedNginxSite {
  const domains: RenderedDomain[] = [];
  const serverBlocks: string[] = [];

  for (const d of site.domains) {
    const settings = resolveNginxSettings(d.settings || {});
    const { serverAliases, redirectAliases } = splitAliases(d.aliases);
    const webRoot = resolveWebRoot(site.rootPath, d.filesRelPath);
    const sslEnabled = !!d.sslEnabled && !!d.certPath && !!d.keyPath;
    const doHttpRedirect = sslEnabled && d.httpsRedirect !== false;

    domains.push(renderDomainChunks(site, d, settings));

    const blocks: string[] = [`# --- Домен: ${d.domain} (${d.domainId}) ---`];
    if (doHttpRedirect) blocks.push(httpRedirectServer(d, webRoot, serverAliases));
    blocks.push(mainServerBlock(site, d, serverAliases, settings));
    const aliasBlock = aliasRedirectServer(redirectAliases, d.domain, sslEnabled, d.certPath, d.keyPath);
    if (aliasBlock) blocks.push(aliasBlock);
    serverBlocks.push(blocks.join('\n'));
  }

  const domainList = site.domains.map((d) => d.domain).join(', ') || '(нет доменов)';
  const mainConfig = `# Сгенерировано Meowbox для сайта ${site.siteName}.
# Домены: ${domainList}
# НЕ редактировать вручную: файл перезаписывается при изменении настроек сайта.
# Кастомные правила пиши в /etc/nginx/meowbox/${site.siteName}/{domainId}/95-custom.conf
# (вкладка «Nginx» на странице сайта в панели).

${serverBlocks.join('\n')}`;

  return { mainConfig, domains };
}

export const NGINX_LAYERED_INCLUDE_DIR = MEOWBOX_INCLUDE_DIR;
export { MEOWBOX_INCLUDE_DIR };
