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
import { createHash, X509Certificate } from 'crypto';
import { createConnection } from 'net';
import { CommandExecutor } from '../command-executor';
import { ACME_WEBROOT, LETSENCRYPT_LIVE_DIR } from '../config';

const PANEL_NGINX_PATH = '/etc/nginx/sites-available/meowbox-panel';
const PANEL_NGINX_ENABLED = '/etc/nginx/sites-enabled/meowbox-panel';
const PANEL_NGINX_BAK = '/etc/nginx/sites-available/meowbox-panel.bak';
const PANEL_CANDIDATE_PATH = '/etc/nginx/sites-available/meowbox-panel-candidate';
const PANEL_CANDIDATE_ENABLED = '/etc/nginx/sites-enabled/meowbox-panel-candidate';
const SELFSIGNED_DIR = '/etc/ssl/meowbox/panel';
const CUTOVER_STATE_DIR = '/opt/meowbox/state/data/panel-access-cutovers';
const CUTOVER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface RenderSettings {
  domain: string | null;
  certMode: 'NONE' | 'SELFSIGNED' | 'LE';
  certPath: string | null;
  keyPath: string | null;
  httpsRedirect: boolean;
  denyIpAccess: boolean;
}

interface FederationEndpointSettings {
  apiOrigin: string;
  wsOrigin: string;
  wsPath: string;
  browserPublicOrigin: string;
  directTransferOrigin: string;
}

export interface PanelAccessCutoverStageInput {
  cutoverId: string;
  domain: string;
  email: string;
  httpsRedirect: boolean;
  denyIpAccess: boolean;
  previousSettings: RenderSettings;
  previousEndpoint: FederationEndpointSettings;
}

export interface PanelAccessCutoverStageResult {
  cutoverId: string;
  state: 'STAGED';
  candidateOrigin: string;
  spkiSha256: string;
  candidateSettings: RenderSettings & {
    certIssuedAt: string;
    certExpiresAt: string | null;
    leEmail: string;
    leLastError: null;
  };
}

type AgentCutoverState = 'STAGED' | 'FINALIZED' | 'ROLLED_BACK';

interface AgentCutoverJournal extends Omit<PanelAccessCutoverStageResult, 'state'> {
  schemaVersion: 1;
  state: AgentCutoverState;
  previousSettings: RenderSettings;
  previousEndpoint: FederationEndpointSettings;
  updatedAt: string;
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

  async stageFederationCutover(
    input: PanelAccessCutoverStageInput,
  ): Promise<PanelAccessCutoverStageResult> {
    this.assertCutoverInput(input);
    await fs.mkdir(CUTOVER_STATE_DIR, { recursive: true, mode: 0o700 });
    await fs.chmod(CUTOVER_STATE_DIR, 0o700);

    const persisted = await this.readCutoverJournal(input.cutoverId);
    if (persisted) {
      this.assertJournalBinding(persisted, input);
      if (persisted.state === 'ROLLED_BACK') {
        throw new Error('Panel Access cutover was already rolled back');
      }
      if (persisted.state === 'STAGED') await fs.access(PANEL_CANDIDATE_PATH);
      await fs.access(persisted.candidateSettings.certPath!);
      await fs.access(persisted.candidateSettings.keyPath!);
      return this.stageResult(persisted);
    }

    const env = await this.readPanelEnv();
    await this.applyCandidateConfig(
      input.cutoverId,
      this.buildCandidateAcmeConf(input.cutoverId, input.domain),
    );

    const issued = await this.issueLeCert({ domain: input.domain, email: input.email });
    if (!issued.success || !issued.certPath || !issued.keyPath) {
      await this.removeCandidateConfig();
      throw new Error(issued.error || 'Panel Access certificate issuance failed');
    }

    const certPem = await fs.readFile(issued.certPath);
    const certificate = new X509Certificate(certPem);
    const spki = certificate.publicKey.export({ type: 'spki', format: 'der' });
    const spkiSha256 = `sha256/${createHash('sha256').update(spki).digest('base64')}`;
    const panelPort = this.panelPort(env.PANEL_PORT);
    const candidateOrigin = `https://${input.domain}${panelPort === 443 ? '' : `:${panelPort}`}`;
    const issuedAt = new Date().toISOString();
    const candidateSettings: PanelAccessCutoverStageResult['candidateSettings'] = {
      domain: input.domain,
      certMode: 'LE',
      certPath: issued.certPath,
      keyPath: issued.keyPath,
      httpsRedirect: input.httpsRedirect,
      denyIpAccess: input.denyIpAccess,
      certIssuedAt: issuedAt,
      certExpiresAt: issued.expiresAt || null,
      leEmail: input.email,
      leLastError: null,
    };
    await this.applyCandidateConfig(
      input.cutoverId,
      this.buildPanelNginxConf(candidateSettings, env, {
        includeUpstreams: false,
        candidateOnly: true,
        cutoverId: input.cutoverId,
      }),
    );
    const journal: AgentCutoverJournal = {
      schemaVersion: 1,
      cutoverId: input.cutoverId,
      state: 'STAGED',
      candidateOrigin,
      spkiSha256,
      candidateSettings,
      previousSettings: input.previousSettings,
      previousEndpoint: input.previousEndpoint,
      updatedAt: new Date().toISOString(),
    };
    await this.writeCutoverJournal(journal);
    return this.stageResult(journal);
  }

