import { io, Socket } from 'socket.io-client';
import { NginxManager } from './nginx/nginx.manager';
import { PhpFpmManager } from './php/phpfpm.manager';
import { Pm2Manager } from './pm2/pm2.manager';
import { MetricsCollector } from './system/metrics.collector';
import { DeployExecutor } from './deploy/deploy.executor';
import { DatabaseManager } from './database/database.manager';
import { SslManager } from './ssl/ssl.manager';
import { BackupExecutor } from './backup/backup.executor';
import { ResticExecutor, ResticStorage, RetentionPolicy } from './backup/restic.executor';
import { FirewallManager } from './firewall/firewall.manager';
import { CountryBlockManager, CountryBlockRule, CountrySource } from './country-block/country-block.manager';
import { CronManager } from './cron/cron.manager';
import { SiteInstaller } from './installer/site-installer';
import { PermissionsManager } from './installer/permissions';
import { ModxDoctor } from './installer/doctor';
import { ModxAdminPassChanger } from './installer/modx-admin-pass';
import { SystemUserManager } from './system/user.manager';
import { CommandExecutor } from './command-executor';
import { TerminalManager } from './terminal/terminal.manager';
import { FileManager } from './files/file.manager';
import { UpdateManager } from './system/update.manager';
import { SiteMetricsCollector } from './system/site-metrics.collector';
import { LogReader } from './logs/log.reader';
import { LogTailManager } from './logs/log.tail';
import { ManticoreExecutor } from './services/manticore.executor';
import { RedisExecutor } from './services/redis.executor';
import { MariadbEngineExecutor, PostgresqlEngineExecutor } from './database/db-engine.executor';
import { XrayManager } from './vpn/xray.manager';
import { AmneziaWgManager } from './vpn/amnezia-wg.manager';
import { VpnInstaller } from './vpn/installer';
import { PanelAccessManager } from './panel-access/panel-access.manager';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  isUnderAllowedSiteRoot,
  isUnderBackupStorage,
  TIMEOUTS,
} from './config';
import { DEFAULT_PHP_VERSION, artifactAnchor } from '@meowbox/shared';

type Callback = (result: unknown) => void;

interface PendingEvent {
  event: string;
  data: unknown;
  /** Эпоха (ms) создания. События старше PENDING_EVENT_TTL_MS дропаются. */
  queuedAt: number;
}

/** Парсит env-число с защитой от NaN/отрицательных значений. */
function envInt(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) {
    console.warn(`[Agent] Invalid ${name}=${raw}, using fallback ${fallback}`);
    return fallback;
  }
  return n;
}

// 5 минут — достаточно, чтобы переждать кратковременный дисконнект API,
// но предотвратить "queue poisoning" (выполнение старых команд через час).
const PENDING_EVENT_TTL_MS = envInt('PENDING_EVENT_TTL_MS', 300_000, 1000);
// Верхний предел размера очереди — чтоб не расти в бесконечность.
const PENDING_EVENT_MAX_QUEUE = envInt('PENDING_EVENT_MAX_QUEUE', 100, 1);

export class AgentService {
  private socket: Socket | null = null;
  private pendingEvents: PendingEvent[] = [];
  private nginx: NginxManager;
  private php: PhpFpmManager;
  private pm2: Pm2Manager;
  private metrics: MetricsCollector;
  private deployer: DeployExecutor;
  private db: DatabaseManager;
  private ssl: SslManager;
  private backup: BackupExecutor;
  private restic: ResticExecutor;
  private firewall: FirewallManager;
  private countryBlock: CountryBlockManager;
  private cron: CronManager;
  private installer: SiteInstaller;
  private permsMgr: PermissionsManager;
  private modxDoctor: ModxDoctor;
  private modxPassChanger: ModxAdminPassChanger;
  private userMgr: SystemUserManager;
  private terminal: TerminalManager;
  private fileMgr: FileManager;
  private updateMgr: UpdateManager;
  private siteMetrics: SiteMetricsCollector;
  private logReader: LogReader;
  private tailManager: LogTailManager;
  private cmdExec: CommandExecutor;
  private manticore: ManticoreExecutor;
  private redisSvc: RedisExecutor;
  private mariadbEngine: MariadbEngineExecutor;
  private postgresqlEngine: PostgresqlEngineExecutor;
  private xrayMgr: XrayManager;
  private amneziaMgr: AmneziaWgManager;
  private vpnInstaller: VpnInstaller;
  private panelAccess: PanelAccessManager;
  private metricsInterval: ReturnType<typeof setInterval> | null = null;
  /**
   * Single-flight для hostpanel-миграции (см. spec §17.5: 1 одновременная
   * миграция на slave). null = свободен; иначе — `probe:<migrationId>` или
   * `run:<migrationId>:<itemId>`.
   */
  private hostpanelMigrationActive: string | null = null;
  /** Soft-cancel токены — взводятся через `migrate:hostpanel:cancel`. */
  private hostpanelCancelTokens: Set<string> = new Set();

  constructor() {
    this.nginx = new NginxManager();
    this.php = new PhpFpmManager();
    this.pm2 = new Pm2Manager();
    this.metrics = new MetricsCollector();
    this.deployer = new DeployExecutor();
    this.db = new DatabaseManager();
    this.ssl = new SslManager();
    this.backup = new BackupExecutor();
    this.restic = new ResticExecutor();
    this.firewall = new FirewallManager();
    this.countryBlock = new CountryBlockManager();
    this.cron = new CronManager();
    this.installer = new SiteInstaller();
    this.terminal = new TerminalManager();
    this.fileMgr = new FileManager();
    this.cmdExec = new CommandExecutor();
    this.permsMgr = new PermissionsManager(this.cmdExec);
    this.modxDoctor = new ModxDoctor(this.cmdExec);
    this.modxPassChanger = new ModxAdminPassChanger(this.cmdExec);
    this.logReader = new LogReader(this.cmdExec);
    this.tailManager = new LogTailManager();
    this.userMgr = new SystemUserManager(this.cmdExec);
    this.updateMgr = new UpdateManager(this.cmdExec);
    this.siteMetrics = new SiteMetricsCollector(this.cmdExec);
    this.manticore = new ManticoreExecutor(this.cmdExec);
    this.redisSvc = new RedisExecutor(this.cmdExec);
    this.mariadbEngine = new MariadbEngineExecutor(this.cmdExec);
    this.postgresqlEngine = new PostgresqlEngineExecutor(this.cmdExec);
    this.xrayMgr = new XrayManager(this.cmdExec);
    this.amneziaMgr = new AmneziaWgManager(this.cmdExec);
    this.vpnInstaller = new VpnInstaller(this.cmdExec);
    this.panelAccess = new PanelAccessManager();
  }

  start() {
    const apiUrl = process.env.API_URL || 'http://127.0.0.1:11860';
    const agentSecret = process.env.AGENT_SECRET;

    if (!agentSecret) {
      console.error('[Agent] AGENT_SECRET is required');
      process.exit(1);
    }

    this.socket = io(apiUrl, {
      auth: { secret: agentSecret },
      reconnection: true,
      reconnectionDelay: 5000,
      reconnectionAttempts: Infinity,
      transports: ['websocket'],
    });

    this.socket.on('connect', () => {
      console.log('[Agent] Connected to API');
      this.flushPendingEvents();
      this.startMetricsStream();
    });

    this.socket.on('disconnect', (reason) => {
      console.log(`[Agent] Disconnected: ${reason}`);
      this.stopMetricsStream();
    });

    this.socket.on('connect_error', (err) => {
      console.error(`[Agent] Connection error: ${err.message}`);
    });

    this.registerHandlers();
    console.log('[Agent] Started, connecting to API...');
  }

