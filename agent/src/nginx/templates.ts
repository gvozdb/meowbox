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
 *         server { listen 80; ... include non-SSL chunks; }      (если SSL без redirect)
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

import { resolveNginxSettings, siteDomainLogBase, type SiteNginxOverrides } from '@meowbox/shared';
import { ACME_WEBROOT, DEFAULT_PHP_VERSION } from '../config';
import {
  buildPhpSocketPath,
  resolveDomainPhpRuntime,
  validateSiteDomainId,
  validateRuntimeKey,
  type ResolvedDomainPhpRuntime,
} from '../runtime/site-domain-runtime';
import { sanitizeCustomNginxConfig } from './sanitize-custom';

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
  /** Application preset owned by this domain. */
  preset: string;
  /** Per-domain PHP version. `null` explicitly disables managed PHP. */
  phpVersion: string | null;
  /** Immutable per-domain pool/socket/log identity. */
  runtimeKey: string;
  /** Optional server-derived socket; it must match phpVersion/runtimeKey. */
  socketPath?: string | null;
  /** Transitional alias for socketPath. */
  socket?: string | null;
  /** Explicit primary marker used by config consumers and diagnostics. */
  isPrimary: boolean;
  /** Если задан — добавляем reverse-proxy `location /` на 127.0.0.1:{appPort}. */
  appPort?: number | null;
  sslEnabled: boolean;
  certPath?: string | null;
  keyPath?: string | null;
  trustedCertPath?: string | null;
  ocspStapling?: boolean | null;
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

function serverNames(domain: string, aliases: string[]): string {
  return [domain, ...aliases].join(' ');
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
  runtime: ResolvedDomainPhpRuntime,
): string {
  const indexDirective = runtime.phpEnabled ? 'index.php index.html' : 'index.html index.htm';
  // Лог-файл включает домен → у каждого домена сайта свои логи.
  const logBase = siteDomainLogBase({ siteName: site.siteName, domain: d.domain });
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
    root ${ACME_WEBROOT};
    default_type "text/plain";
    allow all;
    try_files $uri =404;
}
`;
}

/** 10-ssl.conf — SSL ciphers, OCSP stapling, HSTS. Listen в main файле. */
function chunk10Ssl(
  d: NginxDomainParams,
  settings: ReturnType<typeof resolveNginxSettings>,
): string {
  const stapling = d.ocspStapling === true
    ? `ssl_stapling on;
ssl_stapling_verify on;
resolver 1.1.1.1 8.8.8.8 valid=300s;
resolver_timeout 5s;`
    : `# OCSP stapling отключён: у сертификата нет OCSP URI или нет trusted chain.`;
  return `# === 10-ssl.conf — SSL параметры (управляется Meowbox) ===
ssl_protocols TLSv1.2 TLSv1.3;
ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
ssl_prefer_server_ciphers on;
ssl_session_cache shared:SSL:10m;
ssl_session_timeout 1d;
ssl_session_tickets off;
${stapling}
${settings.hsts ? 'add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;\n' : ''}`;
}