  async finalizeFederationCutover(input: {
    cutoverId: string;
    candidateOrigin: string;
  }): Promise<{ success: boolean; reloadApi: boolean; error?: string }> {
    try {
      if (!CUTOVER_ID.test(input.cutoverId)) throw new Error('Invalid cutover ID');
      const journal = await this.readCutoverJournal(input.cutoverId);
      if (!journal || journal.candidateOrigin !== input.candidateOrigin) {
        throw new Error('Panel Access cutover journal mismatch');
      }
      if (journal.state === 'FINALIZED') return { success: true, reloadApi: true };
      if (journal.state !== 'STAGED') throw new Error(`Panel Access cutover cannot finalize from ${journal.state}`);
      const env = await this.readPanelEnv();
      const primaryBefore = await fs.readFile(PANEL_NGINX_PATH, 'utf8');
      const envBefore = await this.readStateEnv();
      const nextEndpoints = this.endpointForOrigin(
        journal.candidateOrigin,
        journal.previousEndpoint.wsPath,
      );
      try {
        await this.writeFederationEndpoints(envBefore, nextEndpoints);
        await this.writeAtomicFile(
          PANEL_NGINX_PATH,
          this.buildPanelNginxConf(journal.candidateSettings, env),
          0o644,
        );
        await this.removeCandidateFilesOnly();
        await this.assertNginxAndReload();
        await this.writeCutoverJournal({
          ...journal,
          state: 'FINALIZED',
          updatedAt: new Date().toISOString(),
        });
      } catch (error) {
        await this.writeAtomicFile(PANEL_NGINX_PATH, primaryBefore, 0o644).catch(() => undefined);
        await this.writeAtomicFile('/opt/meowbox/state/.env', envBefore, 0o600).catch(() => undefined);
        await this.applyCandidateConfig(
          input.cutoverId,
          this.buildPanelNginxConf(journal.candidateSettings, env, {
            includeUpstreams: false,
            candidateOnly: true,
            cutoverId: input.cutoverId,
          }),
        ).catch(() => undefined);
        throw error;
      }
      return { success: true, reloadApi: true };
    } catch (error) {
      return { success: false, reloadApi: false, error: (error as Error).message };
    }
  }