  stop() {
    this.stopMetricsStream();
    this.terminal.destroy();
    this.tailManager.stopAll();
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  /**
   * Обёртка вокруг `socket.on(event, handler)`.
   *
   * Гарантии:
   *   1) cb ВСЕГДА вызывается ровно один раз — либо handler'ом, либо
   *      catch-блоком, либо таймаутом. До этого unhandled throw приводил к
   *      "подвисшей" команде на API-стороне (AgentTimeoutError через 120с).
   *   2) Любая exception превращается в `{success: false, error}` — совместимо
   *      с типом AgentResponse в API.
   *   3) Handler, который не завершился за `timeoutMs`, принудительно
   *      резолвится с TIMEOUT-ошибкой. Оригинальный код продолжит крутиться
   *      (нельзя отменить запущенный execFile), но API получит ответ.
   */
  private safeOn<P>(
    s: Socket,
    event: string,
    handler: (params: P, cb: Callback) => Promise<void>,
    timeoutMs: number = TIMEOUTS.SOCKET_HANDLER,
  ): void {
    s.on(event, async (params: P, cb: Callback) => {
      let settled = false;
      const safeCb: Callback = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(tid);
        try {
          cb(result);
        } catch {
          // cb уже не доступен — молча скипаем, иначе зациклимся.
        }
      };
      const tid = setTimeout(() => {
        console.error(`[Agent] Handler "${event}" exceeded ${timeoutMs}ms`);
        safeCb({
          success: false,
          error: `Handler "${event}" timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs);
      try {
        await handler(params, safeCb);
      } catch (err) {
        console.error(`[Agent] Handler "${event}" threw: ${(err as Error).message}`);
        safeCb({ success: false, error: (err as Error).message });
      }
    });
  }

  private registerHandlers() {
    if (!this.socket) return;
    const s = this.socket;

    // -- Nginx --
    this.safeOn(s, 'nginx:create-config', async (
      params: {
        siteName: string;
        siteType: string;
        domain: string;
        aliases: Array<string | { domain: string; redirect?: boolean }>;
        rootPath: string;
        filesRelPath?: string;
        phpVersion?: string;
        phpEnabled?: boolean;
        appPort?: number;
        systemUser?: string;
        sslEnabled?: boolean;
        httpsRedirect?: boolean;
        certPath?: string;
        keyPath?: string;
        // Layered nginx (см. agent/src/nginx/templates.ts)
        settings?: import('@meowbox/shared').SiteNginxOverrides;
        customConfig?: string | null;
        forceWriteCustom?: boolean;
      },
      cb: Callback,
    ) => {
      // Ensure root directory exists before creating config
      const owner = params.systemUser ? `${params.systemUser}:${params.systemUser}` : 'www-data:www-data';
      await this.cmdExec.execute('mkdir', ['-p', params.rootPath]);
      await this.cmdExec.execute('chown', [owner, params.rootPath]);
      await this.cmdExec.execute('chmod', ['750', params.rootPath]);
      cb(await this.nginx.createSiteConfig(params));
    });

    /**
     * Записать ТОЛЬКО `95-custom.conf` для сайта. Используется UI-вкладкой Nginx
     * при сохранении кастом-блока. nginx -t + reload + автооткат при ошибке —
     * внутри `setCustomConfig()`.
     */
    this.safeOn(s, 'nginx:set-custom', async (
      params: { siteName: string; content: string },
      cb: Callback,
    ) => {
      cb(await this.nginx.setCustomConfig(params.siteName, params.content ?? ''));
    });

    /** Прочитать `95-custom.conf` для сайта (UI вкладка Nginx). */
    this.safeOn(s, 'nginx:read-custom', async (
      params: { siteName: string },
      cb: Callback,
    ) => {
      const content = await this.nginx.readCustomConfig(params.siteName);
      cb({ success: true, data: content });
    });

    this.safeOn(s, 'nginx:update-config', async (params: { siteName?: string; domain?: string; config: string }, cb: Callback) => {
      const anchor = artifactAnchor({ siteName: params.siteName, domain: params.domain });
      cb(await this.nginx.updateSiteConfig(anchor, params.config));
    });

    this.safeOn(s, 'nginx:remove-config', async (params: { siteName?: string; domain?: string }, cb: Callback) => {
      const anchor = artifactAnchor({ siteName: params.siteName, domain: params.domain });
      await this.nginx.removeSiteConfig(anchor);
      // Legacy: если siteName задан и отличается от domain — чистим и старый файл
      if (params.siteName && params.domain && params.domain !== anchor) {
        await this.nginx.removeSiteConfig(params.domain);
      }
      cb({ success: true });
    });

    this.safeOn(s, 'nginx:read-config', async (params: { siteName?: string; domain?: string }, cb: Callback) => {
      const anchor = artifactAnchor({ siteName: params.siteName, domain: params.domain });
      const config = await this.nginx.readSiteConfig(anchor);
      cb({ success: true, data: config });
    });

    this.safeOn(s, 'nginx:list-configs', async (_params: unknown, cb: Callback) => {
      cb({ success: true, data: await this.nginx.listConfigs() });
    });

    this.safeOn(s, 'nginx:find-domain-usage', async (params: { domain: string }, cb: Callback) => {
      try {
        const hits = await this.nginx.findDomainUsage(params.domain);
        cb({ success: true, data: { hits } });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'nginx:test', async (_params: unknown, cb: Callback) => {
      cb(await this.nginx.testConfig());
    });

    this.safeOn(s, 'nginx:reload', async (_params: unknown, cb: Callback) => {
      cb(await this.nginx.reload());
    });

    this.safeOn(s, 'nginx:status', async (_params: unknown, cb: Callback) => {
      cb({ success: true, data: await this.nginx.status() });
    });

    this.safeOn(s, 'nginx:read-global-config', async (_params: unknown, cb: Callback) => {
      const content = await this.nginx.readGlobalConfig();
      cb({ success: true, data: content });
    });

    this.safeOn(s, 'nginx:write-global-config', async (params: { content: string }, cb: Callback) => {
      cb(await this.nginx.writeGlobalConfig(params.content));
    });

    this.safeOn(s, 'nginx:write-global-zones', async (
      params: { zones: Array<{ siteName: string; rps: number; enabled: boolean }> },
      cb: Callback,
    ) => {
      cb(await this.nginx.writeGlobalZones(params?.zones || []));
    });

    this.safeOn(s, 'nginx:create-dir', async (params: { path: string; systemUser?: string }, cb: Callback) => {
      try {
        const owner = params.systemUser ? `${params.systemUser}:${params.systemUser}` : 'www-data:www-data';
        await this.cmdExec.execute('mkdir', ['-p', params.path]);
        await this.cmdExec.execute('chown', [owner, params.path]);
        cb({ success: true });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    // -- PHP-FPM --
    this.safeOn(s, 'php:create-pool', async (params: { siteName?: string; domain: string; phpVersion: string; user?: string; rootPath?: string; sslEnabled?: boolean; customConfig?: string | null }, cb: Callback) => {
      cb(await this.php.createPool(params));
    });

    this.safeOn(s, 'php:remove-pool', async (params: { siteName?: string; domain?: string; phpVersion: string }, cb: Callback) => {
      const anchor = artifactAnchor({ siteName: params.siteName, domain: params.domain });
      await this.php.removePool(anchor, params.phpVersion);
      // Legacy: если siteName задан и отличается от domain — чистим и старый pool
      if (params.siteName && params.domain && params.domain !== anchor) {
        await this.php.removePool(params.domain, params.phpVersion);
      }
      cb({ success: true });
    });

    this.safeOn(s, 'php:read-pool', async (params: { siteName?: string; domain?: string; phpVersion: string }, cb: Callback) => {
      const anchor = artifactAnchor({ siteName: params.siteName, domain: params.domain });
      const content = await this.php.readPool(anchor, params.phpVersion);
      cb({ success: true, data: content });
    });

    this.safeOn(s, 'php:status', async (params: { phpVersion: string }, cb: Callback) => {
      cb({ success: true, data: await this.php.status(params.phpVersion) });
    });

    this.safeOn(s, 'php:list-versions', async (_params: unknown, cb: Callback) => {
      cb({ success: true, data: await this.php.listVersions() });
    });

    // Регенерация composer autoload под новую версию PHP (после смены phpVersion
    // для сайта). Чинит vendor/composer/platform_check.php — без этого сайты с
    // composer.json фатально падают при даунгрейде/апгрейде PHP.
    this.safeOn(s, 'site:php-regenerate-composer', async (params: {
      siteId?: string;
      domain?: string;
      rootPath: string;
      filesRelPath?: string;
      phpVersion: string;
    }, cb: Callback) => {
      try {
        const onLog = (line: string) => {
          if (s.connected) {
            s.emit('site:install:log', {
              siteId: params.siteId,
              domain: params.domain,
              line,
            });
          }
        };
        const result = await this.installer.regenerateComposerAutoload(
          params.rootPath,
          params.filesRelPath,
          params.phpVersion,
          onLog,
        );
        cb(result);
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'php:restart', async (params: { phpVersion: string }, cb: Callback) => {
      try {
        const result = await this.cmdExec.execute('systemctl', ['restart', `php${params.phpVersion}-fpm`], { allowFailure: true });
        cb({ success: result.exitCode === 0, error: result.exitCode !== 0 ? result.stderr : undefined });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    // PHP install/uninstall — heavy apt-операции. Внутренний timeout
    // `apt-get install` в phpfpm.manager — 600s. Handler timeout должен быть
    // БОЛЬШЕ, иначе callback грохнут раньше чем apt закончит, UI получит
    // "Failed to install PHP X.Y" хотя пакеты на самом деле доставились
    // (timer убивает только callback, не процесс apt). 900s = 600s apt + 300s
    // на ensurePhpRepository (apt-get update + add-apt-repository) + enable/start.
    //
    // Live-лог: каждая строка stdout/stderr улетает событием php:install:log →
    // API форвардит в комнату клиентам, /php показывает её в drawer'е.
    this.safeOn(s, 'php:install', async (params: { version: string }, cb: Callback) => {
      const onLog = (line: string, stream: 'stdout' | 'stderr') => {
        if (s.connected) s.emit('php:install:log', { version: params.version, line, stream });
      };
      cb(await this.php.installVersion(params.version, onLog));
    }, 900_000);

    this.safeOn(s, 'php:uninstall', async (params: { version: string }, cb: Callback) => {
      const onLog = (line: string, stream: 'stdout' | 'stderr') => {
        if (s.connected) s.emit('php:install:log', { version: params.version, line, stream });
      };
      cb(await this.php.uninstallVersion(params.version, onLog));
    }, 600_000);

    this.safeOn(s, 'php:read-ini', async (params: { version: string }, cb: Callback) => {
      cb(await this.php.readIni(params.version));
    });

    this.safeOn(s, 'php:write-ini', async (params: { version: string; content: string }, cb: Callback) => {
      cb(await this.php.writeIni(params.version, params.content));
    });

    this.safeOn(s, 'php:extensions', async (params: { version: string }, cb: Callback) => {
      cb(await this.php.listExtensions(params.version));
    });

    this.safeOn(s, 'php:extension-install', async (params: { version: string; name: string }, cb: Callback) => {
      const onLog = (line: string, stream: 'stdout' | 'stderr') => {
        if (s.connected) {
          s.emit('php:ext-install:log', {
            version: params.version,
            name: params.name,
            line,
            stream,
          });
        }
      };
      cb(await this.php.installExtension(params.version, params.name, onLog));
    }, 240_000);

    this.safeOn(s, 'php:extension-toggle', async (params: { version: string; name: string; enable: boolean }, cb: Callback) => {
      cb(await this.php.toggleExtension(params.version, params.name, params.enable));
    });

    // -- PM2 --
    this.safeOn(s, 'pm2:start', async (params: { name: string; cwd: string; script: string; env?: Record<string, string>; maxMemory?: string }, cb: Callback) => {
      cb(await this.pm2.start(params));
    });

    this.safeOn(s, 'pm2:stop', async (params: { name: string }, cb: Callback) => {
      cb(await this.pm2.stop(params.name));
    });

    this.safeOn(s, 'pm2:restart', async (params: { name: string }, cb: Callback) => {
      cb(await this.pm2.restart(params.name));
    });

    this.safeOn(s, 'pm2:reload', async (params: { name: string }, cb: Callback) => {
      cb(await this.pm2.reload(params.name));
    });

    this.safeOn(s, 'pm2:delete', async (params: { name: string }, cb: Callback) => {
      cb(await this.pm2.delete(params.name));
    });

    this.safeOn(s, 'pm2:status', async (params: { name: string }, cb: Callback) => {
      cb({ success: true, data: await this.pm2.getProcess(params.name) });
    });

    this.safeOn(s, 'pm2:list', async (_params: unknown, cb: Callback) => {
      cb({ success: true, data: await this.pm2.listProcesses() });
    });

    this.safeOn(s, 'pm2:logs', async (params: { name: string; lines?: number }, cb: Callback) => {
      cb({ success: true, data: await this.pm2.getLogs(params.name, params.lines) });
    });

    // -- Deploy --
    this.safeOn(s, 'deploy:execute', async (params: {
      deployId: string;
      siteType: string;
      rootPath: string;
      gitRepository: string;
      branch: string;
      phpVersion?: string;
      appPort?: number;
      domain: string;
      envVars?: Record<string, string>;
    }, cb: Callback) => {
      const { deployId, ...deployParams } = params;

      const result = await this.deployer.deploy(deployParams, (line) => {
        if (s.connected) {
          s.emit('deploy:log', { deployId, line });
        }
      });

      this.emitOrQueue('deploy:complete', {
        deployId,
        success: result.success,
        commitSha: result.commitSha,
        commitMessage: result.commitMessage,
      });

      cb({ success: true, data: result });
    });

    this.safeOn(s, 'deploy:rollback', async (params: {
      deployId: string;
      rootPath: string;
      commitSha: string;
      siteType: string;
      domain: string;
      phpVersion?: string;
    }, cb: Callback) => {
      const { deployId, ...rollbackParams } = params;

      const result = await this.deployer.rollback(rollbackParams, (line) => {
        if (s.connected) {
          s.emit('deploy:log', { deployId, line });
        }
      });

      this.emitOrQueue('deploy:complete', {
        deployId,
        success: result.success,
        commitSha: result.commitSha,
        commitMessage: result.commitMessage,
      });

      cb({ success: true, data: result });
    });

    // -- Database --
    this.safeOn(s, 'db:detect', async (_params: unknown, cb: Callback) => {
      try {
        cb({ success: true, data: await this.db.detectAvailable() });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'db:create', async (params: { name: string; type: 'MARIADB' | 'MYSQL' | 'POSTGRESQL'; dbUser: string; password: string }, cb: Callback) => {
      try {
        cb(await this.db.createDatabase(params));
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'db:drop', async (params: { name: string; type: string; dbUser: string }, cb: Callback) => {
      try {
        cb(await this.db.dropDatabase(params.name, params.type, params.dbUser));
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'db:reset-password', async (params: { name: string; type: string; dbUser: string; password: string }, cb: Callback) => {
      try {
        cb(await this.db.resetDatabasePassword(params));
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'db:export', async (params: { name: string; type: string }, cb: Callback) => {
      try {
        const res = await this.db.exportDatabase(params.name, params.type);
        // emitToAgent ожидает контракт {success, data, error} — filePath кладём в data.
        if (res.success) {
          cb({ success: true, data: { filePath: res.filePath } });
        } else {
          cb({ success: false, error: res.error });
        }
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'db:import', async (params: { name: string; type: string; filePath: string }, cb: Callback) => {
      try {
        cb(await this.db.importDatabase(params.name, params.type, params.filePath));
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'db:size', async (params: { name: string; type: string }, cb: Callback) => {
      try {
        const size = await this.db.getDatabaseSize(params.name, params.type);
        cb({ success: true, data: { sizeBytes: size } });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    // -- SSL --
    this.safeOn(s, 'ssl:issue', async (params: { domain: string; domains: string[]; rootPath: string; filesRelPath?: string; email?: string }, cb: Callback) => {
      const result = await this.ssl.issueCertificate(params);
      cb(result);
    });

    this.safeOn(s, 'ssl:renew-all', async (_params: unknown, cb: Callback) => {
      cb(await this.ssl.renewAll());
    });

    this.safeOn(s, 'ssl:revoke', async (params: { domain: string }, cb: Callback) => {
      cb(await this.ssl.revokeCertificate(params.domain));
    });

    this.safeOn(s, 'ssl:inspect-existing', async (params: { domain: string }, cb: Callback) => {
      const r = await this.ssl.inspectExisting(params.domain);
      cb({
        success: r.success,
        error: r.error,
        data: { found: r.found, certPath: r.certPath, keyPath: r.keyPath, expiresAt: r.expiresAt },
      });
    });

    this.safeOn(s, 'ssl:install-custom', async (params: { domain: string; certPem: string; keyPem: string; chainPem?: string }, cb: Callback) => {
      cb(await this.ssl.installCustomCertificate(params));
    });

    // -- Panel Access (domain / HTTPS / redirect / deny-ip) --
    this.safeOn(s, 'panel-access:status', async (params: { domain?: string | null; certPath?: string | null }, cb: Callback) => {
      try {
        const r = await this.panelAccess.getStatus(params || {});
        cb(r);
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'panel-access:render-nginx', async (params: {
      domain: string | null;
      certMode: 'NONE' | 'SELFSIGNED' | 'LE';
      certPath: string | null;
      keyPath: string | null;
      httpsRedirect: boolean;
      denyIpAccess: boolean;
    }, cb: Callback) => {
      try {
        const r = await this.panelAccess.renderNginx(params);
        cb(r);
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'panel-access:issue-le', async (params: { domain: string; email: string }, cb: Callback) => {
      try {
        const r = await this.panelAccess.issueLeCert(params);
        cb(r);
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'panel-access:gen-selfsigned', async (_params: unknown, cb: Callback) => {
      try {
        const r = await this.panelAccess.generateSelfSigned();
        cb(r);
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'panel-access:remove-cert', async (params: {
      domain?: string | null;
      certPath?: string | null;
      keyPath?: string | null;
      mode?: 'NONE' | 'SELFSIGNED' | 'LE';
    }, cb: Callback) => {
      try {
        const r = await this.panelAccess.removeCert(params || {});
        cb(r);
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    // -- Backup --
    this.safeOn(s, 'backup:execute', async (params: {
      backupId: string;
      siteId: string;
      siteName: string;
      rootPath: string;
      type: 'FULL' | 'DIFFERENTIAL' | 'FILES_ONLY' | 'DB_ONLY';
      storageType: 'LOCAL' | 'S3' | 'YANDEX_DISK' | 'CLOUD_MAIL_RU';
      excludePaths: string[];
      storageConfig: Record<string, string>;
      databases?: Array<{ name: string; type: string }>;
      baseTimestamp?: string;
      excludeTableData?: string[];
      keepLocalCopy?: boolean;
    }, cb: Callback) => {
      const result = await this.backup.execute(params, (percent) => {
        if (s.connected) {
          s.emit('backup:progress', { backupId: params.backupId, progress: percent });
        }
      });

      this.emitOrQueue('backup:complete', {
        backupId: params.backupId,
        success: result.success,
        filePath: result.filePath,
        sizeBytes: result.sizeBytes,
        error: result.error,
      });

      cb({ success: true, data: result });
    });

    this.safeOn(s, 'backup:restore', async (params: {
      backupId: string;
      siteId: string;
      siteName: string;
      rootPath: string;
      filePath: string;
      storageType: string;
      storageConfig: Record<string, string>;
      databases?: Array<{ name: string; type: string }>;
      baseFilePath?: string;
      baseStorageType?: string;
      baseStorageConfig?: Record<string, string>;
      scope?: 'FILES_AND_DB' | 'FILES_ONLY' | 'DB_ONLY';
      includePaths?: string[];
    }, cb: Callback) => {
      const result = await this.backup.restore(params, (percent) => {
        if (s.connected) {
          s.emit('backup:restore:progress', { backupId: params.backupId, progress: percent });
        }
      });

      this.emitOrQueue('backup:restore:complete', {
        backupId: params.backupId,
        success: result.success,
        error: result.error,
      });

      cb({ success: true, data: result });
    });

    // -- Restic backup engine --
    // Параметры storage: { type: 'LOCAL'|'S3', config: {...}, password: string }
    this.safeOn(s, 'restic:backup', async (params: {
      backupId: string;
      siteName: string;
      rootPath: string;
      type: 'FULL' | 'FILES_ONLY' | 'DB_ONLY';
      excludePaths: string[];
      databases?: Array<{ name: string; type: string }>;
      excludeTableData?: string[];
      storage: ResticStorage;
    }, cb: Callback) => {
      const result = await this.restic.backup(params, (percent) => {
        if (s.connected) {
          s.emit('backup:progress', { backupId: params.backupId, progress: percent });
        }
      });

      this.emitOrQueue('backup:complete', {
        backupId: params.backupId,
        success: result.success,
        // Для Restic путь = snapshotId (чтобы совместимо с тем же событием)
        filePath: result.snapshotId ? `restic:${result.snapshotId}` : '',
        snapshotId: result.snapshotId,
        sizeBytes: result.sizeBytes || 0,
        error: result.error,
      });

      cb({ success: result.success, data: result, error: result.error });
    });

    // -- Restic backup произвольных путей (SERVER_PATH / PANEL_DATA) --
    // Не привязан к сайту: repoName — имя репозитория-папки (из API).
    this.safeOn(s, 'restic:backup-paths', async (params: {
      backupId: string;
      scope: 'SERVER_PATH' | 'PANEL_DATA';
      repoName: string;
      paths: string[];
      excludePaths: string[];
      storage: ResticStorage;
    }, cb: Callback) => {
      const result = await this.restic.backupPaths(
        {
          repoName: params.repoName,
          paths: params.paths,
          excludePaths: params.excludePaths,
          tags: [`scope:${params.scope}`, `repo:${params.repoName}`],
          storage: params.storage,
        },
        (percent) => {
          if (s.connected) {
            s.emit('backup:progress', { backupId: params.backupId, progress: percent });
          }
        },
      );

      // Отдельные complete-события для SERVER_PATH / PANEL_DATA
      const completeEvent =
        params.scope === 'PANEL_DATA' ? 'panel-data:complete' : 'server-path:complete';
      this.emitOrQueue(completeEvent, {
        backupId: params.backupId,
        success: result.success,
        filePath: result.snapshotId ? `restic:${result.snapshotId}` : '',
        snapshotId: result.snapshotId,
        sizeBytes: result.sizeBytes || 0,
        error: result.error,
      });

      cb({ success: result.success, data: result, error: result.error });
    });

    // -- TAR backup произвольных путей (SERVER_PATH / PANEL_DATA) --
    // Создаёт tar.gz архив с указанными путями и загружает в storage.
    this.safeOn(s, 'backup:execute-paths', async (params: {
      backupId: string;
      scope: 'SERVER_PATH' | 'PANEL_DATA';
      archiveName: string;
      paths: string[];
      excludePaths: string[];
      storageType: 'LOCAL' | 'S3' | 'YANDEX_DISK' | 'CLOUD_MAIL_RU';
      storageConfig: Record<string, string>;
    }, cb: Callback) => {
      const result = await this.backup.executePaths(params, (percent) => {
        if (s.connected) {
          s.emit('backup:progress', { backupId: params.backupId, progress: percent });
        }
      });

      const completeEvent =
        params.scope === 'PANEL_DATA' ? 'panel-data:complete' : 'server-path:complete';
      this.emitOrQueue(completeEvent, {
        backupId: params.backupId,
        success: result.success,
        filePath: result.filePath,
        sizeBytes: result.sizeBytes,
        error: result.error,
      });

      cb({ success: true, data: result });
    });

    this.safeOn(s, 'restic:restore', async (params: {
      backupId: string;
      siteName: string;
      snapshotId: string;
      rootPath: string;
      cleanup?: boolean;
      databases?: Array<{ name: string; type: string }>;
      storage: ResticStorage;
      scope?: 'FILES_AND_DB' | 'FILES_ONLY' | 'DB_ONLY';
      includePaths?: string[];
    }, cb: Callback) => {
      const result = await this.restic.restore(params, (percent) => {
        if (s.connected) {
          s.emit('backup:restore:progress', { backupId: params.backupId, progress: percent });
        }
      });

      this.emitOrQueue('backup:restore:complete', {
        backupId: params.backupId,
        success: result.success,
        error: result.error,
      });

      cb({ success: result.success, data: result, error: result.error });
    });

    this.safeOn(s, 'restic:snapshots', async (params: {
      siteName: string;
      storage: ResticStorage;
    }, cb: Callback) => {
      const r = await this.restic.listSnapshots(params.siteName, params.storage);
      cb({ success: r.success, data: { snapshots: r.snapshots || [] }, error: r.error });
    });

    // Листинг первого уровня rootPath в снапшоте — для UI selective restore.
    this.safeOn(s, 'restic:list-tree', async (params: {
      siteName: string;
      snapshotId: string;
      rootPath: string;
      storage: ResticStorage;
    }, cb: Callback) => {
      const r = await this.restic.listTopLevel(params);
      cb({ success: r.success, data: { items: r.items || [] }, error: r.error });
    });

    // Экспорт снапшота в S3 как .tar (для скачивания через pre-signed URL).
    // Длинная задача — может занимать часы для крупных бэкапов. Поэтому
    // НЕ используем callback (socket.io ack), а отдаём результат отдельным
    // event'ом `backup-export:complete`. Если коннект к API дёргается —
    // emitOrQueue додержит событие до восстановления связи.
    this.safeOn(s, 'restic:dump-to-s3', async (params: {
      exportId: string;
      siteName: string;
      snapshotId: string;
      rootPath: string;
      storage: ResticStorage;
      targetKey: string;
    }, cb: Callback) => {
      // Сразу подтверждаем приёмку (это нужно если кто-то вдруг ждёт ack).
      try { cb({ success: true, data: { accepted: true } }); } catch { /* ignore */ }

      // Запускаем долгую работу
      console.log(`[Agent] dump-to-s3 start: export=${params.exportId} key=${params.targetKey}`);
      try {
        const r = await this.restic.dumpToS3(params, (p) => {
          // Прогресс летит к API раз в 5s — там хранится in-memory и отдаётся в polling.
          this.emitOrQueue('backup-export:progress', {
            exportId: params.exportId,
            bytesRead: p.bytesRead,
            bytesUploaded: p.bytesUploaded,
            elapsedMs: p.elapsedMs,
          });
        });
        console.log(`[Agent] dump-to-s3 done: export=${params.exportId} success=${r.success} size=${r.sizeBytes || 0} err=${r.error || ''}`);
        this.emitOrQueue('backup-export:complete', {
          exportId: params.exportId,
          success: r.success,
          sizeBytes: r.sizeBytes,
          error: r.error,
        });
      } catch (err) {
        console.error(`[Agent] dump-to-s3 crash: export=${params.exportId} err=${(err as Error).message}`);
        this.emitOrQueue('backup-export:complete', {
          exportId: params.exportId,
          success: false,
          error: (err as Error).message,
        });
      }
    });

    this.safeOn(s, 'restic:forget', async (params: {
      siteName: string;
      storage: ResticStorage;
      policy: RetentionPolicy;
    }, cb: Callback) => {
      const r = await this.restic.forget(params.siteName, params.storage, params.policy);
      cb({ success: r.success, error: r.error });
    });

    this.safeOn(s, 'restic:delete-snapshot', async (params: {
      siteName: string;
      snapshotId: string;
      storage: ResticStorage;
    }, cb: Callback) => {
      const r = await this.restic.deleteSnapshot(params.siteName, params.snapshotId, params.storage);
      cb({ success: r.success, error: r.error });
    });

    this.safeOn(s, 'restic:test', async (params: {
      siteName: string;
      storage: ResticStorage;
    }, cb: Callback) => {
      const r = await this.restic.testConnection(params.siteName, params.storage);
      cb({ success: r.success, error: r.error });
    });

    // Integrity-check: вызывает `restic check` (опционально с --read-data/subset).
    // Возвращает success/error/durationMs + немного output для показа в UI.
    this.safeOn(s, 'restic:check', async (params: {
      siteName: string;
      storage: ResticStorage;
      readData?: boolean;
      readDataSubset?: string;
    }, cb: Callback) => {
      const r = await this.restic.check(params.siteName, params.storage, {
        readData: params.readData,
        readDataSubset: params.readDataSubset,
      });
      cb({
        success: r.success,
        data: { output: r.output, durationMs: r.durationMs },
        error: r.error,
      });
    });

    // -- Restic diff: snapshot ↔ snapshot --
    this.safeOn(s, 'restic:diff-snapshots', async (params: {
      siteName: string;
      storage: ResticStorage;
      snapshotIdA: string;
      snapshotIdB: string;
    }, cb: Callback) => {
      const r = await this.restic.diffSnapshots(params);
      cb({
        success: r.success,
        data: r.success ? { items: r.items, stats: r.stats } : undefined,
        error: r.error,
      });
    });

    // -- Restic diff: snapshot ↔ live files --
    this.safeOn(s, 'restic:diff-live', async (params: {
      siteName: string;
      storage: ResticStorage;
      snapshotId: string;
      snapshotRoot: string;
      liveRoot: string;
    }, cb: Callback) => {
      const r = await this.restic.diffSnapshotWithLive(params);
      cb({
        success: r.success,
        data: r.success ? { items: r.items, stats: r.stats } : undefined,
        error: r.error,
      });
    });

    // -- Restic diff: содержимое одного файла между двумя снапами --
    this.safeOn(s, 'restic:diff-file', async (params: {
      siteName: string;
      storage: ResticStorage;
      snapshotIdA: string;
      snapshotIdB: string;
      filePath: string;
    }, cb: Callback) => {
      const r = await this.restic.diffFileBetweenSnapshots(params);
      cb({
        success: r.success,
        data: r.success ? {
          binary: r.binary,
          sizeA: r.sizeA,
          sizeB: r.sizeB,
          unifiedDiff: r.unifiedDiff,
          truncated: r.truncated,
        } : undefined,
        error: r.error,
      });
    });

    // -- Restic diff: содержимое файла vs live (текущая ФС) --
    this.safeOn(s, 'restic:diff-file-live', async (params: {
      siteName: string;
      storage: ResticStorage;
      snapshotId: string;
      snapshotFilePath: string;
      livePath: string;
    }, cb: Callback) => {
      const r = await this.restic.diffFileWithLive(params);
      cb({
        success: r.success,
        data: r.success ? {
          binary: r.binary,
          sizeA: r.sizeA,
          sizeB: r.sizeB,
          unifiedDiff: r.unifiedDiff,
          truncated: r.truncated,
        } : undefined,
        error: r.error,
      });
    });

    // -- Backup file deletion --
    this.safeOn(s, 'backup:delete-file', async (params: { filePath: string }, cb: Callback) => {
      try {
        // Safety: only allow deletion under configured BACKUP_LOCAL_PATH.
        // Дополнительно резолвим симлинки через realpath — иначе злонамеренный
        // симлинк внутри backup-директории может указывать наружу.
        const requested = path.resolve(params.filePath || '');
        if (!isUnderBackupStorage(requested)) {
          cb({ success: false, error: 'Invalid backup path' });
          return;
        }
        let real: string | null = null;
        try {
          real = await fsp.realpath(requested);
        } catch {
          // файла нет — считаем, что уже удалён
          cb({ success: true });
          return;
        }
        if (!isUnderBackupStorage(real)) {
          cb({ success: false, error: 'Invalid backup path (symlink escape)' });
          return;
        }
        await fsp.unlink(real).catch(() => {});
        cb({ success: true });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    // Удаление удалённого бэкапа (Yandex Disk / Cloud Mail.ru).
    // filePath префикс: `yandex-disk:/...` или `cloud-mail-ru:/...`.
    this.safeOn(s, 'backup:delete-remote', async (params: {
      filePath: string;
      storageConfig: Record<string, string>;
    }, cb: Callback) => {
      try {
        const r = await this.backup.deleteRemoteBackup(params.filePath, params.storageConfig || {});
        cb(r);
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    // -- Firewall (UFW) --
    this.safeOn(s, 'firewall:add-rule', async (params: {
      action: 'ALLOW' | 'DENY';
      protocol: 'TCP' | 'UDP' | 'BOTH';
      port?: string | null;
      sourceIp?: string | null;
      comment?: string | null;
    }, cb: Callback) => {
      cb(await this.firewall.addRule(params));
    });

    this.safeOn(s, 'firewall:remove-rule', async (params: {
      action: 'ALLOW' | 'DENY';
      protocol: 'TCP' | 'UDP' | 'BOTH';
      port?: string | null;
      sourceIp?: string | null;
    }, cb: Callback) => {
      cb(await this.firewall.removeRule(params));
    });

    this.safeOn(s, 'firewall:status', async (_params: unknown, cb: Callback) => {
      cb({ success: true, data: await this.firewall.status() });
    });

    // -- Country block (server-level GeoIP блокировка) --
    // apply: переустанавливает все meowbox-управляемые ipset/iptables под
    // переданный набор правил (idempotent, чистит старое автоматически).
    // refresh-db: форсированно скачивает свежие CIDR-zone'ы, не трогая правила.
    // clear: сносит все meowbox-правила (выключение мастер-свитча).
    // status: листинг ipset'ов/правил/дат обновления для UI.
    this.safeOn(s, 'country-block:apply', async (params: {
      rules: CountryBlockRule[];
      sources: CountrySource[];
    }, cb: Callback) => {
      cb(await this.countryBlock.applyRules(params.rules, params.sources));
    }, TIMEOUTS.SOCKET_HANDLER * 4);

    this.safeOn(s, 'country-block:refresh-db', async (params: {
      countries: string[];
      sources: CountrySource[];
    }, cb: Callback) => {
      cb(await this.countryBlock.refreshDatabase(params.countries, params.sources));
    }, TIMEOUTS.SOCKET_HANDLER * 4);

    this.safeOn(s, 'country-block:clear', async (_params: unknown, cb: Callback) => {
      cb(await this.countryBlock.clearAll());
    });

    this.safeOn(s, 'country-block:status', async (_params: unknown, cb: Callback) => {
      cb(await this.countryBlock.status());
    });

    // -- Cron --
    // `user` — Linux-юзер, под которым крутится crontab (per-site изоляция).
    // До миграции schema=root мог быть задан как undefined — в таком случае
    // `CronManager.resolveUser` откатывается на 'root'. Для новых jobs API
    // всегда отдаёт systemUser.
    this.safeOn(s, 'cron:add', async (params: {
      id: string;
      schedule: string;
      command: string;
      enabled: boolean;
      user?: string;
    }, cb: Callback) => {
      cb(await this.cron.addJob(params));
    });

    this.safeOn(s, 'cron:remove', async (params: { id: string; user?: string }, cb: Callback) => {
      cb(await this.cron.removeJob(params.id, params.user));
    });

    this.safeOn(s, 'cron:sync', async (params: {
      jobs: Array<{
        id: string;
        schedule: string;
        command: string;
        enabled: boolean;
        user?: string;
      }>;
      user?: string;
    }, cb: Callback) => {
      cb(await this.cron.syncJobs(params.jobs, params.user));
    });

    this.safeOn(s, 'cron:migrate-from-root', async (params: {
      mapping: Record<string, string>;
    }, cb: Callback) => {
      try {
        const resolve = (id: string) => params.mapping[id];
        const result = await this.cron.migrateFromRoot(resolve);
        cb({ success: true, data: result });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    // -- System User Management --
    this.safeOn(s, 'user:create', async (params: { username: string; homeDir: string; password?: string; filesRelPath?: string }, cb: Callback) => {
      cb(await this.userMgr.createUser(params.username, params.homeDir, params.password, params.filesRelPath));
    });

    this.safeOn(s, 'user:delete', async (params: { username: string }, cb: Callback) => {
      cb(await this.userMgr.deleteUser(params.username));
    });

    this.safeOn(s, 'user:set-ownership', async (params: { username: string; rootPath: string }, cb: Callback) => {
      cb(await this.userMgr.setOwnership(params.username, params.rootPath));
    });

    this.safeOn(s, 'user:set-password', async (params: { username: string; password: string }, cb: Callback) => {
      cb(await this.userMgr.setPassword(params.username, params.password));
    });

    // Смена / создание пароля админа MODX (Revo + 3) через bootstrap MODX_API_MODE.
    // Под капотом: пишем .php-скрипт в /tmp, запускаем его под per-site юзером
    // через `sudo -u <systemUser>` (чтобы кэш MODX не остался под root).
    this.safeOn(s, 'modx:change-admin-password', async (params: {
      rootPath: string;
      filesRelPath?: string;
      phpVersion?: string;
      systemUser?: string;
      username: string;
      password: string;
      createIfMissing?: boolean;
    }, cb: Callback) => {
      try {
        const result = await this.modxPassChanger.run(params);
        cb(result);
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    }, 90_000);

    this.safeOn(s, 'system:user-exists', async (params: { username: string }, cb: Callback) => {
      try {
        const exists = await this.userMgr.userExists(params.username);
        cb({ success: true, data: { exists } });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    // ─────────────────────────────────────────────────────────────────────
    // Migration: hostpanel
    //   Lazy-import чтобы не тащить SSH-bridge в обычные деплои.
    //   Single-flight: одна миграция в один момент времени (см. spec §17.5).
    //   Параллельные probe / run-item на агенте → отказ с понятным сообщением.
    // ─────────────────────────────────────────────────────────────────────
    // Phase 1 — shortlist (быстро, без du -sb / DB sizes / парсинга nginx).
    // Возвращает только список сайтов с базовой инфой для отображения галочек.
    this.safeOn(s, 'migrate:hostpanel:shortlist', async (params: {
      source: import('./migration/hostpanel/types').MigrationSourceCreds;
      migrationId: string;
    }, cb: Callback) => {
      if (this.hostpanelMigrationActive) {
        cb({
          success: false,
          error: `Уже идёт другая миграция (${this.hostpanelMigrationActive}). ` +
            `Дождись её окончания или cancel'и.`,
        });
        return;
      }
      this.hostpanelMigrationActive = `shortlist:${params.migrationId}`;
      try {
        const { runShortlist } = await import('./migration/hostpanel/discover');
        const onLog = (line: string, step?: number, total?: number) => {
          try {
            s.emit('migrate:hostpanel:discover-log', {
              migrationId: params.migrationId,
              line, step, total,
              phase: 'shortlist',
              ts: new Date().toISOString(),
            });
          } catch { /* socket disconnected — shortlist всё равно продолжится */ }
        };
        const result = await runShortlist(params.source, onLog);
        cb({ success: true, data: result });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      } finally {
        this.hostpanelMigrationActive = null;
      }
    }, 300_000);

    // Phase 2 — deep probe только по выбранным сайтам. Тяжёлая часть:
    // du -sb, DB size, парсинг nginx/config.xml/dumper.yaml/php-fpm pool,
    // SSL detect, MODX paths.
    this.safeOn(s, 'migrate:hostpanel:probe-selected', async (params: {
      source: import('./migration/hostpanel/types').MigrationSourceCreds;
      migrationId: string;
      sourceSiteIds: number[];
    }, cb: Callback) => {
      if (this.hostpanelMigrationActive) {
        cb({
          success: false,
          error: `Уже идёт другая миграция (${this.hostpanelMigrationActive}). ` +
            `Дождись её окончания или cancel'и.`,
        });
        return;
      }
      if (!Array.isArray(params.sourceSiteIds) || params.sourceSiteIds.length === 0) {
        cb({ success: false, error: 'Не передан список выбранных sourceSiteIds' });
        return;
      }
      this.hostpanelMigrationActive = `probe:${params.migrationId}`;
      try {
        const { runDeepProbeSelected } = await import('./migration/hostpanel/discover');
        const onLog = (line: string, step?: number, total?: number) => {
          try {
            s.emit('migrate:hostpanel:discover-log', {
              migrationId: params.migrationId,
              line, step, total,
              phase: 'plan',
              ts: new Date().toISOString(),
            });
          } catch { /* socket disconnected */ }
        };
        const result = await runDeepProbeSelected(
          params.source,
          params.sourceSiteIds,
          onLog,
        );
        cb({ success: true, data: result });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      } finally {
        this.hostpanelMigrationActive = null;
      }
    }, 900_000);

    // Backward-compat: старый монолитный probe (shortlist + полный per-site).
    // Если фронт ещё не обновлён — этот handler ловит старые запросы.
    this.safeOn(s, 'migrate:hostpanel:probe', async (params: {
      source: import('./migration/hostpanel/types').MigrationSourceCreds;
      migrationId: string;
    }, cb: Callback) => {
      if (this.hostpanelMigrationActive) {
        cb({
          success: false,
          error: `Уже идёт другая миграция (${this.hostpanelMigrationActive}).`,
        });
        return;
      }
      this.hostpanelMigrationActive = `probe-legacy:${params.migrationId}`;
      try {
        const { runDiscovery } = await import('./migration/hostpanel/discover');
        const onLog = (line: string, step?: number, total?: number) => {
          try {
            s.emit('migrate:hostpanel:discover-log', {
              migrationId: params.migrationId,
              line, step, total,
              ts: new Date().toISOString(),
            });
          } catch { /* socket disconnected */ }
        };
        const result = await runDiscovery(params.source, onLog);
        cb({ success: true, data: result });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      } finally {
        this.hostpanelMigrationActive = null;
      }
    }, 900_000);

    this.safeOn(s, 'migrate:hostpanel:run-item', async (params: {
      migrationId: string;
      itemId: string;
      source: import('./migration/hostpanel/types').MigrationSourceCreds;
    }, cb: Callback) => {
      if (
        this.hostpanelMigrationActive &&
        !this.hostpanelMigrationActive.startsWith(`run:${params.migrationId}`)
      ) {
        cb({
          success: false,
          error: `Уже идёт другая миграция (${this.hostpanelMigrationActive}). ` +
            `Параллельный запуск запрещён.`,
        });
        return;
      }
      this.hostpanelMigrationActive = `run:${params.migrationId}:${params.itemId}`;
      try {
        const { runItem } = await import('./migration/hostpanel/run-item');
        // Plan тащим из БД мастера — но мастер уже передаёт source. Для plan'а
        // придётся слать его в args либо тянуть через отдельный запрос. Пока —
        // просим мастер передавать plan тоже (см. SourceWithPlan).
        const planRequest = (params as unknown as { plan?: import('./migration/hostpanel/types').PlanItem }).plan;
        if (!planRequest) {
          cb({ success: false, error: 'plan не передан в run-item' });
          return;
        }
        // Регистрируем cancel-маркер: если оператор нажмёт cancel —
        // CancelToken взведётся, runItem проверит между стейджами.
        if (this.hostpanelCancelTokens.has(params.migrationId)) {
          cb({ success: false, error: 'Миграция отменена оператором' });
          return;
        }
        const result = await runItem({
          socket: s,
          migrationId: params.migrationId,
          itemId: params.itemId,
          plan: planRequest,
          creds: params.source,
          isCancelled: () => this.hostpanelCancelTokens.has(params.migrationId),
        });
        cb({
          success: result.success,
          error: result.error,
          data: {
            newSiteId: result.newSiteId,
            ssl: result.ssl,
            verifyHttpCode: result.verifyHttpCode,
            // Реальные креды (sftp_pass + mysql_pass + db name/user) — мастер
            // их персистит в Site.sshPassword / Database.dbPasswordEnc. Без
            // этого поля Adminer SSO не подхватит реальный пароль БД, а
            // оператор не увидит SSH-пароль в UI (см. spec §6.2).
            creds: result.creds,
          },
        });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      } finally {
        // Освобождаем флаг ТОЛЬКО если это последний item (мастер сам решает).
        // Чтобы не блокировать следующий item того же migrationId — снимаем сразу.
        this.hostpanelMigrationActive = null;
        // Cancel-token «съедается» текущим run-item'ом: если оператор отменил —
        // остальные items уже либо не запускались (мастер их не вызвал), либо
        // получат свежий токен от следующего cancel. Освобождаем — иначе retry
        // через UI получит «Cancelled» по умолчанию.
        this.hostpanelCancelTokens.delete(params.migrationId);
      }
    }, 12 * 60 * 60 * 1000);

    this.safeOn(s, 'migrate:hostpanel:cancel', async (params: {
      migrationId: string;
    }, cb: Callback) => {
      // Взводим cancel-token. runItem проверяет его:
      //   1) между стейджами — следующий не запустится (через `next()` в run-item);
      //   2) внутри `runStreaming` rsync — каждые 2с — SIGTERM, через 5с SIGKILL;
      //   3) внутри `pipeDump` mysqldump — то же.
      // По сути это hard-cancel для долгих стейджей (3, 5, 11) и soft-cancel
      // для коротких (миллисекундных).
      this.hostpanelCancelTokens.add(params.migrationId);
      cb({ success: true });
    });

    // Check leak: есть ли на slave артефакты с указанным именем
    // (linux-юзер / homedir / mariadb-db). Используется UI на step 4 для
    // решения, показывать ли кнопку «Force-retry». Дешёвый probe.
    this.safeOn(s, 'migrate:hostpanel:check-leak', async (params: {
      name: string;
    }, cb: Callback) => {
      try {
        const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
        if (!NAME_RE.test(params.name)) {
          cb({ success: false, error: `Invalid name: ${params.name}` });
          return;
        }
        const exec = new CommandExecutor();
        const userMgr = new SystemUserManager();

        const userExists = await userMgr.userExists(params.name);

        const homePath = path.join(
          process.env.SITES_BASE_PATH || '/var/www',
          params.name,
        );
        let homeExists = false;
        try {
          await fsp.access(homePath);
          homeExists = true;
        } catch { /* нет — нормально */ }

        let dbExists = false;
        // mariadb может фейлиться (DB не доступна / не запущена) — для проверки
        // существования это валидный сценарий «не существует».
        const dbCheck = await exec.execute('mariadb', [
          '-N', '-B', '-e',
          `SELECT 1 FROM information_schema.schemata WHERE schema_name='${params.name.replace(/'/g, '')}'`,
        ], { allowFailure: true });
        if (dbCheck.exitCode === 0 && dbCheck.stdout.trim() === '1') {
          dbExists = true;
        }
        cb({ success: true, data: { userExists, homeExists, dbExists } });
      } catch (e) {
        cb({ success: false, error: (e as Error).message });
      }
    }, 15_000);

    // Force-cleanup leak'нутых артефактов от падшей/зомби-миграции.
    // Используется UI-кнопкой «Очистить и повторить» на step 4: когда
    // pre-flight упал из-за «Linux-юзер уже существует», но мы знаем,
    // что юзер — leak от предыдущей попытки той же миграции (мастер
    // проверяет на своей стороне).
    //
    // НИКОГДА не вызывается для арбитрарных имён — мастер проверяет, что
    // имя действительно принадлежит leak'у этой миграции (нет conflict'а
    // с running-миграцией и нет Site-записи в БД).
    this.safeOn(s, 'migrate:hostpanel:force-cleanup-name', async (params: {
      name: string;
      domain?: string;
      phpVersion?: string;
    }, cb: Callback) => {
      try {
        const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
        if (!NAME_RE.test(params.name)) {
          cb({ success: false, error: `Invalid name: ${params.name}` });
          return;
        }
        const log: string[] = [];
        const tlog = (s: string) => { log.push(s); };

        // 1) Cron-задачи site-юзера: `crontab -u <user> -r`. Если юзера нет —
        // ничего страшного, дроп user'а ниже всё равно почистит spool. Если
        // юзер ещё есть и крон у него есть — удалим до userdel, чтобы не
        // зависал systemd-cron.
        try {
          const exec = new CommandExecutor();
          await exec.execute('crontab', ['-u', params.name, '-r']).catch(() => {});
          tlog(`crontab: cleared for user '${params.name}'`);
        } catch (e) {
          tlog(`crontab cleanup warn: ${(e as Error).message}`);
        }

        // 2) nginx-конфиг
        try {
          const nginx = new NginxManager();
          await nginx.removeSiteConfig(params.name).catch(() => {});
          tlog(`nginx: removed`);
        } catch (e) {
          tlog(`nginx cleanup warn: ${(e as Error).message}`);
        }

        // 3) php-fpm pool — пробуем все поддерживаемые версии (без знания phpVersion)
        try {
          const fpm = new PhpFpmManager();
          const versions = params.phpVersion
            ? [params.phpVersion]
            : ['8.4', '8.3', '8.2', '8.1', '8.0', '7.4'];
          for (const v of versions) {
            await fpm.removePool(params.name, v).catch(() => {});
          }
          tlog(`php-fpm: pools removed (tried ${versions.length} versions)`);
        } catch (e) {
          tlog(`fpm cleanup warn: ${(e as Error).message}`);
        }

        // 4) MariaDB — DROP DATABASE и DROP USER
        try {
          const dm = new DatabaseManager();
          await dm.dropDatabase(params.name, 'MARIADB', params.name).catch(() => {});
          tlog(`mariadb: dropped database+user '${params.name}'`);
        } catch (e) {
          tlog(`db cleanup warn: ${(e as Error).message}`);
        }

        // 5) SSL — letsencrypt папки если есть домен
        if (params.domain) {
          const exec = new CommandExecutor();
          await exec.execute('rm', ['-rf', `/etc/letsencrypt/live/${params.domain}`]).catch(() => {});
          await exec.execute('rm', ['-rf', `/etc/letsencrypt/archive/${params.domain}`]).catch(() => {});
          await exec.execute('rm', ['-f', `/etc/letsencrypt/renewal/${params.domain}.conf`]).catch(() => {});
          tlog(`ssl: LE artifacts for ${params.domain} removed`);
        }

        // 6) Linux-юзер + домашняя директория
        try {
          const um = new SystemUserManager();
          await um.deleteUser(params.name).catch(() => {});
          const exec = new CommandExecutor();
          // userdel без -r не сносит home; добиваем явно (path under SITES_BASE_PATH)
          const home = path.join(
            process.env.SITES_BASE_PATH || '/var/www',
            params.name,
          );
          if (home.startsWith('/var/www/') && home !== '/var/www/') {
            await exec.execute('rm', ['-rf', home]).catch(() => {});
          }
          tlog(`linux user '${params.name}' removed`);
        } catch (e) {
          tlog(`user cleanup warn: ${(e as Error).message}`);
        }

        cb({ success: true, log });
      } catch (e) {
        cb({ success: false, error: (e as Error).message });
      }
    }, 60_000);

    // Per-user PHP CLI shim — `php` в SSH/SFTP-сессии указывает на нужную версию.
    // phpVersion=null/'' → шим вычищается (ставим, когда PHP на сайте отключён).
    this.safeOn(s, 'user:setup-php-shim', async (params: {
      username: string;
      homeDir: string;
      phpVersion: string | null;
    }, cb: Callback) => {
      cb(await this.userMgr.setupPhpShim(params.username, params.homeDir, params.phpVersion));
    });

    // -- Site files: duplicate (rsync) --
    // Используется при клонировании сайта: копирует содержимое `srcRel`
    // внутри исходного rootPath (обычно `www/`) в такое же место у таргет-сайта,
    // меняет владельца на таргет-юзера (per-site isolation). Safety: обе
    // директории должны лежать под SITES_BASE_PATH.
    this.safeOn(s, 'site:copy-files', async (params: {
      srcRoot: string;
      dstRoot: string;
      dstUser: string;
      relPath?: string; // подкаталог внутри root (default 'www')
    }, cb: Callback) => {
      try {
        const rel = (params.relPath || 'www').replace(/^\/+/, '').replace(/\.\.+/g, '').replace(/\/+$/, '') || 'www';
        const srcAbs = path.resolve(`${params.srcRoot}/${rel}`);
        const dstAbs = path.resolve(`${params.dstRoot}/${rel}`);

        if (!isUnderAllowedSiteRoot(srcAbs) || !isUnderAllowedSiteRoot(dstAbs)) {
          cb({ success: false, error: 'Paths must lie under sites base path' });
          return;
        }

        // Проверяем реальные пути (защита от symlink escape).
        try {
          const realSrc = await fsp.realpath(srcAbs);
          if (!isUnderAllowedSiteRoot(realSrc)) {
            cb({ success: false, error: 'Source path escapes sites base (symlink)' });
            return;
          }
        } catch {
          cb({ success: false, error: `Source directory not found: ${srcAbs}` });
          return;
        }

        // Убедимся, что таргетная директория существует.
        await this.cmdExec.execute('mkdir', ['-p', dstAbs]);

        // rsync: `-a` архив (рекурсия, права, симлинки), `--delete` чтобы
        // гарантировать побайтово такую же картину (таргет создан только что,
        // обычно пустой — но пусть будет явно). Trailing slash у src обязателен,
        // иначе rsync положит srcDir внутрь dstDir.
        const rsync = await this.cmdExec.execute(
          'rsync',
          ['-a', '--delete', `${srcAbs}/`, `${dstAbs}/`],
          { timeout: 600_000, allowFailure: true },
        );
        if (rsync.exitCode !== 0) {
          cb({ success: false, error: rsync.stderr || 'rsync failed' });
          return;
        }

        // Chown под таргет-юзера + group. Владелец файлов = Linux-юзер сайта.
        const owner = `${params.dstUser}:${params.dstUser}`;
        await this.cmdExec.execute('chown', ['-R', owner, params.dstRoot]);

        cb({ success: true });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    // -- DB copy (dump + restore через временный файл, без shell) --
    // Берём дамп source-БД через mysqldump/pg_dump (с `--result-file`/`-f`),
    // затем льём в target-БД через `mysql --execute="source ..."` или
    // `psql -f`. Используется при клонировании сайта с БД. Таргет-БД должна
    // уже существовать (создаётся отдельным шагом db:create). Никаких shell
    // pipe'ов/redirect'ов — всё через аргументы execFile.
    this.safeOn(s, 'db:copy', async (params: {
      srcName: string;
      dstName: string;
      type: 'MARIADB' | 'MYSQL' | 'POSTGRESQL';
    }, cb: Callback) => {
      try {
        // Валидация имён БД (только [a-zA-Z0-9_]).
        const NAME_RE = /^[a-zA-Z0-9_]+$/;
        if (!NAME_RE.test(params.srcName) || !NAME_RE.test(params.dstName)) {
          cb({ success: false, error: 'Invalid database name' });
          return;
        }
        if (params.srcName === params.dstName) {
          cb({ success: false, error: 'Source and target must differ' });
          return;
        }

        // Unique tmp-dir вместо глобального /tmp/name: mkdtemp создаёт приватную
        // (0700) директорию с криптостойким random-suffix'ом. Защищает от
        // гонок/коллизий с другими процессами, которые могут читать /tmp.
        const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'meowbox-dbcopy-'));
        const tmpFile = path.join(tmpDir, 'dump.sql');
        try {
          if (params.type === 'POSTGRESQL') {
            // pg_dump -U postgres -Fp -f /tmp/x.sql srcName
            const dump = await this.cmdExec.execute(
              'pg_dump',
              ['-U', 'postgres', '--no-owner', '--no-privileges', '-Fp', '-f', tmpFile, params.srcName],
              { timeout: 600_000, allowFailure: true },
            );
            if (dump.exitCode !== 0) {
              cb({ success: false, error: dump.stderr || 'pg_dump failed' });
              return;
            }
            // psql -U postgres -d dstName -f /tmp/x.sql
            const restore = await this.cmdExec.execute(
              'psql',
              ['-U', 'postgres', '-d', params.dstName, '-v', 'ON_ERROR_STOP=1', '-f', tmpFile],
              { timeout: 600_000, allowFailure: true },
            );
            if (restore.exitCode !== 0) {
              cb({ success: false, error: restore.stderr || 'psql restore failed' });
              return;
            }
          } else {
            // MySQL/MariaDB — mysqldump --result-file=X; mysql --execute="source X" db
            const dumpCmd = params.type === 'MARIADB' ? 'mariadb-dump' : 'mysqldump';
            const clientCmd = params.type === 'MARIADB' ? 'mariadb' : 'mysql';
            const dump = await this.cmdExec.execute(
              dumpCmd,
              [
                '-u', 'root',
                '--single-transaction', '--quick', '--routines', '--triggers',
                '--no-tablespaces',
                `--result-file=${tmpFile}`,
                params.srcName,
              ],
              { timeout: 600_000, allowFailure: true },
            );
            if (dump.exitCode !== 0) {
              cb({ success: false, error: dump.stderr || 'mysqldump failed' });
              return;
            }
            const restore = await this.cmdExec.execute(
              clientCmd,
              ['-u', 'root', '--execute=source ' + tmpFile, params.dstName],
              { timeout: 600_000, allowFailure: true },
            );
            if (restore.exitCode !== 0) {
              cb({ success: false, error: restore.stderr || 'mysql restore failed' });
              return;
            }
          }
          cb({ success: true });
        } finally {
          // Cleanup (best-effort): удаляем tmp-файл + директорию. Если
          // процесс упал до finally — tmpfiles.d/systemd чистит /tmp при reboot.
          await fsp.unlink(tmpFile).catch(() => {});
          await fsp.rmdir(tmpDir).catch(() => {});
        }
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    // -- Site File Cleanup --
    this.safeOn(s, 'site:remove-files', async (params: { rootPath: string }, cb: Callback) => {
      try {
        // Safety: only allow removal under configured site-root prefixes.
        // Резолвим realpath чтобы симлинк `rootPath → /etc` не обошёл проверку.
        const requested = path.resolve(params.rootPath || '');
        if (!isUnderAllowedSiteRoot(requested)) {
          cb({ success: false, error: 'Invalid root path for removal' });
          return;
        }
        let real: string;
        try {
          real = await fsp.realpath(requested);
        } catch {
          // Директория уже отсутствует — считаем удалённой.
          cb({ success: true });
          return;
        }
        if (!isUnderAllowedSiteRoot(real)) {
          cb({ success: false, error: 'Invalid root path (symlink escape)' });
          return;
        }
        await this.cmdExec.execute('rm', ['-rf', real]);
        cb({ success: true });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    // -- Site Install --
    this.safeOn(s, 'site:install', async (params: {
      siteId?: string;
      siteType: string;
      rootPath: string;
      filesRelPath?: string;
      domain: string;
      phpVersion?: string;
      modxVersion?: string;
      appPort?: number;
      dbName?: string;
      dbUser?: string;
      dbPassword?: string;
      dbType?: 'MARIADB' | 'MYSQL' | 'POSTGRESQL';
      adminUser?: string;
      adminPassword?: string;
      adminEmail?: string;
      systemUser?: string;
      managerPath?: string;
      connectorsPath?: string;
    }, cb: Callback) => {
      try {
        let result: { success: boolean; error?: string; version?: string };

        const onLog = (line: string) => {
          if (s.connected) {
            s.emit('site:install:log', {
              siteId: params.siteId,
              domain: params.domain,
              line,
            });
          }
        };

        const modxParams = {
          rootPath: params.rootPath,
          filesRelPath: params.filesRelPath,
          domain: params.domain,
          phpVersion: params.phpVersion || DEFAULT_PHP_VERSION,
          modxVersion: params.modxVersion,
          dbName: params.dbName || '',
          dbUser: params.dbUser || '',
          dbPassword: params.dbPassword || '',
          dbType: (params.dbType || 'MARIADB') as 'MARIADB' | 'MYSQL' | 'POSTGRESQL',
          adminUser: params.adminUser,
          adminPassword: params.adminPassword,
          adminEmail: params.adminEmail,
          systemUser: params.systemUser,
          managerPath: params.managerPath || 'manager',
          connectorsPath: params.connectorsPath || 'connectors',
        };

        switch (params.siteType) {
          case 'MODX_REVO':
            // MODX Revolution 2.x — только ZIP + CLI setup (composer-пакета нет)
            result = await this.installer.installModxRevo(modxParams, onLog);
            break;

          case 'MODX_3':
            // MODX 3 — composer create-project (нативный способ), fallback на ZIP
            result = await this.installer.installModx3(modxParams, onLog);
            break;

          case 'CUSTOM':
          default: {
            // CUSTOM (пустой шаблон): {filesRelPath}/ + index.html placeholder.
            result = await this.installer.scaffoldCustomSite(
              params.rootPath,
              params.domain,
              onLog,
              params.systemUser,
              params.filesRelPath,
            );
          }
        }

        // Оборачиваем version в data — API ждёт формат {success, error, data}.
        cb({
          success: result.success,
          error: result.error,
          data: result.version ? { version: result.version } : undefined,
        });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    // -- Site Update (MODX upgrade) --
    this.safeOn(s, 'site:update-modx', async (params: {
      siteId?: string;
      siteType: 'MODX_REVO' | 'MODX_3';
      rootPath: string;
      filesRelPath?: string;
      phpVersion?: string;
      targetVersion: string;
      domain: string;
      systemUser?: string;
      managerPath?: string;
      connectorsPath?: string;
    }, cb: Callback) => {
      try {
        const onLog = (line: string) => {
          if (s.connected) {
            s.emit('site:install:log', {
              siteId: params.siteId,
              domain: params.domain,
              line,
            });
          }
        };

        const updateParams = {
          rootPath: params.rootPath,
          filesRelPath: params.filesRelPath,
          phpVersion: params.phpVersion || DEFAULT_PHP_VERSION,
          targetVersion: params.targetVersion,
          systemUser: params.systemUser,
          managerPath: params.managerPath,
          connectorsPath: params.connectorsPath,
        };

        let result;
        if (params.siteType === 'MODX_3') {
          result = await this.installer.updateModx3(updateParams, onLog);
        } else {
          result = await this.installer.updateModxRevo(updateParams, onLog);
        }
        cb({
          success: result.success,
          error: result.error,
          data: result.version ? { version: result.version } : undefined,
        });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    // -- Site permissions normalization --
    // Универсальный fix прав/владельца. Применим для любого сайта (не только
    // MODX). Логика: chown -R systemUser, chmod -R u=rwX,g=rX,o-rwx (X сохраняет
    // exec на бинарниках в node_modules/.bin), а для MODX дополнительно
    // расширяет writable cache/export/packages/assets до g+w.
    this.safeOn(s, 'site:normalize-permissions', async (params: {
      rootPath: string;
      filesRelPath?: string;
      systemUser: string;
      siteType?: string; // если MODX_* — расширяем права на core/cache и т.п.
    }, cb: Callback) => {
      try {
        if (!isUnderAllowedSiteRoot(params.rootPath)) {
          cb({ success: false, error: `rootPath вне разрешённой базы: ${params.rootPath}` });
          return;
        }
        const wwwDir = path.join(
          params.rootPath,
          (params.filesRelPath || 'www').replace(/^\/+|\/+$/g, '').replace(/\.\.+/g, ''),
        );

        // Для MODX-сайтов резолвим path до core (могут перенести/переименовать).
        let modxCorePath: string | undefined;
        if (params.siteType && params.siteType.startsWith('MODX')) {
          modxCorePath = await this.permsMgr.resolveModxCorePath(wwwDir);
        }

        const result = await this.permsMgr.normalize({
          rootPath: params.rootPath,
          filesRelPath: params.filesRelPath,
          systemUser: params.systemUser,
          modxCorePath,
        });
        cb({
          success: result.success,
          error: result.error,
          data: { steps: result.steps, modxCorePath },
        });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    // -- MODX Doctor: read-only диагностика типовых проблем --
    this.safeOn(s, 'site:modx-doctor', async (params: {
      rootPath: string;
      filesRelPath?: string;
      systemUser?: string;
      managerPath?: string;
      connectorsPath?: string;
    }, cb: Callback) => {
      try {
        if (!isUnderAllowedSiteRoot(params.rootPath)) {
          cb({ success: false, error: `rootPath вне разрешённой базы: ${params.rootPath}` });
          return;
        }
        const result = await this.modxDoctor.diagnose(params);
        cb({ success: result.success, error: result.error, data: result });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    // -- Удалить setup/ директорию (fix для setup-dir-exposed issue) --
    this.safeOn(s, 'site:cleanup-setup-dir', async (params: {
      rootPath: string;
      filesRelPath?: string;
    }, cb: Callback) => {
      try {
        if (!isUnderAllowedSiteRoot(params.rootPath)) {
          cb({ success: false, error: `rootPath вне разрешённой базы: ${params.rootPath}` });
          return;
        }
        const wwwDir = path.join(
          params.rootPath,
          (params.filesRelPath || 'www').replace(/^\/+|\/+$/g, '').replace(/\.\.+/g, ''),
        );
        const setupDir = path.join(wwwDir, 'setup');
        // Доп. проверка границ: setupDir обязан быть под wwwDir.
        if (!setupDir.startsWith(wwwDir + path.sep)) {
          cb({ success: false, error: 'setupDir вышел за пределы wwwDir' });
          return;
        }
        try {
          await fsp.access(setupDir);
        } catch {
          cb({ success: true, data: { removed: false, reason: 'не существует' } });
          return;
        }
        // fs.rm с force handles root-owned files (мы под root)
        await fsp.rm(setupDir, { recursive: true, force: true });
        cb({ success: true, data: { removed: true, path: setupDir } });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    // -- File Manager --
    this.safeOn(s, 'file:list', async (params: { rootPath: string; path: string }, cb: Callback) => {
      cb(await this.fileMgr.list(params.rootPath, params.path));
    });

    this.safeOn(s, 'file:read', async (params: { rootPath: string; path: string }, cb: Callback) => {
      cb(await this.fileMgr.read(params.rootPath, params.path));
    });

    this.safeOn(s, 'file:write', async (params: { rootPath: string; path: string; content: string }, cb: Callback) => {
      cb(await this.fileMgr.write(params.rootPath, params.path, params.content));
    });

    this.safeOn(s, 'file:create', async (params: { rootPath: string; path: string; type: 'file' | 'directory' }, cb: Callback) => {
      cb(await this.fileMgr.create(params.rootPath, params.path, params.type));
    });

    this.safeOn(s, 'file:delete', async (params: { rootPath: string; path: string }, cb: Callback) => {
      cb(await this.fileMgr.remove(params.rootPath, params.path));
    });

    this.safeOn(s, 'file:rename', async (params: { rootPath: string; oldPath: string; newPath: string }, cb: Callback) => {
      cb(await this.fileMgr.rename(params.rootPath, params.oldPath, params.newPath));
    });

    // -- Terminal (PTY) --
    this.safeOn(s, 'terminal:open', async (params: { cols?: number; rows?: number; user?: string }, cb: Callback) => {
      try {
        // Жёсткая валидация размеров: socket.io не делает type-check, может прийти
        // NaN, отрицательное, дробное или гигантское значение → node-pty уйдёт в UB.
        const cols = Number.isInteger(params.cols) && params.cols! >= 1 && params.cols! <= 1000 ? params.cols! : 80;
        const rows = Number.isInteger(params.rows) && params.rows! >= 1 && params.rows! <= 1000 ? params.rows! : 24;
        const sessionId = this.terminal.open(
          (sid, data) => {
            if (s.connected) {
              s.emit('terminal:data', { sessionId: sid, data });
            }
          },
          cols,
          rows,
          params.user,
        );
        cb({ success: true, data: { sessionId } });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'terminal:input', async (params: { sessionId: string; data: string }, cb?: Callback) => {
      const ok = this.terminal.write(params.sessionId, params.data);
      if (typeof cb === 'function') {
        cb({ success: ok });
      }
    });

    this.safeOn(s, 'terminal:resize', async (params: { sessionId: string; cols: number; rows: number }, cb?: Callback) => {
      // Те же границы что и в open — защита от мусорных значений.
      if (!Number.isInteger(params.cols) || !Number.isInteger(params.rows) ||
          params.cols < 1 || params.cols > 1000 || params.rows < 1 || params.rows > 1000) {
        if (typeof cb === 'function') cb({ success: false, error: 'Invalid terminal size' });
        return;
      }
      const ok = this.terminal.resize(params.sessionId, params.cols, params.rows);
      if (typeof cb === 'function') {
        cb({ success: ok });
      }
    });

    this.safeOn(s, 'terminal:close', async (params: { sessionId: string }, cb?: Callback) => {
      this.terminal.close(params.sessionId);
      if (typeof cb === 'function') {
        cb({ success: true });
      }
    });

    // -- System --
    this.safeOn(s, 'system:metrics', async (_params: unknown, cb?: Callback) => {
      if (typeof cb === 'function') {
        cb({ success: true, data: await this.metrics.collect() });
      }
    });

    // -- Updates --
    this.safeOn(s, 'updates:check', async (_params: unknown, cb: Callback) => {
      cb(await this.updateMgr.check());
    });

    this.safeOn(s, 'updates:install', async (params: { packages: string[] }, cb: Callback) => {
      cb(await this.updateMgr.installPackages(params.packages));
    });

    this.safeOn(s, 'updates:upgrade-all', async (_params: unknown, cb: Callback) => {
      cb(await this.updateMgr.upgradeAll());
    });

    this.safeOn(s, 'updates:versions', async (_params: unknown, cb: Callback) => {
      cb(await this.updateMgr.getVersions());
    });

    this.safeOn(s, 'updates:self-update', async (_params: unknown, cb: Callback) => {
      cb(await this.updateMgr.selfUpdate());
    });

    // -- Site Metrics --
    this.safeOn(s, 'site:metrics', async (params: { systemUser: string; rootPath: string; siteType: string; phpVersion?: string; appPort?: number; domain: string }, cb: Callback) => {
      cb(await this.siteMetrics.collect(params));
    });

    // -- Storage --
    this.safeOn(s, 'site:storage', async (params: { rootPath: string; filesRelPath?: string }, cb: Callback) => {
      cb(await this.siteMetrics.getStorageBreakdown(params));
    });

    this.safeOn(s, 'site:top-files', async (params: { rootPath: string; limit?: number; filesRelPath?: string }, cb: Callback) => {
      cb(await this.siteMetrics.getTopFiles(params));
    });

    this.safeOn(s, 'server:disk', async (_params: unknown, cb: Callback) => {
      cb(await this.siteMetrics.getServerDiskUsage());
    });

    // -- Site Logs --
    this.safeOn(s, 'site:logs', async (params: { systemUser: string; domain: string; type: 'access' | 'error' | 'php' | 'app'; siteName?: string; lines?: number }, cb: Callback) => {
      cb(await this.logReader.read(params));
    });

    this.safeOn(s, 'site:logs:available', async (params: { systemUser: string; domain: string; siteName?: string }, cb: Callback) => {
      cb(await this.logReader.listAvailable(params));
    });

    // -- System Logs --
    this.safeOn(s, 'logs:system', async (params: { service: string; type: string; lines?: number }, cb: Callback) => {
      cb(await this.logReader.readSystemLog(params));
    });

    this.safeOn(s, 'logs:system:sources', async (_params: unknown, cb: Callback) => {
      cb({ success: true, data: this.logReader.getSystemSources() });
    });

    // -- Log Tail (real-time streaming) --
    this.safeOn(s, 'logs:tail:start', async (params: { tailId: string; filePath: string }, cb: Callback) => {
      const result = this.tailManager.startTail(params.tailId, params.filePath, (line) => {
        if (s.connected) {
          s.emit('logs:tail:data', { tailId: params.tailId, line });
        }
      });
      cb(result);
    });

    this.safeOn(s, 'logs:tail:stop', async (params: { tailId: string }, cb: Callback) => {
      const stopped = this.tailManager.stopTail(params.tailId);
      cb({ success: stopped });
    });

    // -- Reconciliation --
    this.safeOn(s, 'reconcile:check', async (params: {
      deploys: Array<{ deployId: string; rootPath: string; branch: string }>;
      backups: Array<{ backupId: string; filePath: string; storageType: string }>;
    }) => {
      console.log(`[Agent] Reconciling: ${params.deploys.length} deploy(s), ${params.backups.length} backup(s)`);

      const deployResults: Array<{
        deployId: string;
        found: boolean;
        commitSha?: string;
        commitMessage?: string;
      }> = [];

      for (const d of params.deploys) {
        try {
          // Git репо у деплоя живёт прямо в rootPath (см. deploy.executor.ts —
          // `git clone … rootPath`, проверка `path.join(rootPath, '.git')`).
          // НЕ в `${rootPath}/www` — это был ошибочный хардкод, который ломал
          // reconcile у любого сайта с filesRelPath != 'www'.
          // git может фейлиться (нет .git, нет HEAD на свежем clone) — для reconcile это валидно.
          const shaRes = await this.cmdExec.execute('git', ['rev-parse', 'HEAD'], { cwd: d.rootPath, allowFailure: true });
          const msgRes = await this.cmdExec.execute('git', ['log', '-1', '--format=%s'], { cwd: d.rootPath, allowFailure: true });
          if (shaRes.exitCode === 0) {
            deployResults.push({
              deployId: d.deployId,
              found: true,
              commitSha: shaRes.stdout.trim(),
              commitMessage: msgRes.stdout.trim(),
            });
          } else {
            deployResults.push({ deployId: d.deployId, found: false });
          }
        } catch {
          deployResults.push({ deployId: d.deployId, found: false });
        }
      }

      const backupResults: Array<{
        backupId: string;
        found: boolean;
        filePath?: string;
        sizeBytes?: number;
      }> = [];

      for (const b of params.backups) {
        try {
          if (b.storageType === 'LOCAL' && b.filePath && fs.existsSync(b.filePath)) {
            const stats = fs.statSync(b.filePath);
            backupResults.push({
              backupId: b.backupId,
              found: true,
              filePath: b.filePath,
              sizeBytes: Number(stats.size),
            });
          } else {
            backupResults.push({ backupId: b.backupId, found: false });
          }
        } catch {
          backupResults.push({ backupId: b.backupId, found: false });
        }
      }

      this.emitOrQueue('reconcile:result', { deploys: deployResults, backups: backupResults });
    });

    // -- Site Health Check --
    // -- Services: Manticore --
    this.safeOn(s, 'manticore:server-status', async (_params: unknown, cb: Callback) => {
      try {
        const data = await this.manticore.serverStatus();
        cb({ success: true, data });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'manticore:server-install', async (_params: unknown, cb: Callback) => {
      try {
        const data = await this.manticore.serverInstall();
        cb({ success: true, data });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    }, 600_000);

    this.safeOn(s, 'manticore:server-uninstall', async (_params: unknown, cb: Callback) => {
      try {
        await this.manticore.serverUninstall();
        cb({ success: true });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    }, 300_000);

    this.safeOn(s, 'manticore:site-enable', async (params: { siteName: string; systemUser: string; rootPath: string; memoryMaxMb: number }, cb: Callback) => {
      try {
        await this.manticore.siteEnable(params);
        cb({ success: true });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'manticore:site-disable', async (params: { siteName: string; systemUser?: string; rootPath?: string }, cb: Callback) => {
      try {
        await this.manticore.siteDisable(params);
        cb({ success: true });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'manticore:site-start', async (params: { siteName: string }, cb: Callback) => {
      try {
        await this.manticore.siteStart(params);
        cb({ success: true });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'manticore:site-stop', async (params: { siteName: string }, cb: Callback) => {
      try {
        await this.manticore.siteStop(params);
        cb({ success: true });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'manticore:site-status', async (params: { siteName: string }, cb: Callback) => {
      try {
        const data = await this.manticore.siteStatus(params);
        cb({ success: true, data });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'manticore:site-metrics', async (params: { siteName: string; rootPath: string }, cb: Callback) => {
      try {
        const data = await this.manticore.siteMetrics(params);
        cb({ success: true, data });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'manticore:site-logs', async (params: { siteName: string; rootPath: string; lines?: number }, cb: Callback) => {
      try {
        const data = await this.manticore.siteLogs({
          siteName: params.siteName,
          rootPath: params.rootPath,
          lines: params.lines || 200,
        });
        cb({ success: true, data });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'manticore:site-reconfigure', async (params: { siteName: string; memoryMaxMb: number }, cb: Callback) => {
      try {
        await this.manticore.siteReconfigure(params.siteName, params.memoryMaxMb);
        cb({ success: true });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    // -- Services: Redis --
    // -- Services: MariaDB engine (global) --
    this.safeOn(s, 'mariadb:server-status', async (_params: unknown, cb: Callback) => {
      try {
        const data = await this.mariadbEngine.status();
        cb({ success: true, data });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'mariadb:server-install', async (_params: unknown, cb: Callback) => {
      try {
        const data = await this.mariadbEngine.install();
        cb({ success: true, data });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    }, 600_000);

    this.safeOn(s, 'mariadb:server-uninstall', async (_params: unknown, cb: Callback) => {
      try {
        await this.mariadbEngine.uninstall();
        cb({ success: true });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    }, 300_000);

    // -- Services: PostgreSQL engine (global) --
    this.safeOn(s, 'postgresql:server-status', async (_params: unknown, cb: Callback) => {
      try {
        const data = await this.postgresqlEngine.status();
        cb({ success: true, data });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'postgresql:server-install', async (_params: unknown, cb: Callback) => {
      try {
        const data = await this.postgresqlEngine.install();
        cb({ success: true, data });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    }, 600_000);

    this.safeOn(s, 'postgresql:server-uninstall', async (_params: unknown, cb: Callback) => {
      try {
        await this.postgresqlEngine.uninstall();
        cb({ success: true });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    }, 300_000);

    this.safeOn(s, 'redis:server-status', async (_params: unknown, cb: Callback) => {
      try {
        const data = await this.redisSvc.serverStatus();
        cb({ success: true, data });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'redis:server-install', async (_params: unknown, cb: Callback) => {
      try {
        const data = await this.redisSvc.serverInstall();
        cb({ success: true, data });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    }, 600_000);

    this.safeOn(s, 'redis:server-uninstall', async (_params: unknown, cb: Callback) => {
      try {
        await this.redisSvc.serverUninstall();
        cb({ success: true });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    }, 300_000);

    this.safeOn(s, 'redis:site-enable', async (params: { siteName: string; systemUser: string; rootPath: string; memoryMaxMb: number }, cb: Callback) => {
      try {
        await this.redisSvc.siteEnable(params);
        cb({ success: true });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'redis:site-disable', async (params: { siteName: string; systemUser?: string; rootPath?: string }, cb: Callback) => {
      try {
        await this.redisSvc.siteDisable(params);
        cb({ success: true });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'redis:site-start', async (params: { siteName: string }, cb: Callback) => {
      try {
        await this.redisSvc.siteStart(params);
        cb({ success: true });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'redis:site-stop', async (params: { siteName: string }, cb: Callback) => {
      try {
        await this.redisSvc.siteStop(params);
        cb({ success: true });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'redis:site-status', async (params: { siteName: string }, cb: Callback) => {
      try {
        const data = await this.redisSvc.siteStatus(params);
        cb({ success: true, data });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'redis:site-metrics', async (params: { siteName: string; rootPath: string }, cb: Callback) => {
      try {
        const data = await this.redisSvc.siteMetrics(params);
        cb({ success: true, data });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'redis:site-logs', async (params: { siteName: string; rootPath: string; lines?: number }, cb: Callback) => {
      try {
        const data = await this.redisSvc.siteLogs({
          siteName: params.siteName,
          rootPath: params.rootPath,
          lines: params.lines || 200,
        });
        cb({ success: true, data });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'redis:site-reconfigure', async (params: { siteName: string; memoryMaxMb: number }, cb: Callback) => {
      try {
        await this.redisSvc.siteReconfigure(params.siteName, params.memoryMaxMb);
        cb({ success: true });
      } catch (err) {
        cb({ success: false, error: (err as Error).message });
      }
    });

    this.safeOn(s, 'site:health-check', async (params: { domain: string; port?: number | null }, cb: Callback) => {
      try {
        const http = await import('http');
        const start = Date.now();
        const result = await new Promise<{ reachable: boolean; statusCode: number | null; responseTimeMs: number }>((resolve) => {
          // Always check via 127.0.0.1 with Host header — avoids external DNS resolution issues.
          // Валидация порта: socket.io пропустит "abc"/null/65536 — нужно отсечь до http.get.
          const rawPort = params.port;
          const port = Number.isInteger(rawPort) && (rawPort as number) > 0 && (rawPort as number) < 65536
            ? (rawPort as number)
            : 80;
          const req = http.get({
            hostname: '127.0.0.1',
            port,
            path: '/',
            headers: { Host: params.domain },
            timeout: 5000,
          }, (res) => {
            res.resume();
            resolve({ reachable: true, statusCode: res.statusCode ?? null, responseTimeMs: Date.now() - start });
          });
          req.on('error', () => resolve({ reachable: false, statusCode: null, responseTimeMs: Date.now() - start }));
          req.on('timeout', () => { req.destroy(); resolve({ reachable: false, statusCode: null, responseTimeMs: Date.now() - start }); });
        });
        cb({ success: true, data: result });
      } catch {
        cb({ success: true, data: { reachable: false, statusCode: null, responseTimeMs: 0 } });
      }
    });

    // -- VPN: VLESS+Reality (Xray) --
    // См. docs/specs/2026-05-09-vpn-management.md.
    this.safeOn(s, 'vpn:reality:install', async (params: { serviceId: string; port: number; sniMask: string }, cb: Callback) => {
      const result = await this.xrayMgr.install(params);
      cb({ success: true, data: result });
    });
    this.safeOn(s, 'vpn:reality:uninstall', async (params: { serviceId: string; port: number }, cb: Callback) => {
      await this.xrayMgr.uninstall(params.serviceId, params.port);
      cb({ success: true });
    });
    this.safeOn(s, 'vpn:reality:start', async (params: { serviceId: string }, cb: Callback) => {
      await this.xrayMgr.start(params.serviceId);
      cb({ success: true });
    });
    this.safeOn(s, 'vpn:reality:stop', async (params: { serviceId: string }, cb: Callback) => {
      await this.xrayMgr.stop(params.serviceId);
      cb({ success: true });
    });
    this.safeOn(s, 'vpn:reality:status', async (params: { serviceId: string }, cb: Callback) => {
      const active = await this.xrayMgr.statusActive(params.serviceId);
      cb({ success: true, data: { active } });
    });
    this.safeOn(s, 'vpn:reality:add-user', async (params: { serviceId: string; uuid: string; name: string }, cb: Callback) => {
      // XrayManager сам мержит config.json (читается с диска), отдельный
      // config в params не нужен.
      await this.xrayMgr.addUser(params);
      cb({ success: true });
    });
    this.safeOn(s, 'vpn:reality:remove-user', async (params: { serviceId: string; uuid: string }, cb: Callback) => {
      await this.xrayMgr.removeUser(params);
      cb({ success: true });
    });
    this.safeOn(s, 'vpn:reality:rotate-sni', async (params: { serviceId: string; newSni: string }, cb: Callback) => {
      await this.xrayMgr.rotateSni(params.serviceId, params.newSni);
      cb({ success: true });
    });
    this.safeOn(s, 'vpn:reality:rotate-keys', async (params: { serviceId: string }, cb: Callback) => {
      const data = await this.xrayMgr.rotateKeys(params.serviceId);
      cb({ success: true, data });
    });
    this.safeOn(s, 'vpn:reality:validate-sni', async (params: { sniMask: string }, cb: Callback) => {
      const result = await this.xrayMgr.validateSni(params.sniMask);
      cb({ success: true, data: result });
    });

    // -- VPN: AmneziaWG --
    this.safeOn(s, 'vpn:awg:install', async (params: { serviceId: string; port: number; network: string; dns: string[]; mtu: number }, cb: Callback) => {
      const result = await this.amneziaMgr.install(params);
      cb({ success: true, data: result });
    });
    this.safeOn(s, 'vpn:awg:uninstall', async (params: { serviceId: string; port: number }, cb: Callback) => {
      await this.amneziaMgr.uninstall(params.serviceId, params.port);
      cb({ success: true });
    });
    this.safeOn(s, 'vpn:awg:start', async (params: { serviceId: string }, cb: Callback) => {
      await this.amneziaMgr.start(params.serviceId);
      cb({ success: true });
    });
    this.safeOn(s, 'vpn:awg:stop', async (params: { serviceId: string }, cb: Callback) => {
      await this.amneziaMgr.stop(params.serviceId);
      cb({ success: true });
    });
    this.safeOn(s, 'vpn:awg:status', async (params: { serviceId: string }, cb: Callback) => {
      const active = await this.amneziaMgr.statusActive(params.serviceId);
      cb({ success: true, data: { active } });
    });
    this.safeOn(s, 'vpn:awg:gen-peer', async (_params: Record<string, never>, cb: Callback) => {
      // Сгенерим peer keypair + psk на агенте — приватный ключ peer'а
      // никогда не должен лежать на API в plaintext, но т.к. БД API
      // всё равно его хранит зашифрованным — генерим тут и возвращаем.
      const kp = await this.amneziaMgr.generateKeypair();
      const psk = await this.amneziaMgr.generatePsk();
      cb({ success: true, data: { peerPriv: kp.priv, peerPub: kp.pub, peerPsk: psk } });
    });
    this.safeOn(s, 'vpn:awg:add-user', async (params: { serviceId: string; peerPub: string; peerPsk: string; peerIp: string; name: string }, cb: Callback) => {
      await this.amneziaMgr.addUser(params);
      cb({ success: true });
    });
    this.safeOn(s, 'vpn:awg:remove-user', async (params: { serviceId: string; peerPub: string }, cb: Callback) => {
      await this.amneziaMgr.removeUser(params);
      cb({ success: true });
    });
    this.safeOn(s, 'vpn:awg:rotate-keys', async (params: { serviceId: string }, cb: Callback) => {
      const data = await this.amneziaMgr.rotateKeys(params.serviceId);
      cb({ success: true, data });
    });

    // -- VPN: установка runtime'ов (по кнопке на /vpn) --
    this.safeOn(s, 'vpn:installer:status', async (_p: Record<string, never>, cb: Callback) => {
      const [xray, amnezia] = await Promise.all([
        this.vpnInstaller.getXrayStatus(),
        this.vpnInstaller.getAmneziaStatus(),
      ]);
      cb({ success: true, data: { xray, amnezia } });
    });
    this.safeOn(s, 'vpn:installer:install-xray', async (_p: Record<string, never>, cb: Callback) => {
      const data = await this.vpnInstaller.installXray();
      cb({ success: true, data });
    }, 600_000);
    this.safeOn(s, 'vpn:installer:uninstall-xray', async (_p: Record<string, never>, cb: Callback) => {
      await this.vpnInstaller.uninstallXray();
      cb({ success: true });
    }, 60_000);
    this.safeOn(s, 'vpn:installer:install-amnezia', async (_p: Record<string, never>, cb: Callback) => {
      const data = await this.vpnInstaller.installAmnezia();
      cb({ success: true, data });
    }, 600_000);
    this.safeOn(s, 'vpn:installer:uninstall-amnezia', async (_p: Record<string, never>, cb: Callback) => {
      await this.vpnInstaller.uninstallAmnezia();
      cb({ success: true });
    }, 600_000);

    // -- Общие порты-проверки и host detect для UI --
    this.safeOn(s, 'vpn:port-busy', async (params: { port: number; proto: 'tcp' | 'udp' }, cb: Callback) => {
      try {
        const flag = params.proto === 'tcp' ? '-ltn' : '-lun';
        const { stdout } = await this.cmdExec.execute('ss', [flag]);
        const re = new RegExp(`:${params.port}\\s`);
        cb({ success: true, data: { busy: re.test(stdout) } });
      } catch {
        cb({ success: true, data: { busy: false } });
      }
    });
    this.safeOn(s, 'vpn:host-info', async (_params: Record<string, never>, cb: Callback) => {
      // Возвращает публичный IP сервера (через первичный default-route IPv4 + curl).
      // Для VLESS/WG нам нужен IP/DNS, что бы клиент смог подключаться.
      let publicIp: string | null = null;
      try {
        const { stdout } = await this.cmdExec.execute('curl', ['-fsS', '-4', '-m', '5', 'https://api.ipify.org']);
        publicIp = stdout.trim() || null;
      } catch {
        // fallback — local primary IPv4
        try {
          const { stdout } = await this.cmdExec.execute('ip', ['route', 'get', '1.1.1.1']);
          const m = stdout.match(/src\s+(\d+\.\d+\.\d+\.\d+)/);
          publicIp = m ? m[1] : null;
        } catch {
          /* noop */
        }
      }
      cb({ success: true, data: { publicIp } });
    });
  }

  private emitOrQueue(event: string, data: unknown): void {
    if (this.socket?.connected) {
      this.socket.emit(event, data);
      return;
    }
    // Не даём очереди расти бесконечно — сбрасываем самые старые.
    if (this.pendingEvents.length >= PENDING_EVENT_MAX_QUEUE) {
      const dropped = this.pendingEvents.shift();
      if (dropped) {
        console.warn(`[Agent] pendingEvents queue full — dropped oldest: ${dropped.event}`);
      }
    }
    this.pendingEvents.push({ event, data, queuedAt: Date.now() });
    console.log(`[Agent] Queued ${event} (socket disconnected), queue size: ${this.pendingEvents.length}`);
  }

  private flushPendingEvents(): void {
    if (this.pendingEvents.length === 0) return;

    const now = Date.now();
    const stale = this.pendingEvents.filter((e) => now - e.queuedAt > PENDING_EVENT_TTL_MS);
    if (stale.length > 0) {
      console.warn(
        `[Agent] Dropping ${stale.length} stale pending event(s) (> ${PENDING_EVENT_TTL_MS}ms): ${stale.map((e) => e.event).join(', ')}`,
      );
    }
    const fresh = this.pendingEvents.filter((e) => now - e.queuedAt <= PENDING_EVENT_TTL_MS);
    this.pendingEvents = [];

    console.log(`[Agent] Flushing ${fresh.length} pending event(s)`);

    for (const pe of fresh) {
      if (this.socket?.connected) {
        this.socket.emit(pe.event, pe.data);
        console.log(`[Agent] Flushed ${pe.event}`);
      } else {
        // Socket disconnected again during flush — re-queue remaining (сохраняя queuedAt).
        this.pendingEvents.push(pe);
      }
    }
  }

  private startMetricsStream() {
    this.stopMetricsStream();
    let inFlight = false;
    this.metricsInterval = setInterval(async () => {
      // Защита от: (1) unhandled rejection при ошибке collect()
      //           (2) overlapping ticks если collect() работает дольше интервала
      if (inFlight) return;
      if (!this.socket?.connected) return;
      inFlight = true;
      try {
        const data = await this.metrics.collect();
        if (this.socket?.connected) {
          this.socket.emit('system:metrics', data);
        }
      } catch (err) {
        // Не выбрасываем — иначе Node 22 в strict режиме повалит процесс.
        console.warn('[metrics] collect failed:', (err as Error).message);
      } finally {
        inFlight = false;
      }
    }, 10000);
  }

  private stopMetricsStream() {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }
  }
}
