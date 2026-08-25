import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  SERVICE_OPERATION_ACTIONS,
  resolveServiceAgentCall,
  serviceAgentActionForOperation,
  type ServiceOperationAction,
} from '@meowbox/shared';
import * as path from 'path';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { OperationAdmissionService } from '../operations/operation-admission.service';
import {
  OperationsWorkerService,
  type OperationExecutionContext,
} from '../operations/operations-worker.service';
import { OperationNeedsAttentionError } from '../operations/operation-errors';
import { AdminerHandoffService } from '../adminer/adminer-handoff.service';
import { SERVICE_CATALOG, findServiceEntry, getServiceScope } from './service.registry';
import { ServiceHandler } from './service.handler';
import { ManticoreServiceHandler } from './handlers/manticore.handler';
import { RedisServiceHandler } from './handlers/redis.handler';
import { MinioServiceHandler } from './handlers/minio.handler';
import { MariadbServiceHandler } from './handlers/mariadb.handler';
import { PostgresqlServiceHandler } from './handlers/postgresql.handler';
import { SshServiceHandler } from './handlers/ssh.handler';
import { Fail2banServiceHandler } from './handlers/fail2ban.handler';
import { PostfixServiceHandler } from './handlers/postfix.handler';
import {
  ServerServiceState,
  ServiceCatalogEntry,
  SiteContext,
  SiteServiceState,
  SiteServiceStatus,
} from './service.types';

export interface CatalogItemForServer extends ServerServiceState {
  catalog: ServiceCatalogEntry;
}

export interface CatalogItemForSite extends SiteServiceState {
  catalog: ServiceCatalogEntry;
  serverInstalled: boolean;
}

const SERVICE_REQUEST_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeServiceError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Service operation failed';
  return message
    .replace(/(password|secret|token|authorization|cookie)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 4096);
}

function validateServiceOperationRequest(
  actionId: string,
  request: unknown,
): { key: string; siteId?: string; config?: Record<string, unknown> } {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new BadRequestException('Service operation request is invalid');
  }
  const value = request as Record<string, unknown>;
  const serverAction = actionId.startsWith('services.server.');
  const needsConfig =
    actionId === SERVICE_OPERATION_ACTIONS.SITE_ENABLE ||
    actionId === SERVICE_OPERATION_ACTIONS.SITE_RECONFIGURE;
  const expected = serverAction
    ? ['key']
    : ['key', 'siteId', ...(needsConfig ? ['config'] : [])];
  if (
    Object.keys(value).sort().join(',') !== expected.sort().join(',') ||
    typeof value.key !== 'string' ||
    value.key.length > 32 ||
    !/^[a-z][a-z0-9_-]*$/.test(value.key) ||
    (!serverAction && (
      typeof value.siteId !== 'string' ||
      !SERVICE_REQUEST_UUID.test(value.siteId)
    )) ||
    (needsConfig && (
      !value.config ||
      typeof value.config !== 'object' ||
      Array.isArray(value.config)
    ))
  ) {
    throw new BadRequestException('Service operation request is invalid');
  }
  return value as { key: string; siteId?: string; config?: Record<string, unknown> };
}

