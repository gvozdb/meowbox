/**
 * Управление доступом к панели на стороне агента:
 *   - DNS-резолв + публичный IP сервера (для проверки соответствия)
 *   - Выпуск/удаление Let's Encrypt cert (certbot --webroot)
 *   - Генерация self-signed cert (openssl req -x509)
 *   - Рендер /etc/nginx/sites-available/meowbox-panel под текущие настройки
 *
 * ВАЖНО: каждый рендер делает `nginx -t` ПЕРЕД reload. Если конфиг не валиден —
 * откатываем файл из бэкапа `.bak` и возвращаем error. Текущая работающая
 * конфигурация при этом не страдает (паника-safe).
 */

import * as dns from 'dns/promises';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createConnection } from 'net';
import { CommandExecutor } from '../command-executor';
import { LETSENCRYPT_LIVE_DIR } from '../config';

const PANEL_NGINX_PATH = '/etc/nginx/sites-available/meowbox-panel';
const PANEL_NGINX_ENABLED = '/etc/nginx/sites-enabled/meowbox-panel';
const PANEL_NGINX_BAK = '/etc/nginx/sites-available/meowbox-panel.bak';
const ACME_WEBROOT = '/var/www/meowbox-acme';
const SELFSIGNED_DIR = '/etc/ssl/meowbox/panel';

interface RenderSettings {
  domain: string | null;
  certMode: 'NONE' | 'SELFSIGNED' | 'LE';
  certPath: string | null;
  keyPath: string | null;
  httpsRedirect: boolean;
  denyIpAccess: boolean;
}

export class PanelAccessManager {
  private executor: CommandExecutor;

  constructor() {
    this.executor = new CommandExecutor();
  }

  // ---------------------------------------------------------------------------
  // Status: cert на диске + DNS + IP
  // ---------------------------------------------------------------------------

  async getStatus(params: {
    domain?: string | null;
    certPath?: string | null;
  }): Promise<{
    success: boolean;
    certOnDisk: boolean;
    certExpiresAt: string | null;
    dnsResolved: string | null;
    serverIp: string | null;
    dnsMatchesServer: boolean | null;
    error?: string;
  }> {
    const out = {
      success: true,
      certOnDisk: false,
      certExpiresAt: null as string | null,
      dnsResolved: null as string | null,
      serverIp: null as string | null,
      dnsMatchesServer: null as boolean | null,
    };

    if (params.certPath) {
      try {
        await fs.access(params.certPath);
        out.certOnDisk = true;
        out.certExpiresAt = await this.readCertExpiry(params.certPath);
      } catch {
        out.certOnDisk = false;
      }
    }

    out.serverIp = await this.detectPublicIp();

    if (params.domain) {
      try {
        const addrs = await dns.resolve4(params.domain);
        out.dnsResolved = addrs[0] || null;
        if (out.dnsResolved && out.serverIp) {
          out.dnsMatchesServer = out.dnsResolved === out.serverIp;
        }
      } catch {
        out.dnsResolved = null;
        out.dnsMatchesServer = false;
      }
    }

    return out;
  }

  // ---------------------------------------------------------------------------
  // Issue Let's Encrypt cert (webroot mode, ACME via :80)
  // ---------------------------------------------------------------------------