  async rollbackFederationCutover(input: {
    cutoverId: string;
  }): Promise<{ success: boolean; reloadApi: boolean; error?: string }> {
    try {
      if (!CUTOVER_ID.test(input.cutoverId)) throw new Error('Invalid cutover ID');
      const journal = await this.readCutoverJournal(input.cutoverId);
      if (!journal) {
        await this.removeCandidateConfig();
        return { success: true, reloadApi: false };
      }
      if (journal.state === 'ROLLED_BACK') return { success: true, reloadApi: true };
      const env = await this.readPanelEnv();
      const primaryBefore = await fs.readFile(PANEL_NGINX_PATH, 'utf8');
      const envBefore = await this.readStateEnv();
      try {
        await this.writeFederationEndpoints(envBefore, journal.previousEndpoint);
        await this.writeAtomicFile(
          PANEL_NGINX_PATH,
          this.buildPanelNginxConf(journal.previousSettings, env),
          0o644,
        );
        await this.removeCandidateFilesOnly();
        await this.assertNginxAndReload();
        await this.writeCutoverJournal({
          ...journal,
          state: 'ROLLED_BACK',
          updatedAt: new Date().toISOString(),
        });
      } catch (error) {
        await this.writeAtomicFile('/opt/meowbox/state/.env', envBefore, 0o600).catch(() => undefined);
        await this.writeAtomicFile(PANEL_NGINX_PATH, primaryBefore, 0o644).catch(() => undefined);
        if (journal.state === 'STAGED') {
          await this.applyCandidateConfig(
            input.cutoverId,
            this.buildPanelNginxConf(journal.candidateSettings, env, {
              includeUpstreams: false,
              candidateOnly: true,
              cutoverId: input.cutoverId,
            }),
          ).catch(() => undefined);
        } else {
          await this.assertNginxAndReload().catch(() => undefined);
        }
        throw error;
      }
      return { success: true, reloadApi: true };
    } catch (error) {
      return { success: false, reloadApi: false, error: (error as Error).message };
    }
  }