@Injectable()
export class ServicesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ServicesService');
  private readonly handlers = new Map<string, ServiceHandler>();
  private unregisterOperationHandlers: Array<() => void> = [];
  private syncTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AgentRelayService,
    private readonly admission: OperationAdmissionService,
    private readonly worker: OperationsWorkerService,
    private readonly adminerHandoffs: AdminerHandoffService,
  ) {
    this.registerHandler(new ManticoreServiceHandler(agent));
    this.registerHandler(new RedisServiceHandler(agent));
    this.registerHandler(new MinioServiceHandler(agent));
    this.registerHandler(new MariadbServiceHandler(agent));
    this.registerHandler(new PostgresqlServiceHandler(agent));
    this.registerHandler(new SshServiceHandler(agent));
    this.registerHandler(new Fail2banServiceHandler(agent));
    this.registerHandler(new PostfixServiceHandler(agent));
  }

  /**
   * При старте API — best-effort синхронизация ServerService с реальным
   * состоянием на сервере. Без этого сразу после `install.sh` таблица
   * ServerService пустая, и валидаторы (assertDbEngineAvailable в SitesService,
   * assertEngineInstalled в DatabasesService) будут возвращать 409, пока
   * пользователь не зайдёт руками на /services.
   *
   * Делаем с задержкой 6 сек, чтобы агент успел подключиться по WS
   * (см. SitesService.onModuleInit — там 5 сек задержка).
   */
  onModuleInit(): void {
    for (const actionId of Object.values(SERVICE_OPERATION_ACTIONS)) {
      this.unregisterOperationHandlers.push(this.worker.registerHandler(
        actionId,
        (request, context) => this.executeServiceOperation(actionId, request, context),
      ));
    }
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      this.syncAllServerServices().catch((err) => {
        this.logger.warn(
          `Initial server-service sync skipped: ${(err as Error).message}`,
        );
      });
    }, 6000);
    this.syncTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    for (const unregister of this.unregisterOperationHandlers.splice(0)) unregister();
  }

  /** Best-effort: пробежать по каталогу и upsert'нуть ServerService по реальному статусу. */
  private async syncAllServerServices(): Promise<void> {
    if (!this.agent.isAgentConnected()) {
      this.logger.log('Server-service sync: agent offline — skip');
      return;
    }
    await Promise.all(
      SERVICE_CATALOG.map(async (catalog) => {
        const handler = this.handlers.get(catalog.key);
        if (!handler) return;
        try {
          const live = await handler.isInstalledOnServer();
          // Не трогаем installedAt при фоновом sync — это справочная дата
          // ручной установки через UI. На свежем сервере, где пакет уже стоит
          // из коробки (apt install в install.sh), installedAt останется null —
          // и это правильно, мы его не ставили через панель.
          await this.upsertServerRecord(catalog.key, {
            installed: live.installed,
            version: live.version,
            lastError: null,
          });
        } catch (err) {
          this.logger.warn(`Sync ${catalog.key} failed: ${(err as Error).message}`);
        }
      }),
    );
    this.logger.log('Server-service sync complete');
  }

  private registerHandler(h: ServiceHandler): void {
    this.handlers.set(h.key, h);
  }

  private getHandler(key: string): ServiceHandler {
    const h = this.handlers.get(key);
    if (!h) throw new NotFoundException(`Handler for service "${key}" not registered`);
    return h;
  }

  // =====================================================================
  // Server level
  // =====================================================================

  /**
   * Список сервисов на сервере с их состоянием.
   * Делаем live-check параллельно, чтобы видеть пакеты, поставленные руками
   * в обход панели (apt install …) — иначе UI будет врать.
   */
  async listServerServices(): Promise<CatalogItemForServer[]> {
    const records = await this.prisma.serverService.findMany();
    const recordByKey = new Map(records.map((r) => [r.serviceKey, r]));

    // Per-site сервисы (Redis/Manticore) считаем через SiteService:
    // одна запись = одно использование на сайте.
    const usageRows = await this.prisma.siteService.groupBy({
      by: ['serviceKey'],
      _count: { _all: true },
    });
    const usage = new Map(usageRows.map((r) => [r.serviceKey, r._count._all]));

    // Глобальные DB-сервисы (mariadb/postgresql) считаем через Database:
    // одна Database с привязкой к сайту = одно использование сервиса.
    // Используем distinct по siteId, чтобы 5 БД одного сайта = 1 сайт.
    const dbUsage = await this.computeGlobalDbUsage();

    // Live-check всех сервисов параллельно. dpkg-query быстрый и локальный.
    const liveResults = await Promise.all(
      SERVICE_CATALOG.map(async (catalog) => {
        try {
          const handler = this.handlers.get(catalog.key);
          if (!handler) return null;
          const live = await handler.isInstalledOnServer();
          return { key: catalog.key, ...live, error: null as string | null };
        } catch (err) {
          return { key: catalog.key, installed: false, version: null, error: (err as Error).message };
        }
      }),
    );
    const liveByKey = new Map(
      liveResults.filter((r): r is NonNullable<typeof r> => !!r).map((r) => [r.key, r]),
    );

    // Синхронизируем БД (best-effort), чтобы getServerService и enableSiteService
    // видели правильное состояние без дополнительного клика «Проверить».
    await Promise.all(
      Array.from(liveByKey.values()).map((live) => {
        const rec = recordByKey.get(live.key);
        const needSync =
          !rec ||
          rec.installed !== live.installed ||
          (live.installed && rec.version !== live.version);
        if (!needSync) return Promise.resolve();
        return this.upsertServerRecord(live.key, {
          installed: live.installed,
          version: live.version,
          lastError: live.error,
          installedAt: live.installed && !rec?.installedAt ? new Date() : undefined,
        }).catch(() => {});
      }),
    );

    // Свежий снимок после sync
    const freshRecords = await this.prisma.serverService.findMany();
    const freshByKey = new Map(freshRecords.map((r) => [r.serviceKey, r]));

    return SERVICE_CATALOG.map((catalog) => {
      const rec = freshByKey.get(catalog.key);
      const live = liveByKey.get(catalog.key);
      const scope = getServiceScope(catalog);
      const sitesUsing =
        scope === 'global'
          ? dbUsage.get(catalog.key) ?? 0
          : usage.get(catalog.key) ?? 0;
      return {
        catalog,
        key: catalog.key,
        installed: live?.installed ?? rec?.installed ?? false,
        version: live?.version ?? rec?.version ?? null,
        installedAt: rec?.installedAt ?? null,
        lastError: live?.error ?? rec?.lastError ?? null,
        sitesUsing,
      };
    });
  }

  /**
   * Считает кол-во **сайтов**, использующих каждый глобальный DB-сервис.
   * Маппит `Database.type` (MARIADB/MYSQL/POSTGRESQL) на ключ сервиса
   * через `databaseTypes` из каталога.
   *
   * MariaDB-сервис обслуживает и MARIADB, и MYSQL (исторические записи),
   * поэтому одна Database type=MYSQL засчитывается в mariadb-сервис.
   *
   * Distinct по siteId — иначе 5 баз одного сайта раздували бы счётчик.
   */
  private async computeGlobalDbUsage(): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const globalDbServices = SERVICE_CATALOG.filter(
      (s) => getServiceScope(s) === 'global' && s.databaseTypes && s.databaseTypes.length > 0,
    );
    if (globalDbServices.length === 0) return result;

    // Один запрос: все БД с привязкой к сайту, сгруппированные по типу.
    const rows = await this.prisma.database.findMany({
      select: { type: true, siteId: true },
    });

    for (const svc of globalDbServices) {
      const types = new Set(svc.databaseTypes);
      const sites = new Set<string>();
      for (const row of rows) {
        if (row.siteId && types.has(row.type)) sites.add(row.siteId);
      }
      result.set(svc.key, sites.size);
    }
    return result;
  }

  /** Детальный статус одного сервиса (с актуальной проверкой агента). */
  async getServerService(key: string): Promise<CatalogItemForServer> {
    const catalog = findServiceEntry(key);
    if (!catalog) throw new NotFoundException(`Unknown service "${key}"`);
    const handler = this.getHandler(key);

    // Свежий статус
    let installed = false;
    let version: string | null = null;
    let lastError: string | null = null;
    try {
      const live = await handler.isInstalledOnServer();
      installed = live.installed;
      version = live.version;
    } catch (err) {
      lastError = (err as Error).message;
    }

    // Синхронизация с БД
    await this.upsertServerRecord(key, { installed, version, lastError });

    const rec = await this.prisma.serverService.findUnique({ where: { serviceKey: key } });
    const sitesUsing = await this.computeUsageForService(catalog);

    return {
      catalog,
      key,
      installed,
      version,
      installedAt: rec?.installedAt ?? null,
      lastError,
      sitesUsing,
    };
  }

  /**
   * Подсчёт использования сервиса (для одного ключа).
   * Источник правды:
   *   - per-site:  prisma.siteService — запись = активация на сайте
   *   - global DB: prisma.database    — БД, привязанная к сайту через siteId
   */
  private async computeUsageForService(catalog: ServiceCatalogEntry): Promise<number> {
    if (getServiceScope(catalog) === 'global' && catalog.databaseTypes && catalog.databaseTypes.length > 0) {
      const rows = await this.prisma.database.findMany({
        where: { type: { in: [...catalog.databaseTypes] } },
        select: { siteId: true },
      });
      return new Set(rows.map((r) => r.siteId).filter((v): v is string => !!v)).size;
    }
    return this.prisma.siteService.count({ where: { serviceKey: catalog.key } });
  }

  async enqueueInstallServerService(
    key: string,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    const catalog = findServiceEntry(key);
    if (!catalog) throw new NotFoundException(`Unknown service "${key}"`);
    this.getHandler(key);
    return this.admission.admit({
      actionId: SERVICE_OPERATION_ACTIONS.SERVER_INSTALL,
      type: 'SERVICE_SERVER_INSTALL',
      idempotencyKey,
      actor,
      request: { key },
      deadlineMs: 60 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      globalLockKey: `service:${key}`,
    });
  }

  async enqueueUninstallServerService(
    key: string,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    await this.assertServerUninstallAllowed(key);
    return this.admission.admit({
      actionId: SERVICE_OPERATION_ACTIONS.SERVER_UNINSTALL,
      type: 'SERVICE_SERVER_UNINSTALL',
      idempotencyKey,
      actor,
      request: { key },
      deadlineMs: 60 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      globalLockKey: `service:${key}`,
    });
  }

  async enqueueRestartServerService(
    key: string,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    this.assertConfigEditableService(key);
    return this.admission.admit({
      actionId: SERVICE_OPERATION_ACTIONS.SERVER_RESTART,
      type: 'SERVICE_SERVER_RESTART',
      idempotencyKey,
      actor,
      request: { key },
      deadlineMs: 15 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      globalLockKey: `service:${key}`,
    });
  }

  private async assertServerUninstallAllowed(key: string): Promise<void> {
    const catalog = findServiceEntry(key);
    if (!catalog) throw new NotFoundException(`Unknown service "${key}"`);

    if (catalog.uninstallable === false) {
      throw new ConflictException(
        `Сервис «${catalog.name}» отмечен как неудаляемый — управляй им через системный пакетный менеджер.`,
      );
    }

    // Для DB-сервисов (mariadb/postgresql) считаем по таблице Database.
    if (getServiceScope(catalog) === 'global' && catalog.databaseTypes && catalog.databaseTypes.length > 0) {
      const dbCount = await this.prisma.database.count({
        where: { type: { in: [...catalog.databaseTypes] } },
      });
      if (dbCount > 0) {
        // Дополнительно посчитаем сайты для понятного сообщения.
        const sitesUsing = await this.computeUsageForService(catalog);
        const sitesPart = sitesUsing > 0 ? ` (используется на ${sitesUsing} сайтах)` : '';
        throw new ConflictException(
          `Нельзя удалить «${catalog.name}»: на сервере осталось ${dbCount} БД этого движка${sitesPart}. Сначала вручную удали все БД на странице /databases.`,
        );
      }
    } else {
      // Per-site сервис (Redis/Manticore) — старая логика.
      const inUse = await this.prisma.siteService.count({ where: { serviceKey: key } });
      if (inUse > 0) {
        throw new ConflictException(
          `Сервис используется на ${inUse} сайтах. Сначала отключи его у сайтов.`,
        );
      }
    }

    this.getHandler(key);
  }

  // =====================================================================
  // Server config editor — редактирование my.cnf / postgresql.conf / pg_hba.conf
  // через панель. Whitelist путей на стороне агента.
  // =====================================================================

  /** Список конфиг-файлов сервиса с реальными путями (для рендеринга вкладок). */
  async listServerConfigs(key: string): Promise<Array<{ file: string; path: string; exists: boolean }>> {
    this.assertConfigEditableService(key);
    const r = await this.agent.emitToAgent<Array<{ file: string; path: string; exists: boolean }>>(
      'services:list-server-configs',
      { serviceKey: key },
      30_000,
    );
    if (!r.success) throw new BadRequestException(r.error || 'list-server-configs failed');
    return r.data!;
  }

  async readServerConfig(key: string, file: string): Promise<{ path: string; content: string; size: number; utf8: boolean }> {
    this.assertConfigEditableService(key);
    if (!file || file.length > 64 || !/^[a-zA-Z0-9._-]+$/.test(file)) {
      throw new BadRequestException('Invalid config file name');
    }
    const r = await this.agent.emitToAgent<{ path: string; content: string; size: number; utf8: boolean }>(
      'services:read-server-config',
      { serviceKey: key, file },
      30_000,
    );
    if (!r.success) throw new BadRequestException(r.error || 'read-server-config failed');
    return r.data!;
  }

  async writeServerConfig(key: string, file: string, content: string): Promise<{ path: string; backupPath: string }> {
    this.assertConfigEditableService(key);
    if (!file || file.length > 64 || !/^[a-zA-Z0-9._-]+$/.test(file)) {
      throw new BadRequestException('Invalid config file name');
    }
    if (typeof content !== 'string') {
      throw new BadRequestException('content must be a string');
    }
    if (content.length > 1_000_000) {
      throw new BadRequestException('content too large (limit 1 MB)');
    }
    const r = await this.agent.emitToAgent<{ path: string; backupPath: string }>(
      'services:write-server-config',
      { serviceKey: key, file, content },
      30_000,
    );
    if (!r.success) throw new BadRequestException(r.error || 'write-server-config failed');
    return r.data!;
  }

  /**
   * Не каждый сервис умеет редактироваться через панель. Per-site сервисы
   * (Redis/Manticore) живут per-site, у них нет глобального конфига —
   * для них config-editor не имеет смысла, отказ 400.
   */
  private assertConfigEditableService(key: string): void {
    if (
      key !== 'mariadb' &&
      key !== 'postgresql' &&
      key !== 'ssh' &&
      key !== 'fail2ban' &&
      key !== 'postfix'
    ) {
      throw new BadRequestException(
        `Сервис «${key}» не поддерживает редактирование конфигурации через панель`,
      );
    }
  }

  // =====================================================================
  // Fail2ban presets — каталог пресетов + текущее состояние + apply.
  // Живут отдельно от config editor: пресеты пересобирают `meowbox.local`
  // целиком из выбранных секций. Ручные правки — через config editor
  // (`jail.local`).
  // =====================================================================

  async getFail2banPresets(): Promise<{
    catalog: Array<{ key: string; name: string; description: string }>;
    state: {
      presets: Array<{ key: string; name: string; description: string; enabled: boolean }>;
      defaults: { bantime: string; findtime: string; maxretry: string };
      managedFilePath: string;
      managedFileExists: boolean;
    };
  }> {
    const [catRes, stateRes] = await Promise.all([
      this.agent.emitToAgent<Array<{ key: string; name: string; description: string }>>(
        'fail2ban:presets-catalog',
        {},
        15_000,
      ),
      this.agent.emitToAgent<{
        presets: Array<{ key: string; name: string; description: string; enabled: boolean }>;
        defaults: { bantime: string; findtime: string; maxretry: string };
        managedFilePath: string;
        managedFileExists: boolean;
      }>(
        'fail2ban:presets-get',
        {},
        30_000,
      ),
    ]);
    if (!catRes.success) throw new BadRequestException(catRes.error || 'fail2ban:presets-catalog failed');
    if (!stateRes.success) throw new BadRequestException(stateRes.error || 'fail2ban:presets-get failed');
    return { catalog: catRes.data!, state: stateRes.data! };
  }

  async applyFail2banPresets(
    enabledKeys: string[],
    defaults?: { bantime?: string; findtime?: string; maxretry?: string },
  ): Promise<{ path: string; restart: { unit: string; ok: boolean; output: string } }> {
    if (!Array.isArray(enabledKeys)) {
      throw new BadRequestException('enabledKeys must be string[]');
    }
    // Защита от мусора — ограничим количество ключей.
    if (enabledKeys.length > 64) {
      throw new BadRequestException('Too many preset keys (max 64)');
    }
    // Защита от мусора в значениях defaults.
    const safeDefaults = defaults
      ? {
          bantime: typeof defaults.bantime === 'string' ? defaults.bantime : undefined,
          findtime: typeof defaults.findtime === 'string' ? defaults.findtime : undefined,
          maxretry: typeof defaults.maxretry === 'string' ? defaults.maxretry : undefined,
        }
      : undefined;
    const r = await this.agent.emitToAgent<{ path: string; restart: { unit: string; ok: boolean; output: string } }>(
      'fail2ban:presets-apply',
      { enabledKeys, defaults: safeDefaults },
      120_000,
    );
    if (!r.success) throw new BadRequestException(r.error || 'fail2ban:presets-apply failed');
    return r.data!;
  }

  // =====================================================================
  // Postfix relay (smarthost) — каталог пресетов + текущее состояние + apply.
  // Пароль ВСЕГДА маскируется: getRelay не возвращает password, только
  // hasPassword: boolean. applyRelay принимает пароль и пишет его в /etc/postfix/sasl_passwd
  // на стороне агента; через API он наружу не утекает.
  // =====================================================================

  async getPostfixRelay(): Promise<{
    catalog: Array<{
      key: string;
      name: string;
      description: string;
      host: string;
      port: number;
      wrapperSSL: boolean;
      hint?: string;
      defaultUsername?: string;
    }>;
    state: {
      configured: boolean;
      preset: string | null;
      host: string | null;
      port: number | null;
      wrapperSSL: boolean | null;
      username: string | null;
      hasPassword: boolean;
      fromEmail: string | null;
      adminEmail: string | null;
      myhostname: string | null;
      mainCfPath: string;
      saslPasswdPath: string;
    };
  }> {
    const [catRes, stateRes] = await Promise.all([
      this.agent.emitToAgent<Array<{
        key: string; name: string; description: string;
        host: string; port: number; wrapperSSL: boolean;
        hint?: string; defaultUsername?: string;
      }>>('postfix:relay-presets', {}, 15_000),
      this.agent.emitToAgent<{
        configured: boolean;
        preset: string | null;
        host: string | null;
        port: number | null;
        wrapperSSL: boolean | null;
        username: string | null;
        hasPassword: boolean;
        fromEmail: string | null;
        adminEmail: string | null;
        myhostname: string | null;
        mainCfPath: string;
        saslPasswdPath: string;
      }>('postfix:relay-get', {}, 30_000),
    ]);
    if (!catRes.success) throw new BadRequestException(catRes.error || 'postfix:relay-presets failed');
    if (!stateRes.success) throw new BadRequestException(stateRes.error || 'postfix:relay-get failed');
    return { catalog: catRes.data!, state: stateRes.data! };
  }

  async applyPostfixRelay(cfg: {
    preset?: string;
    host?: string;
    port?: number;
    wrapperSSL?: boolean;
    username?: string;
    password?: string;
    fromEmail?: string;
    adminEmail?: string;
    myhostname?: string;
  }): Promise<{ paths: string[]; restart: { unit: string; ok: boolean; output: string } }> {
    if (!cfg || typeof cfg !== 'object') {
      throw new BadRequestException('Body must be relay config object');
    }
    // Жёсткая валидация типов — реальная санация на стороне агента.
    const safe = {
      preset: typeof cfg.preset === 'string' ? cfg.preset : 'custom',
      host: typeof cfg.host === 'string' ? cfg.host : '',
      port: typeof cfg.port === 'number' ? cfg.port : 587,
      wrapperSSL: !!cfg.wrapperSSL,
      username: typeof cfg.username === 'string' ? cfg.username : '',
      password: typeof cfg.password === 'string' ? cfg.password : '',
      fromEmail: typeof cfg.fromEmail === 'string' ? cfg.fromEmail : '',
      adminEmail: typeof cfg.adminEmail === 'string' ? cfg.adminEmail : '',
      myhostname: typeof cfg.myhostname === 'string' ? cfg.myhostname : '',
    };
    if (!safe.host) throw new BadRequestException('host обязателен');
    if (!safe.username) throw new BadRequestException('username обязателен');
    if (!safe.password) throw new BadRequestException('password обязателен');
    if (!safe.fromEmail) throw new BadRequestException('fromEmail обязателен');
    if (!safe.adminEmail) throw new BadRequestException('adminEmail обязателен');
    if (safe.password.length > 1024) {
      throw new BadRequestException('password слишком длинный');
    }

    const r = await this.agent.emitToAgent<{
      paths: string[]; restart: { unit: string; ok: boolean; output: string };
    }>('postfix:relay-apply', safe, 120_000);
    if (!r.success) throw new BadRequestException(r.error || 'postfix:relay-apply failed');
    return r.data!;
  }

  async sendPostfixTestEmail(toEmail: string): Promise<{ sent: boolean; log: string }> {
    if (typeof toEmail !== 'string' || !toEmail.includes('@')) {
      throw new BadRequestException('toEmail: ожидается email');
    }
    if (toEmail.length > 254) {
      throw new BadRequestException('toEmail: слишком длинный');
    }
    const r = await this.agent.emitToAgent<{ sent: boolean; log: string }>(
      'postfix:send-test',
      { toEmail },
      45_000,
    );
    if (!r.success) throw new BadRequestException(r.error || 'postfix:send-test failed');
    return r.data!;
  }

  async getFail2banClientStatus(): Promise<{ raw: string; jails: string[] }> {
    const r = await this.agent.emitToAgent<{ raw: string; jails: string[] }>(
      'fail2ban:client-status',
      {},
      15_000,
    );
    if (!r.success) throw new BadRequestException(r.error || 'fail2ban:client-status failed');
    return r.data!;
  }

  // =====================================================================
  // Site level
  // =====================================================================

  /** Список сервисов для сайта: активированные сверху, остальные снизу. */
  async listSiteServices(siteId: string): Promise<CatalogItemForSite[]> {
    const site = await this.requireSite(siteId);
    const records = await this.prisma.siteService.findMany({ where: { siteId } });
    const recordByKey = new Map(records.map((r) => [r.serviceKey, r]));

    const serverRecords = await this.prisma.serverService.findMany();
    const serverByKey = new Map(serverRecords.map((r) => [r.serviceKey, r]));

    // Глобальные сервисы (mariadb/postgresql) на вкладке сайта НЕ показываем —
    // у них нет per-site enable/disable. Управление БД конкретного сайта живёт
    // на отдельной вкладке «Базы данных».
    const items: CatalogItemForSite[] = SERVICE_CATALOG
      .filter((catalog) => getServiceScope(catalog) === 'per-site')
      .map((catalog) => {
        const rec = recordByKey.get(catalog.key);
        const srv = serverByKey.get(catalog.key);
        const cfg = rec ? safeJson(rec.config) : {};
        return {
          catalog,
          key: catalog.key,
          active: !!rec,
          status: (rec?.status ?? 'STOPPED') as SiteServiceStatus,
          lastError: rec?.lastError ?? null,
          installedAt: rec?.installedAt ?? null,
          config: cfg,
          serverInstalled: srv?.installed ?? false,
        };
      });

    // Активные сверху
    items.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.catalog.name.localeCompare(b.catalog.name);
    });
    void site;
    return items;
  }

  /** Свежий статус демона сайта (через агента) + метрики + connection info. */
  async getSiteService(siteId: string, key: string) {
    const site = await this.requireSite(siteId);
    const catalog = findServiceEntry(key);
    if (!catalog) throw new NotFoundException(`Unknown service "${key}"`);
    const rec = await this.prisma.siteService.findUnique({
      where: { siteId_serviceKey: { siteId, serviceKey: key } },
    });
    if (!rec) {
      throw new NotFoundException(`Service "${key}" не активирован для сайта`);
    }
    const handler = this.getHandler(key);
    const ctx = this.toCtx(site);

    // live status
    let liveStatus: SiteServiceStatus = 'ERROR';
    try {
      liveStatus = await handler.statusForSite(ctx);
    } catch {
      liveStatus = 'ERROR';
    }

    // Синхронизация с БД (чтобы UI видел актуальный статус)
    if (rec.status !== liveStatus) {
      await this.prisma.siteService.update({
        where: { id: rec.id },
        data: { status: liveStatus },
      });
    }

    const [metrics, connection] = await Promise.all([
      handler.metricsForSite(ctx).catch(() => ({ items: [] })),
      Promise.resolve(handler.connectionInfoForSite(ctx)),
    ]);

    return {
      catalog,
      key,
      active: true,
      status: liveStatus,
      lastError: rec.lastError,
      installedAt: rec.installedAt,
      config: safeJson(rec.config),
      metrics,
      connection,
    };
  }

  async enqueueEnableSiteService(
    siteId: string,
    key: string,
    config: Record<string, unknown>,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    await this.assertSiteServiceAction(SERVICE_OPERATION_ACTIONS.SITE_ENABLE, siteId, key);
    await this.assertSiteAgentPayload(
      SERVICE_OPERATION_ACTIONS.SITE_ENABLE,
      siteId,
      key,
      config || {},
    );
    return this.admitSiteServiceOperation(
      SERVICE_OPERATION_ACTIONS.SITE_ENABLE,
      'SERVICE_SITE_ENABLE',
      siteId,
      key,
      config || {},
      actor,
      idempotencyKey,
    );
  }

  async enqueueDisableSiteService(
    siteId: string,
    key: string,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    await this.assertSiteServiceAction(SERVICE_OPERATION_ACTIONS.SITE_DISABLE, siteId, key);
    return this.admitSiteServiceOperation(
      SERVICE_OPERATION_ACTIONS.SITE_DISABLE,
      'SERVICE_SITE_DISABLE',
      siteId,
      key,
      undefined,
      actor,
      idempotencyKey,
    );
  }

  async enqueueStartSiteService(
    siteId: string,
    key: string,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    await this.assertSiteServiceAction(SERVICE_OPERATION_ACTIONS.SITE_START, siteId, key);
    return this.admitSiteServiceOperation(
      SERVICE_OPERATION_ACTIONS.SITE_START,
      'SERVICE_SITE_START',
      siteId,
      key,
      undefined,
      actor,
      idempotencyKey,
    );
  }

  async enqueueStopSiteService(
    siteId: string,
    key: string,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    await this.assertSiteServiceAction(SERVICE_OPERATION_ACTIONS.SITE_STOP, siteId, key);
    return this.admitSiteServiceOperation(
      SERVICE_OPERATION_ACTIONS.SITE_STOP,
      'SERVICE_SITE_STOP',
      siteId,
      key,
      undefined,
      actor,
      idempotencyKey,
    );
  }

  async enqueueReconfigureSiteService(
    siteId: string,
    key: string,
    config: Record<string, unknown>,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    await this.assertSiteServiceAction(SERVICE_OPERATION_ACTIONS.SITE_RECONFIGURE, siteId, key);
    await this.assertSiteAgentPayload(
      SERVICE_OPERATION_ACTIONS.SITE_RECONFIGURE,
      siteId,
      key,
      config || {},
    );
    return this.admitSiteServiceOperation(
      SERVICE_OPERATION_ACTIONS.SITE_RECONFIGURE,
      'SERVICE_SITE_RECONFIGURE',
      siteId,
      key,
      config || {},
      actor,
      idempotencyKey,
    );
  }

  private admitSiteServiceOperation(
    actionId: ServiceOperationAction,
    type: string,
    siteId: string,
    key: string,
    config: Record<string, unknown> | undefined,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    const request = config === undefined ? { siteId, key } : { siteId, key, config };
    return this.admission.admit({
      actionId,
      type,
      idempotencyKey,
      actor,
      request,
      deadlineMs: 15 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      siteId,
      lockSite: true,
    });
  }

  private async assertSiteServiceAction(
    actionId: ServiceOperationAction,
    siteId: string,
    key: string,
  ): Promise<void> {
    await this.requireSite(siteId);
    const catalog = findServiceEntry(key);
    if (!catalog) throw new NotFoundException(`Unknown service "${key}"`);

    if (getServiceScope(catalog) === 'global') {
      throw new ConflictException(
        `«${catalog.name}» — глобальный сервис, его нельзя активировать на одном сайте. БД создаётся через раздел «Базы данных».`,
      );
    }

    const record = await this.prisma.siteService.findUnique({
      where: { siteId_serviceKey: { siteId, serviceKey: key } },
    });
    if (actionId === SERVICE_OPERATION_ACTIONS.SITE_ENABLE) {
      const server = await this.prisma.serverService.findUnique({ where: { serviceKey: key } });
      if (!server || !server.installed) {
        throw new ConflictException(
          `Сервис "${catalog.name}" не установлен на сервере. Установи его сначала на странице Сервисы.`,
        );
      }
      if (record) {
        throw new ConflictException(`Сервис "${catalog.name}" уже активирован для этого сайта`);
      }
      return;
    }
    if (!record && actionId !== SERVICE_OPERATION_ACTIONS.SITE_DISABLE) {
      throw new NotFoundException(`Сервис "${key}" не активирован для сайта`);
    }
    if (
      (actionId === SERVICE_OPERATION_ACTIONS.SITE_START ||
        actionId === SERVICE_OPERATION_ACTIONS.SITE_STOP ||
        actionId === SERVICE_OPERATION_ACTIONS.SITE_RECONFIGURE) &&
      catalog.siteLifecycle === false
    ) {
      throw new ConflictException(`«${catalog.name}» — общий сервис; его нельзя запускать с одного сайта`);
    }
    this.getHandler(key);
  }

  private async assertSiteAgentPayload(
    actionId: ServiceOperationAction,
    siteId: string,
    key: string,
    config: Record<string, unknown>,
  ): Promise<void> {
    const targetSite = await this.requireSite(siteId);
    resolveServiceAgentCall(serviceAgentActionForOperation(actionId), {
      serviceKey: key,
      site: this.toCtx(targetSite),
      config,
    });
  }

  /** Existing migration orchestration compatibility; browser routes never call this path. */
  async enableSiteService(
    siteId: string,
    key: string,
    config: Record<string, unknown> = {},
  ): Promise<void> {
    await this.assertSiteServiceAction(SERVICE_OPERATION_ACTIONS.SITE_ENABLE, siteId, key);
    const targetSite = await this.requireSite(siteId);
    const handler = this.getHandler(key);
    const record = await this.prisma.siteService.create({
      data: {
        siteId,
        serviceKey: key,
        status: 'STARTING',
        config: JSON.stringify(config),
      },
    });
    try {
      await handler.enableForSite(this.toCtx(targetSite), config);
      await this.prisma.siteService.update({
        where: { id: record.id },
        data: { status: 'RUNNING', lastError: null },
      });
    } catch (error) {
      const message = safeServiceError(error);
      await this.prisma.siteService.update({
        where: { id: record.id },
        data: { status: 'ERROR', lastError: message },
      });
      throw error;
    }
  }

  /** Existing migration orchestration compatibility; browser routes never call this path. */
  async startSiteService(siteId: string, key: string): Promise<void> {
    await this.runLegacySiteLifecycle(siteId, key, 'start');
  }

  /** Existing migration orchestration compatibility; browser routes never call this path. */
  async stopSiteService(siteId: string, key: string): Promise<void> {
    await this.runLegacySiteLifecycle(siteId, key, 'stop');
  }

  /** Existing migration orchestration compatibility; browser routes never call this path. */
  async reconfigureSiteService(
    siteId: string,
    key: string,
    config: Record<string, unknown>,
  ): Promise<void> {
    await this.assertSiteServiceAction(SERVICE_OPERATION_ACTIONS.SITE_RECONFIGURE, siteId, key);
    const targetSite = await this.requireSite(siteId);
    const record = await this.requireRecord(siteId, key);
    try {
      await this.getHandler(key).reconfigureForSite(this.toCtx(targetSite), config);
      await this.prisma.siteService.update({
        where: { id: record.id },
        data: { config: JSON.stringify(config), lastError: null },
      });
    } catch (error) {
      await this.prisma.siteService.update({
        where: { id: record.id },
        data: { lastError: safeServiceError(error) },
      });
      throw error;
    }
  }

  private async runLegacySiteLifecycle(
    siteId: string,
    key: string,
    action: 'start' | 'stop',
  ): Promise<void> {
    const operationAction = action === 'start'
      ? SERVICE_OPERATION_ACTIONS.SITE_START
      : SERVICE_OPERATION_ACTIONS.SITE_STOP;
    await this.assertSiteServiceAction(operationAction, siteId, key);
    const targetSite = await this.requireSite(siteId);
    const record = await this.requireRecord(siteId, key);
    try {
      const handler = this.getHandler(key);
      if (action === 'start') await handler.startForSite(this.toCtx(targetSite));
      else await handler.stopForSite(this.toCtx(targetSite));
      await this.prisma.siteService.update({
        where: { id: record.id },
        data: { status: action === 'start' ? 'RUNNING' : 'STOPPED', lastError: null },
      });
    } catch (error) {
      await this.prisma.siteService.update({
        where: { id: record.id },
        data: { status: 'ERROR', lastError: safeServiceError(error) },
      });
      throw error;
    }
  }

  private async executeServiceOperation(
    actionId: ServiceOperationAction,
    request: unknown,
    context: OperationExecutionContext,
  ): Promise<unknown> {
    const parsed = validateServiceOperationRequest(actionId, request);
    if (actionId.startsWith('services.server.')) {
      return this.executeServerServiceOperation(actionId, parsed.key, context);
    }
    return this.executeSiteServiceOperation(
      actionId,
      parsed.siteId!,
      parsed.key,
      parsed.config,
      context,
    );
  }

  private async executeServerServiceOperation(
    actionId: ServiceOperationAction,
    key: string,
    context: OperationExecutionContext,
  ): Promise<unknown> {
    const catalog = findServiceEntry(key);
    if (!catalog) throw new NotFoundException(`Unknown service "${key}"`);
    this.getHandler(key);
    if (actionId === SERVICE_OPERATION_ACTIONS.SERVER_UNINSTALL) {
      await this.assertServerUninstallAllowed(key);
    } else if (actionId === SERVICE_OPERATION_ACTIONS.SERVER_RESTART) {
      this.assertConfigEditableService(key);
    }
    const agentAction = serviceAgentActionForOperation(actionId);
    const payload = { serviceKey: key };
    resolveServiceAgentCall(agentAction, payload);
    await context.throwIfCancellationRequested();

    try {
      const result = await this.agent.runAgentJob(
        {
          operationId: context.operationId,
          actionId: agentAction,
          step: 'execute',
          payload,
          deadlineAt: context.deadlineAt,
          cancelSafe: false,
        },
        () => context.isCancellationRequested(),
      );
      if (actionId === SERVICE_OPERATION_ACTIONS.SERVER_INSTALL) {
        if (
          !result ||
          typeof result !== 'object' ||
          typeof (result as Record<string, unknown>).version !== 'string' ||
          (result as Record<string, unknown>).version!.toString().length > 128
        ) {
          throw new OperationNeedsAttentionError('Service install returned an invalid version');
        }
        const version = (result as { version: string }).version;
        await this.upsertServerRecord(key, {
          installed: true,
          version,
          lastError: null,
          installedAt: new Date(),
        });
        this.logger.log(`Service ${key} installed on server (${version})`);
        return { key, installed: true, version };
      }
      if (actionId === SERVICE_OPERATION_ACTIONS.SERVER_UNINSTALL) {
        await this.upsertServerRecord(key, {
          installed: false,
          version: null,
          installedAt: null,
          lastError: null,
        });
        this.logger.log(`Service ${key} uninstalled from server`);
        return { key, installed: false };
      }
      if (
        !result ||
        typeof result !== 'object' ||
        typeof (result as Record<string, unknown>).unit !== 'string' ||
        typeof (result as Record<string, unknown>).ok !== 'boolean'
      ) {
        throw new OperationNeedsAttentionError('Service restart returned an invalid result');
      }
      await this.upsertServerRecord(key, { lastError: null });
      return result;
    } catch (error) {
      const message = safeServiceError(error);
      this.logger.error(`Service ${key} operation failed: ${message}`);
      await this.upsertServerRecord(key, { lastError: message });
      throw error;
    }
  }

  private async executeSiteServiceOperation(
    actionId: ServiceOperationAction,
    siteId: string,
    key: string,
    config: Record<string, unknown> | undefined,
    context: OperationExecutionContext,
  ): Promise<unknown> {
    const targetSite = await this.requireSite(siteId);
    const catalog = findServiceEntry(key);
    if (!catalog) throw new NotFoundException(`Unknown service "${key}"`);
    if (getServiceScope(catalog) === 'global') {
      throw new ConflictException(`«${catalog.name}» is not a per-site service`);
    }
    if (
      (actionId === SERVICE_OPERATION_ACTIONS.SITE_START ||
        actionId === SERVICE_OPERATION_ACTIONS.SITE_STOP ||
        actionId === SERVICE_OPERATION_ACTIONS.SITE_RECONFIGURE) &&
      catalog.siteLifecycle === false
    ) {
      throw new ConflictException(`«${catalog.name}» has no site lifecycle`);
    }
    let record = await this.prisma.siteService.findUnique({
      where: { siteId_serviceKey: { siteId, serviceKey: key } },
    });

    if (actionId === SERVICE_OPERATION_ACTIONS.SITE_ENABLE) {
      const server = await this.prisma.serverService.findUnique({ where: { serviceKey: key } });
      if (!server?.installed) throw new ConflictException(`Service "${key}" is not installed`);
      if (record?.status === 'RUNNING') {
        return { key, siteId, status: 'RUNNING', reconciled: true };
      }
      if (record && record.status !== 'STARTING') {
        throw new ConflictException(`Service "${key}" is already active for site`);
      }
      if (!record) {
        record = await this.prisma.siteService.create({
          data: {
            siteId,
            serviceKey: key,
            status: 'STARTING',
            config: JSON.stringify(config || {}),
          },
        });
      }
    } else if (!record) {
      if (actionId === SERVICE_OPERATION_ACTIONS.SITE_DISABLE) {
        return { key, siteId, disabled: true, reconciled: true };
      }
      throw new NotFoundException(`Service "${key}" is not active for site`);
    } else if (
      actionId === SERVICE_OPERATION_ACTIONS.SITE_START &&
      record.status === 'RUNNING'
    ) {
      return { key, siteId, status: 'RUNNING', reconciled: true };
    } else if (
      actionId === SERVICE_OPERATION_ACTIONS.SITE_STOP &&
      record.status === 'STOPPED'
    ) {
      return { key, siteId, status: 'STOPPED', reconciled: true };
    } else if (
      actionId === SERVICE_OPERATION_ACTIONS.SITE_RECONFIGURE &&
      record.config === JSON.stringify(config || {}) &&
      context.recovering
    ) {
      return { key, siteId, reconfigured: true, reconciled: true };
    }

    const agentAction = serviceAgentActionForOperation(actionId);
    const payload = {
      serviceKey: key,
      site: this.toCtx(targetSite),
      ...(actionId === SERVICE_OPERATION_ACTIONS.SITE_ENABLE ||
      actionId === SERVICE_OPERATION_ACTIONS.SITE_RECONFIGURE
        ? { config: config || {} }
        : {}),
    };
    resolveServiceAgentCall(agentAction, payload);
    await context.throwIfCancellationRequested();

    try {
      await this.agent.runAgentJob(
        {
          operationId: context.operationId,
          actionId: agentAction,
          step: 'execute',
          payload,
          deadlineAt: context.deadlineAt,
          cancelSafe: false,
        },
        () => context.isCancellationRequested(),
      );
      if (actionId === SERVICE_OPERATION_ACTIONS.SITE_DISABLE) {
        await this.prisma.siteService.deleteMany({ where: { id: record!.id } });
        return { key, siteId, disabled: true };
      }
      const data = actionId === SERVICE_OPERATION_ACTIONS.SITE_STOP
        ? { status: 'STOPPED', lastError: null }
        : actionId === SERVICE_OPERATION_ACTIONS.SITE_RECONFIGURE
          ? { config: JSON.stringify(config || {}), lastError: null }
          : { status: 'RUNNING', lastError: null };
      await this.prisma.siteService.update({ where: { id: record!.id }, data });
      return {
        key,
        siteId,
        ...(actionId === SERVICE_OPERATION_ACTIONS.SITE_RECONFIGURE
          ? { reconfigured: true }
          : { status: data.status }),
      };
    } catch (error) {
      const message = safeServiceError(error);
      this.logger.error(`Service ${key} operation for site ${targetSite.name} failed: ${message}`);
      if (record) {
        await this.prisma.siteService.updateMany({
          where: { id: record.id },
          data: actionId === SERVICE_OPERATION_ACTIONS.SITE_RECONFIGURE
            ? { lastError: message }
            : { status: 'ERROR', lastError: message },
        });
      }
      throw error;
    }
  }

  async getSiteServiceLogs(siteId: string, key: string, lines = 200): Promise<string> {
    const site = await this.requireSite(siteId);
    await this.requireRecord(siteId, key);
    const handler = this.getHandler(key);
    return handler.logsForSite(this.toCtx(site), lines);
  }

  async createManticoreAdminerTicket(siteId: string, userId: string, role: string) {
    const site = await this.requireSite(siteId);
    const catalog = findServiceEntry('manticore');
    if (!catalog) throw new NotFoundException('Manticore не зарегистрирован в каталоге');

    const rec = await this.prisma.siteService.findUnique({
      where: { siteId_serviceKey: { siteId, serviceKey: 'manticore' } },
    });
    if (!rec) {
      throw new BadRequestException(
        `Manticore не активирован для сайта «${site.name}». Активируй его на вкладке «Сервисы».`,
      );
    }
    if (rec.status !== 'RUNNING') {
      throw new BadRequestException(
        `Manticore сайта в статусе ${rec.status}. Запусти демон, прежде чем открывать Adminer.`,
      );
    }

    // Сокет создаётся самим searchd в `{rootPath}/tmp/manticore.sock` —
    // см. agent/src/services/manticore.executor.ts (renderManticoreConfig).
    const socket = path.join(site.rootPath, 'tmp', 'manticore.sock');

    return this.adminerHandoffs.create({
      purpose: 'MANTICORE',
      resourceKind: 'SITE_SERVICE',
      resourceId: `${site.id}:manticore`,
      actor: { userId, role },
      credentials: {
        service: 'manticore',
        site: site.name,
        driver: 'server',
        host: 'localhost',
        socket,
        port: null,
        user: '',
        pass: '',
        database: '',
      },
    });
  }

  // =====================================================================
  // helpers
  // =====================================================================

  private async requireSite(siteId: string) {
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) throw new NotFoundException(`Site ${siteId} not found`);
    if (!site.systemUser) {
      throw new ConflictException(`У сайта нет system user — провижининг не завершён`);
    }
    return site;
  }

  private async requireRecord(siteId: string, key: string) {
    const rec = await this.prisma.siteService.findUnique({
      where: { siteId_serviceKey: { siteId, serviceKey: key } },
    });
    if (!rec) throw new NotFoundException(`Сервис "${key}" не активирован для сайта`);
    return rec;
  }

  private toCtx(site: { id: string; name: string; systemUser: string | null; rootPath: string }): SiteContext {
    return {
      id: site.id,
      name: site.name,
      systemUser: site.systemUser!,
      rootPath: site.rootPath,
    };
  }

  private async upsertServerRecord(
    key: string,
    data: {
      installed?: boolean;
      version?: string | null;
      lastError?: string | null;
      installedAt?: Date | null;
    },
  ): Promise<void> {
    await this.prisma.serverService.upsert({
      where: { serviceKey: key },
      update: {
        ...(data.installed !== undefined ? { installed: data.installed } : {}),
        ...(data.version !== undefined ? { version: data.version } : {}),
        ...(data.lastError !== undefined ? { lastError: data.lastError } : {}),
        ...(data.installedAt !== undefined ? { installedAt: data.installedAt } : {}),
      },
      create: {
        serviceKey: key,
        installed: data.installed ?? false,
        version: data.version ?? null,
        lastError: data.lastError ?? null,
        installedAt: data.installedAt ?? null,
      },
    });
  }
}

function safeJson(s: string | null | undefined): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