/** 20-php.conf — fastcgi для .php. Только если у домена включён PHP. */
function chunk20Php(
  runtime: ResolvedDomainPhpRuntime,
  settings: ReturnType<typeof resolveNginxSettings>,
): string {
  const phpVersion = runtime.phpVersion || DEFAULT_PHP_VERSION;
  const sock = runtime.socketPath || buildPhpSocketPath(phpVersion, runtime.runtimeKey);
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

function httpRedirectServer(d: NginxDomainParams, serverAliases: string[]): string {
  return `# Auto-generated HTTP→HTTPS redirect (Meowbox).
server {
    listen 80;
    listen [::]:80;
    server_name ${serverNames(d.domain, serverAliases)};

    location ^~ /.well-known/acme-challenge/ {
        root ${ACME_WEBROOT};
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
  http2: boolean,
  certPath?: string | null,
  keyPath?: string | null,
  trustedCertPath?: string | null,
): string {
  if (!redirectAliases.length) return '';
  const names = redirectAliases.join(' ');
  const scheme = sslEnabled ? 'https' : 'http';
  const h2 = http2 ? ' http2' : '';
  const ssl443 =
    sslEnabled && certPath && keyPath
      ? `
server {
    listen 443 ssl${h2};
    listen [::]:443 ssl${h2};
    server_name ${names};
    ssl_certificate ${certPath};
    ssl_certificate_key ${keyPath};
${trustedCertPath ? `    ssl_trusted_certificate ${trustedCertPath};\n` : ''}
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

    location ^~ /.well-known/acme-challenge/ {
        root ${ACME_WEBROOT};
        default_type "text/plain";
        allow all;
        try_files $uri =404;
    }

    location / {
        return 301 ${scheme}://${mainDomain}$request_uri;
    }
}
${ssl443}`;
}

function domainChunkIncludes(
  site: NginxSiteParams,
  d: NginxDomainParams,
  includeSslChunk: boolean,
): string {
  const dir = domainChunkDir(site.siteName, d.domainId);
  if (includeSslChunk) {
    return `    include ${dir}/*.conf;`;
  }
  // HTTP и HTTPS делят все server-level настройки, кроме 10-ssl.conf.
  // Маски не падают, если optional chunk (например 20-php.conf) отсутствует.
  return `    include ${dir}/0[0-9]-*.conf;
    include ${dir}/[2-9][0-9]-*.conf;`;
}

/** Контентный server-блок одного домена для HTTP либо HTTPS. */
function contentServerBlock(
  site: NginxSiteParams,
  d: NginxDomainParams,
  serverAliases: string[],
  settings: ReturnType<typeof resolveNginxSettings>,
  useSsl: boolean,
): string {
  const sslLines = useSsl
    ? `    ssl_certificate ${d.certPath};
    ssl_certificate_key ${d.keyPath};
${d.trustedCertPath ? `    ssl_trusted_certificate ${d.trustedCertPath};\n` : ''}
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
${listenDirective(useSsl, settings.http2)}
    server_name ${serverNames(d.domain, serverAliases)};
${sslLines}${proxyBlock}
    # Подключаем управляемые чанки + 95-custom.conf.
${domainChunkIncludes(site, d, useSsl)}
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
  runtime: ResolvedDomainPhpRuntime,
): RenderedDomain {
  const webRoot = runtime.webRoot;
  const sslEnabled = !!d.sslEnabled && !!d.certPath && !!d.keyPath;

  const chunks: Record<string, string> = {
    '00-server.conf': chunk00Server(site, d, webRoot, settings, runtime),
  };
  if (sslEnabled) chunks['10-ssl.conf'] = chunk10Ssl(d, settings);
  // appPort proxy_pass и php могут сосуществовать — php матчится регекспом раньше.
  if (runtime.phpEnabled) chunks['20-php.conf'] = chunk20Php(runtime, settings);
  chunks['40-static.conf'] = chunk40Static(settings);
  chunks['50-security.conf'] = chunk50Security(d, settings);

  const rendered: RenderedDomain = { domainId: d.domainId, chunks };
  if (typeof d.customConfig === 'string') {
    // Срезаем директивы, которые ломают `nginx -t` в server-контексте
    // (чужие limit_*/cache-зоны из hostpanel-миграции и т.п.).
    rendered.customChunk = {
      filename: '95-custom.conf',
      content: sanitizeCustomNginxConfig(d.customConfig),
    };
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
  const seenRuntimeKeys = new Map<string, string>();
  const seenSockets = new Map<string, string>();

  for (const d of site.domains) {
    validateSiteDomainId(d.domainId);
    const settings = resolveNginxSettings(d.settings || {});
    const { serverAliases, redirectAliases } = splitAliases(d.aliases);
    const runtimeKey = validateRuntimeKey(d.runtimeKey);
    const runtime = resolveDomainPhpRuntime({
      siteRoot: site.rootPath,
      filesRelPath: d.filesRelPath,
      phpVersion: d.phpVersion,
      runtimeKey,
      socketPath: d.socketPath ?? d.socket,
    });
    const previousDomain = seenRuntimeKeys.get(runtime.runtimeKey);
    if (previousDomain) {
      throw new Error(
        `runtimeKey collision before nginx writes: ${runtime.runtimeKey} is used by ${previousDomain} and ${d.domainId}`,
      );
    }
    seenRuntimeKeys.set(runtime.runtimeKey, d.domainId);
    if (runtime.socketPath) {
      const previousSocketDomain = seenSockets.get(runtime.socketPath);
      if (previousSocketDomain) {
        throw new Error(
          `PHP-FPM socket collision before nginx writes: ${runtime.socketPath} is used by ${previousSocketDomain} and ${d.domainId}`,
        );
      }
      seenSockets.set(runtime.socketPath, d.domainId);
    }
    const sslEnabled = !!d.sslEnabled && !!d.certPath && !!d.keyPath;
    const doHttpRedirect = sslEnabled && d.httpsRedirect !== false;

    domains.push(renderDomainChunks(site, d, settings, runtime));

    const blocks: string[] = [`# --- Домен: ${d.domain} (${d.domainId}) ---`];
    if (sslEnabled) {
      if (doHttpRedirect) {
        blocks.push(httpRedirectServer(d, serverAliases));
      } else {
        blocks.push(contentServerBlock(site, d, serverAliases, settings, false));
      }
      blocks.push(contentServerBlock(site, d, serverAliases, settings, true));
    } else {
      blocks.push(contentServerBlock(site, d, serverAliases, settings, false));
    }
    const aliasBlock = aliasRedirectServer(
      redirectAliases,
      d.domain,
      sslEnabled,
      settings.http2,
      d.certPath,
      d.keyPath,
      d.trustedCertPath,
    );
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