  async reloadApiEnvironment(): Promise<void> {
    const result = await this.executor.execute(
      'pm2',
      ['reload', 'meowbox-api', '--update-env'],
      { allowFailure: true, timeout: 60_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(`meowbox-api reload failed: ${result.stderr || result.stdout}`);
    }
  }

  async getFederationCutoverStatus(input: { cutoverId: string }): Promise<{
    success: boolean;
    state?: AgentCutoverState;
    candidateOrigin?: string;
    error?: string;
  }> {
    try {
      if (!CUTOVER_ID.test(input.cutoverId)) throw new Error('Invalid cutover ID');
      const journal = await this.readCutoverJournal(input.cutoverId);
      if (!journal) return { success: false, error: 'Panel Access cutover journal not found' };
      return {
        success: true,
        state: journal.state,
        candidateOrigin: journal.candidateOrigin,
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: рендер шаблона
  // ---------------------------------------------------------------------------

  private buildPanelNginxConf(
    s: RenderSettings,
    env: {
      PANEL_PORT: string;
      API_PORT: string;
      WEB_PORT: string;
      ADMINER_DIR: string;
      TRANSFER_RATE_LIMIT: string;
    },
    options: {
      includeUpstreams?: boolean;
      candidateOnly?: boolean;
      cutoverId?: string;
    } = {},
  ): string {
    const { PANEL_PORT, API_PORT, WEB_PORT, ADMINER_DIR, TRANSFER_RATE_LIMIT } = env;
    const serverNamePanel = s.domain || '_';
    const includeUpstreams = options.includeUpstreams !== false;
    const candidateOnly = options.candidateOnly === true;

    // ------- Общая шапка: upstreams + ACME challenge HTTP server (если есть domain)
    let conf = `# Generated by meowbox panel-access manager. DO NOT EDIT MANUALLY.
${options.cutoverId ? `# federation-cutover: ${options.cutoverId}\n` : ''}${includeUpstreams ? `
upstream meowbox_api {
    server 127.0.0.1:${API_PORT};
}
upstream meowbox_web {
    server 127.0.0.1:${WEB_PORT};
}
` : ''}`;

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
    // HTTP/2 не включаем — не у всех сборок nginx есть ngx_http_v2_module,
    // а для админ-панели http/1.1 более чем достаточно.
    const listenLine = isHttps
      ? `    listen ${PANEL_PORT} ssl;\n    listen [::]:${PANEL_PORT} ssl;`
      : `    listen ${PANEL_PORT};\n    listen [::]:${PANEL_PORT};`;

    let serverNames: string;
    let defaultServerBlock = '';
    if (candidateOnly && s.domain) {
      serverNames = `    server_name ${s.domain};`;
    } else if (s.denyIpAccess && s.domain) {
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
  ? `    listen ${PANEL_PORT} ssl default_server;\n    listen [::]:${PANEL_PORT} ssl default_server;\n    ssl_certificate ${s.certPath};\n    ssl_certificate_key ${s.keyPath};`
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

    # Direct generated/staged transfer delivery. Timeouts are inactivity
    # budgets; a progressing stream has no total Nginx deadline.
    location ^~ /api/public/v1/transfers/ {
        client_max_body_size 50g;
        client_body_timeout 60s;
        proxy_pass http://meowbox_api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_max_temp_file_size 0;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
        send_timeout 60s;
        limit_rate ${TRANSFER_RATE_LIMIT};
        add_header Cache-Control "no-store" always;
        add_header Referrer-Policy "no-referrer" always;
        access_log off;
        error_log /dev/null crit;
    }

    # Public webhook ingress. Provider signatures bind the exact request bytes;
    # tokens and request bodies must never enter Nginx logs.
    location ^~ /api/public/v1/webhooks/ {
        client_max_body_size 64k;
        client_body_buffer_size 64k;
        proxy_pass http://meowbox_api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering on;
        proxy_connect_timeout 5s;
        proxy_read_timeout 15s;
        proxy_send_timeout 15s;
        send_timeout 15s;
        add_header Cache-Control "no-store" always;
        add_header Referrer-Policy "no-referrer" always;
        access_log off;
        error_log /dev/null crit;
    }

    # MODX login handoff keeps its one-time secret in the URL fragment and
    # submits it in a bounded same-origin POST. Never log the consume route.
    location ^~ /api/public/v1/modx/login {
        client_max_body_size 4k;
        client_body_buffer_size 4k;
        proxy_pass http://meowbox_api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering on;
        proxy_connect_timeout 5s;
        proxy_read_timeout 15s;
        proxy_send_timeout 15s;
        add_header Cache-Control "no-store" always;
        add_header Referrer-Policy "no-referrer" always;
        access_log off;
        error_log /dev/null crit;
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
        add_header Referrer-Policy "no-referrer" always;
        add_header Cache-Control "no-store" always;
        client_max_body_size 128m;

        try_files $uri $uri/ /adminer/index.php?$args;

        location ~ ^/adminer/lib/ {
            deny all;
            return 403;
        }

        location = /adminer/adminer.php {
            return 404;
        }

        location ~ ^/adminer/(index|sso)\\.php$ {
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

  private assertCutoverInput(input: PanelAccessCutoverStageInput): void {
    if (
      !CUTOVER_ID.test(input.cutoverId) ||
      !/^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(input.domain) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) ||
      input.previousSettings.certMode === 'NONE'
    ) throw new Error('Panel Access cutover input is invalid');
    for (const origin of [
      input.previousEndpoint.apiOrigin,
      input.previousEndpoint.wsOrigin,
      input.previousEndpoint.browserPublicOrigin,
      input.previousEndpoint.directTransferOrigin,
    ]) {
      const parsed = new URL(origin);
      if (parsed.protocol !== 'https:' || parsed.origin !== origin) {
        throw new Error('Previous federation endpoint is invalid');
      }
    }
    if (!/^\/[A-Za-z0-9][A-Za-z0-9._/-]*\/?$/.test(input.previousEndpoint.wsPath)) {
      throw new Error('Previous federation socket path is invalid');
    }
  }

  private assertJournalBinding(
    journal: AgentCutoverJournal,
    input: PanelAccessCutoverStageInput,
  ): void {
    if (
      journal.cutoverId !== input.cutoverId ||
      journal.candidateSettings.domain !== input.domain ||
      journal.candidateSettings.leEmail !== input.email ||
      journal.candidateSettings.httpsRedirect !== input.httpsRedirect ||
      journal.candidateSettings.denyIpAccess !== input.denyIpAccess ||
      JSON.stringify(journal.previousSettings) !== JSON.stringify(input.previousSettings) ||
      JSON.stringify(journal.previousEndpoint) !== JSON.stringify(input.previousEndpoint)
    ) throw new Error('Panel Access cutover idempotency conflict');
  }

  private stageResult(journal: AgentCutoverJournal): PanelAccessCutoverStageResult {
    return {
      cutoverId: journal.cutoverId,
      state: 'STAGED',
      candidateOrigin: journal.candidateOrigin,
      spkiSha256: journal.spkiSha256,
      candidateSettings: journal.candidateSettings,
    };
  }

  private cutoverJournalPath(cutoverId: string): string {
    if (!CUTOVER_ID.test(cutoverId)) throw new Error('Invalid cutover ID');
    return path.join(CUTOVER_STATE_DIR, `${cutoverId}.json`);
  }

  private async readCutoverJournal(cutoverId: string): Promise<AgentCutoverJournal | null> {
    try {
      const raw = await fs.readFile(this.cutoverJournalPath(cutoverId), 'utf8');
      const value = JSON.parse(raw) as AgentCutoverJournal;
      if (
        value.schemaVersion !== 1 ||
        value.cutoverId !== cutoverId ||
        !(['STAGED', 'FINALIZED', 'ROLLED_BACK'] as const).includes(value.state) ||
        typeof value.candidateOrigin !== 'string' ||
        !/^sha256\/[A-Za-z0-9+/]{43}=$/.test(value.spkiSha256) ||
        !value.candidateSettings ||
        !value.previousSettings ||
        !value.previousEndpoint
      ) throw new Error('Panel Access cutover journal is invalid');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async writeCutoverJournal(journal: AgentCutoverJournal): Promise<void> {
    await fs.mkdir(CUTOVER_STATE_DIR, { recursive: true, mode: 0o700 });
    await fs.chmod(CUTOVER_STATE_DIR, 0o700);
    await this.writeAtomicFile(
      this.cutoverJournalPath(journal.cutoverId),
      `${JSON.stringify(journal)}\n`,
      0o600,
    );
  }

  private buildCandidateAcmeConf(cutoverId: string, domain: string): string {
    return `# Generated by meowbox panel-access manager. DO NOT EDIT MANUALLY.
# federation-cutover: ${cutoverId}
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    location ^~ /.well-known/acme-challenge/ {
        root ${ACME_WEBROOT};
        default_type "text/plain";
        try_files $uri =404;
    }

    location / { return 404; }
}
`;
  }

  private async applyCandidateConfig(cutoverId: string, content: string): Promise<void> {
    if (!content.includes(`# federation-cutover: ${cutoverId}`)) {
      throw new Error('Candidate Nginx configuration is not cutover-bound');
    }
    const previous = await fs.readFile(PANEL_CANDIDATE_PATH, 'utf8').catch(() => null);
    await this.writeAtomicFile(PANEL_CANDIDATE_PATH, content, 0o644);
    try {
      const stat = await fs.lstat(PANEL_CANDIDATE_ENABLED).catch(() => null);
      if (stat) {
        if (!stat.isSymbolicLink() || await fs.readlink(PANEL_CANDIDATE_ENABLED) !== PANEL_CANDIDATE_PATH) {
          throw new Error('Panel candidate Nginx link is not managed by Meowbox');
        }
      } else {
        await fs.symlink(PANEL_CANDIDATE_PATH, PANEL_CANDIDATE_ENABLED);
      }
      await this.assertNginxAndReload();
    } catch (error) {
      if (previous === null) await fs.rm(PANEL_CANDIDATE_PATH, { force: true });
      else await this.writeAtomicFile(PANEL_CANDIDATE_PATH, previous, 0o644);
      await this.assertNginxAndReload().catch(() => undefined);
      throw error;
    }
  }

  private async removeCandidateFilesOnly(): Promise<void> {
    const stat = await fs.lstat(PANEL_CANDIDATE_ENABLED).catch(() => null);
    if (stat) {
      if (!stat.isSymbolicLink() || await fs.readlink(PANEL_CANDIDATE_ENABLED) !== PANEL_CANDIDATE_PATH) {
        throw new Error('Panel candidate Nginx link is not managed by Meowbox');
      }
      await fs.rm(PANEL_CANDIDATE_ENABLED, { force: true });
    }
    await fs.rm(PANEL_CANDIDATE_PATH, { force: true });
  }

  private async removeCandidateConfig(): Promise<void> {
    await this.removeCandidateFilesOnly();
    await this.assertNginxAndReload();
  }

  private async assertNginxAndReload(): Promise<void> {
    const tested = await this.executor.execute('nginx', ['-t'], {
      allowFailure: true,
      timeout: 15_000,
    });
    if (tested.exitCode !== 0) {
      throw new Error(`nginx -t failed: ${tested.stderr || tested.stdout}`);
    }
    const reloaded = await this.executor.execute('systemctl', ['reload', 'nginx'], {
      allowFailure: true,
      timeout: 30_000,
    });
    if (reloaded.exitCode !== 0) {
      throw new Error(`nginx reload failed: ${reloaded.stderr || reloaded.stdout}`);
    }
  }

  private panelPort(raw: string): number {
    const port = Number(raw);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new Error('PANEL_PORT is invalid');
    }
    return port;
  }

  private endpointForOrigin(origin: string, wsPath: string): FederationEndpointSettings {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' || parsed.origin !== origin) {
      throw new Error('Candidate federation endpoint is invalid');
    }
    return {
      apiOrigin: origin,
      wsOrigin: origin,
      wsPath,
      browserPublicOrigin: origin,
      directTransferOrigin: origin,
    };
  }

  private async readStateEnv(): Promise<string> {
    const raw = await fs.readFile('/opt/meowbox/state/.env', 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > 1024 * 1024 || raw.includes('\0')) {
      throw new Error('state/.env is invalid');
    }
    return raw;
  }

  private async writeFederationEndpoints(
    current: string,
    endpoint: FederationEndpointSettings,
  ): Promise<void> {
    const replacements: Record<string, string> = {
      FEDERATION_API_ORIGIN: endpoint.apiOrigin,
      FEDERATION_WS_ORIGIN: endpoint.wsOrigin,
      FEDERATION_WS_PATH: endpoint.wsPath,
      FEDERATION_BROWSER_PUBLIC_ORIGIN: endpoint.browserPublicOrigin,
      FEDERATION_DIRECT_TRANSFER_ORIGIN: endpoint.directTransferOrigin,
    };
    const seen = new Set<string>();
    const lines = current.split('\n').map((line) => {
      const match = /^([A-Z0-9_]+)=/.exec(line);
      if (!match || !(match[1] in replacements)) return line;
      if (seen.has(match[1])) throw new Error(`Duplicate ${match[1]} in state/.env`);
      seen.add(match[1]);
      return `${match[1]}=${replacements[match[1]]}`;
    });
    for (const [key, value] of Object.entries(replacements)) {
      if (!seen.has(key)) lines.push(`${key}=${value}`);
    }
    const next = `${lines.join('\n').replace(/\n+$/, '')}\n`;
    await this.writeAtomicFile('/opt/meowbox/state/.env', next, 0o600);
  }

  private async writeAtomicFile(file: string, content: string, mode: number): Promise<void> {
    const directory = path.dirname(file);
    const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    const handle = await fs.open(temp, 'wx', mode);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.chmod(temp, mode);
      await fs.rename(temp, file);
      const dir = await fs.open(directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Читает PANEL_PORT/API_PORT/WEB_PORT/ADMINER_DIR из state/.env.
   * Если файла нет — fallback на process.env с дефолтами install.sh.
   */
  private async readPanelEnv(): Promise<{
    PANEL_PORT: string;
    API_PORT: string;
    WEB_PORT: string;
    ADMINER_DIR: string;
    TRANSFER_RATE_LIMIT: string;
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
      TRANSFER_RATE_LIMIT: /^[1-9]\d*[kKmMgG]$/.test(parsed.TRANSFER_RATE_LIMIT || '')
        ? parsed.TRANSFER_RATE_LIMIT
        : '20m',
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