  async issueLeCert(params: { domain: string; email: string }): Promise<{
    success: boolean;
    certPath?: string;
    keyPath?: string;
    expiresAt?: string;
    error?: string;
  }> {
    if (!/^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(params.domain)) {
      return { success: false, error: 'Invalid domain' };
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(params.email)) {
      return { success: false, error: 'Invalid email' };
    }

    // 1) webroot должен существовать и быть доступным nginx'у.
    try {
      await fs.mkdir(ACME_WEBROOT, { recursive: true, mode: 0o755 });
    } catch (e) {
      return { success: false, error: `Не удалось создать ACME webroot: ${(e as Error).message}` };
    }

    // 2) Перед запуском certbot убеждаемся, что nginx сейчас отдаёт ACME-challenge
    //    с :80 для нашего домена. Если конфиг ещё не подключён — certbot упадёт
    //    с unauthorized. Поэтому API ДОЛЖЕН вызвать render-nginx раньше с
    //    valid http server. (см. PanelAccessService.issueLeCert)

    // 3) Запускаем certbot.
    const args = [
      'certonly',
      '--webroot',
      '--webroot-path', ACME_WEBROOT,
      '--non-interactive',
      '--agree-tos',
      '--email', params.email,
      '--cert-name', params.domain,
      '--expand',
      '-d', params.domain,
    ];

    const r = await this.executor.execute('certbot', args, {
      timeout: 180_000,
      allowFailure: true,
    });

    if (r.exitCode !== 0) {
      const raw = `${r.stdout}\n${r.stderr}`.trim();
      return {
        success: false,
        error: this.parseCertbotError(raw) || raw.substring(0, 600) || `certbot exit ${r.exitCode}`,
      };
    }

    const certPath = `${LETSENCRYPT_LIVE_DIR}/${params.domain}/fullchain.pem`;
    const keyPath = `${LETSENCRYPT_LIVE_DIR}/${params.domain}/privkey.pem`;
    const expiresAt = await this.readCertExpiry(certPath);

    return {
      success: true,
      certPath,
      keyPath,
      expiresAt: expiresAt || undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Generate self-signed cert (для IP-доступа)
  // ---------------------------------------------------------------------------

  async generateSelfSigned(): Promise<{
    success: boolean;
    certPath?: string;
    keyPath?: string;
    expiresAt?: string;
    error?: string;
  }> {
    try {
      await fs.mkdir(SELFSIGNED_DIR, { recursive: true, mode: 0o700 });
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }

    const certPath = path.join(SELFSIGNED_DIR, 'fullchain.pem');
    const keyPath = path.join(SELFSIGNED_DIR, 'privkey.pem');

    const ip = await this.detectPublicIp();
    const cn = ip || 'meowbox-panel';

    // OpenSSL config с SAN: IP=<ip>, DNS=meowbox-panel (cosmetic).
    // Без SAN современные браузеры (Chrome 58+) cert не принимают.
    const opensslConf = path.join(os.tmpdir(), `mb-panel-${Date.now()}.cnf`);
    const confBody =
      `[req]\n` +
      `distinguished_name = req_distinguished_name\n` +
      `x509_extensions = v3_req\n` +
      `prompt = no\n` +
      `\n` +
      `[req_distinguished_name]\n` +
      `CN = ${cn}\n` +
      `O = Meowbox\n` +
      `\n` +
      `[v3_req]\n` +
      `subjectAltName = @alt_names\n` +
      `\n` +
      `[alt_names]\n` +
      (ip ? `IP.1 = ${ip}\nDNS.1 = meowbox-panel\n` : `DNS.1 = meowbox-panel\nDNS.2 = localhost\n`);
    try {
      await fs.writeFile(opensslConf, confBody, 'utf-8');
      const r = await this.executor.execute(
        'openssl',
        [
          'req', '-x509', '-nodes', '-newkey', 'rsa:2048',
          '-keyout', keyPath,
          '-out', certPath,
          '-days', '3650',
          '-config', opensslConf,
          '-extensions', 'v3_req',
        ],
        { timeout: 60_000, allowFailure: true },
      );
      await fs.unlink(opensslConf).catch(() => {});
      if (r.exitCode !== 0) {
        return { success: false, error: r.stderr || `openssl exit ${r.exitCode}` };
      }
      await this.executor.execute('chmod', ['600', keyPath]).catch(() => {});
      await this.executor.execute('chmod', ['644', certPath]).catch(() => {});

      const expiresAt = await this.readCertExpiry(certPath);
      return { success: true, certPath, keyPath, expiresAt: expiresAt || undefined };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  // ---------------------------------------------------------------------------
  // Remove cert (LE — через certbot revoke; self-signed — просто rm)
  // ---------------------------------------------------------------------------

  async removeCert(params: {
    domain?: string | null;
    certPath?: string | null;
    keyPath?: string | null;
    mode?: 'NONE' | 'SELFSIGNED' | 'LE';
  }): Promise<{ success: boolean; error?: string }> {
    try {
      if (params.mode === 'LE' && params.domain) {
        // Best-effort revoke (мигрированные/уже-отозванные серты возвращают error,
        // это нормально — главное снести файлы).
        const certPath = params.certPath || `${LETSENCRYPT_LIVE_DIR}/${params.domain}/fullchain.pem`;
        try {
          const exists = await fs.access(certPath).then(() => true).catch(() => false);
          if (exists) {
            await this.executor.execute(
              'certbot',
              ['revoke', '--cert-path', certPath, '--non-interactive', '--delete-after-revoke'],
              { timeout: 60_000, allowFailure: true },
            );
          }
        } catch { /* ignore */ }
        // Force cleanup на случай, если revoke не удалил.
        await fs.rm(`${LETSENCRYPT_LIVE_DIR}/${params.domain}`, { recursive: true, force: true }).catch(() => {});
        await fs.rm(`/etc/letsencrypt/archive/${params.domain}`, { recursive: true, force: true }).catch(() => {});
        await fs.rm(`/etc/letsencrypt/renewal/${params.domain}.conf`, { force: true }).catch(() => {});
      } else if (params.mode === 'SELFSIGNED') {
        await fs.rm(SELFSIGNED_DIR, { recursive: true, force: true }).catch(() => {});
      } else if (params.certPath || params.keyPath) {
        if (params.certPath) await fs.rm(params.certPath, { force: true }).catch(() => {});
        if (params.keyPath) await fs.rm(params.keyPath, { force: true }).catch(() => {});
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  // ---------------------------------------------------------------------------
  // Render: пишем /etc/nginx/sites-available/meowbox-panel и делаем nginx -t + reload
  // ---------------------------------------------------------------------------

  async renderNginx(s: RenderSettings): Promise<{ success: boolean; error?: string }> {
    // Sanity: для LE/SELFSIGNED оба файла должны существовать.
    if (s.certMode !== 'NONE') {
      if (!s.certPath || !s.keyPath) {
        return { success: false, error: `certMode=${s.certMode} но не задан certPath/keyPath` };
      }
      try {
        await fs.access(s.certPath);
        await fs.access(s.keyPath);
      } catch {
        return { success: false, error: `cert/key файлы не найдены на диске: ${s.certPath}` };
      }
    }
    if (s.httpsRedirect && s.certMode === 'NONE') {
      return { success: false, error: 'httpsRedirect требует certMode != NONE' };
    }
    if (s.denyIpAccess && (s.certMode === 'NONE' || !s.domain)) {
      return { success: false, error: 'denyIpAccess требует domain + cert' };
    }

    // Читаем runtime-конфиг из state/.env. Делаем это лениво: если файла нет —
    // берём fallback из process.env / install-default.
    const env = await this.readPanelEnv();
    const config = this.buildPanelNginxConf(s, env);

    // Бэкап текущего файла на случай отката.
    let hadBackup = false;
    try {
      await fs.copyFile(PANEL_NGINX_PATH, PANEL_NGINX_BAK);
      hadBackup = true;
    } catch { /* первого файла может не быть */ }

    try {
      await fs.writeFile(PANEL_NGINX_PATH, config, 'utf-8');

      // Убеждаемся, что symlink есть.
      try {
        await fs.access(PANEL_NGINX_ENABLED);
      } catch {
        await fs.symlink(PANEL_NGINX_PATH, PANEL_NGINX_ENABLED).catch(() => {});
      }

      // nginx -t
      const t = await this.executor.execute('nginx', ['-t'], { allowFailure: true, timeout: 15_000 });
      if (t.exitCode !== 0) {
        // Откатываем
        if (hadBackup) {
          await fs.copyFile(PANEL_NGINX_BAK, PANEL_NGINX_PATH).catch(() => {});
        }
        return { success: false, error: `nginx -t failed:\n${t.stderr || t.stdout}` };
      }

      // reload
      const r = await this.executor.execute('systemctl', ['reload', 'nginx'], { allowFailure: true });
      if (r.exitCode !== 0) {
        return { success: false, error: `nginx reload failed: ${r.stderr}` };
      }
      return { success: true };
    } catch (e) {
      if (hadBackup) {
        await fs.copyFile(PANEL_NGINX_BAK, PANEL_NGINX_PATH).catch(() => {});
      }
      return { success: false, error: (e as Error).message };
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: рендер шаблона
  // ---------------------------------------------------------------------------

  private buildPanelNginxConf(
    s: RenderSettings,
    env: { PANEL_PORT: string; API_PORT: string; WEB_PORT: string; ADMINER_DIR: string },
  ): string {
    const { PANEL_PORT, API_PORT, WEB_PORT, ADMINER_DIR } = env;
    const serverNamePanel = s.domain || '_';

    // ------- Общая шапка: upstreams + ACME challenge HTTP server (если есть domain)
    let conf = `# Generated by meowbox panel-access manager. DO NOT EDIT MANUALLY.
upstream meowbox_api {
    server 127.0.0.1:${API_PORT};
}
upstream meowbox_web {
    server 127.0.0.1:${WEB_PORT};
}
`;

    // ------- HTTP :80 — только для ACME challenge + опциональный 301-редирект
    //
    // Биндимся ТОЛЬКО на domain (server_name = domain), чтобы не конфликтовать
    // с user-site nginx конфигами на :80 (у них свой server_name).
    //
    // Если домена нет — :80 не трогаем вообще, чтоб не мешать user-sites.
    if (s.domain) {
      const acmeBlock = `
# HTTP — ACME challenge + (optional) redirect to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name ${s.domain};

    location ^~ /.well-known/acme-challenge/ {
        root ${ACME_WEBROOT};
        default_type "text/plain";
        try_files $uri =404;
    }

${
  s.httpsRedirect && s.certMode !== 'NONE'
    ? `    location / {
        return 301 https://$host:${PANEL_PORT}$request_uri;
    }
`
    : `    location / {
        return 404;
    }
`
}}
`;
      conf += acmeBlock;
    }

    // ------- Основной server на PANEL_PORT
    //
    // Если denyIpAccess — server_name <domain>, без default_server.
    //   Плюс отдельный default-server на этом же порту, который 444 отдаёт.
    // Иначе — server_name <domain> _; default_server (как раньше).
    const isHttps = s.certMode !== 'NONE';
    const listenLine = isHttps
      ? `    listen ${PANEL_PORT} ssl;\n    listen [::]:${PANEL_PORT} ssl;\n    http2 on;`
      : `    listen ${PANEL_PORT};\n    listen [::]:${PANEL_PORT};`;

    let serverNames: string;
    let defaultServerBlock = '';
    if (s.denyIpAccess && s.domain) {
      serverNames = `    server_name ${s.domain};`;
      // Default server: всё, что не <domain>, на этом порту — 444.
      // ВАЖНО: для default_server ssl нужен тот же cert (иначе TLS handshake
      // упадёт ДО возможности отдать 444). Используем тот же self-signed/LE
      // — браузер на IP получит ssl-handshake → cert не валиден на IP →
      // соединение разорвано (для атакующего бесшумно).
      defaultServerBlock = `
# Default server — IP:PORT доступ запрещён (server_name только domain).
server {
${isHttps
  ? `    listen ${PANEL_PORT} ssl default_server;\n    listen [::]:${PANEL_PORT} ssl default_server;\n    http2 on;\n    ssl_certificate ${s.certPath};\n    ssl_certificate_key ${s.keyPath};\n    ssl_reject_handshake off;`
  : `    listen ${PANEL_PORT} default_server;\n    listen [::]:${PANEL_PORT} default_server;`
}
    server_name _;
    return 444;
}
`;
    } else {
      // Без denyIpAccess — основной server слушает и domain и `_` (фаллбэк).
      serverNames = `    server_name ${serverNamePanel}${s.domain && s.domain !== '_' ? ' _' : ''};`;
    }

    const sslBlock = isHttps
      ? `    ssl_certificate ${s.certPath};
    ssl_certificate_key ${s.keyPath};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;
`
      : '';

    conf += `
server {
${listenLine}
${serverNames}
${sslBlock}
    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
${isHttps ? '    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;\n' : ''}
    # API: long-running endpoints (server provisioning, etc.)
    location /api/servers/provision {
        proxy_pass http://meowbox_api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 900s;
        proxy_send_timeout 900s;
    }

    # API proxy
    location /api/ {
        proxy_pass http://meowbox_api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
        proxy_send_timeout 30s;
    }

    # WebSocket (Socket.io for agent)
    location /socket.io/ {
        proxy_pass http://meowbox_api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
    }

    # Nuxt HMR WebSocket
    location /_nuxt/ {
        proxy_pass http://meowbox_web;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }

    # Adminer (встроенный, /adminer/)
    location ^~ /adminer/ {
        alias ${ADMINER_DIR}/;
        index index.php;

        add_header X-Robots-Tag "noindex,nofollow" always;
        add_header X-Frame-Options "SAMEORIGIN" always;
        client_max_body_size 128m;

        try_files $uri $uri/ /adminer/index.php?$args;

        location ~ ^/adminer/lib/ {
            deny all;
            return 403;
        }

        location ~ ^/adminer/(index|sso|adminer)\\.php$ {
            alias ${ADMINER_DIR}/;
            try_files /$1.php =404;

            fastcgi_pass unix:/run/php/meowbox-adminer.sock;
            fastcgi_index index.php;
            fastcgi_param SCRIPT_FILENAME ${ADMINER_DIR}/$1.php;
            fastcgi_param DOCUMENT_ROOT ${ADMINER_DIR};
            include fastcgi_params;
            fastcgi_read_timeout 120s;
            fastcgi_buffers 16 16k;
            fastcgi_buffer_size 32k;
        }
    }

    # Web UI (Nuxt)
    location / {
        proxy_pass http://meowbox_web;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
${defaultServerBlock}`;

    return conf;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Читает PANEL_PORT/API_PORT/WEB_PORT/ADMINER_DIR из state/.env.
   * Если файла нет — fallback на process.env с дефолтами install.sh.
   */
  private async readPanelEnv(): Promise<{
    PANEL_PORT: string;
    API_PORT: string;
    WEB_PORT: string;
    ADMINER_DIR: string;
  }> {
    const envFiles = [
      '/opt/meowbox/state/.env',
      '/opt/meowbox/.env',
    ];
    let parsed: Record<string, string> = {};
    for (const f of envFiles) {
      try {
        const content = await fs.readFile(f, 'utf-8');
        for (const line of content.split('\n')) {
          const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
          if (m) parsed[m[1]] = m[2].replace(/^"/, '').replace(/"$/, '').trim();
        }
        break;
      } catch { /* ignore — пробуем следующий */ }
    }

    // ADMINER_DIR: если есть .dev-mode → tools/adminer, иначе state/adminer.
    let adminerDir = parsed.ADMINER_DIR || '';
    if (!adminerDir) {
      const devModeExists = await fs.access('/opt/meowbox/.dev-mode').then(() => true).catch(() => false);
      adminerDir = devModeExists ? '/opt/meowbox/tools/adminer' : '/opt/meowbox/state/adminer';
    }

    return {
      PANEL_PORT: parsed.PANEL_PORT || process.env.PANEL_PORT || '11862',
      API_PORT: parsed.API_PORT || process.env.API_PORT || '11860',
      WEB_PORT: parsed.WEB_PORT || process.env.WEB_PORT || '11861',
      ADMINER_DIR: adminerDir,
    };
  }

  /**
   * Публичный IP сервера. Стратегия: tcp-коннект на 1.1.1.1:53 и читаем
   * localAddress. Это даёт «исходящий» IP даже если интерфейс с NAT — для
   * сравнения с DNS-резолвом обычно ок.
   */
  private async detectPublicIp(): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const sock = createConnection({ host: '1.1.1.1', port: 53, timeout: 3000 });
      sock.on('connect', () => {
        const addr = sock.localAddress || null;
        sock.destroy();
        resolve(addr);
      });
      sock.on('error', () => {
        sock.destroy();
        resolve(null);
      });
      sock.on('timeout', () => {
        sock.destroy();
        resolve(null);
      });
    });
  }

  private async readCertExpiry(certPath: string): Promise<string | null> {
    const r = await this.executor.execute(
      'openssl',
      ['x509', '-in', certPath, '-noout', '-enddate'],
      { timeout: 10_000, allowFailure: true },
    );
    if (r.exitCode !== 0) return null;
    const m = r.stdout.match(/notAfter=(.+)/);
    if (!m) return null;
    try {
      return new Date(m[1]).toISOString();
    } catch {
      return null;
    }
  }

  private parseCertbotError(raw: string): string {
    if (!raw) return '';
    const lines = raw.split('\n').map((l) => l.trim());
    const rate = lines.find((l) => /rate ?limit|too many (certificates|failed)/i.test(l));
    if (rate) return `Let's Encrypt rate limit: ${rate}`;
    const dns = lines.find((l) =>
      /DNS problem|NXDOMAIN|no (A|AAAA) record|could not resolve/i.test(l),
    );
    if (dns) return `DNS: ${dns}`;
    const detail = lines.find((l) => /^Detail:\s*/i.test(l));
    if (detail) return detail.replace(/^Detail:\s*/i, '');
    const useful = lines
      .filter(Boolean)
      .filter((l) => !/^Saving debug log|^Ask for help|^See the logfile|community\.letsencrypt\.org/i.test(l))
      .join('\n');
    return useful.slice(0, 600);
  }
}
