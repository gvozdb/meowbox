import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import * as path from 'path';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { encryptToken } from '../common/crypto/adminer-cipher';
import { SERVICE_CATALOG, findServiceEntry, getServiceScope } from './service.registry';
import { ServiceHandler } from './service.handler';
import { ManticoreServiceHandler } from './handlers/manticore.handler';
import { RedisServiceHandler } from './handlers/redis.handler';
import { MariadbServiceHandler } from './handlers/mariadb.handler';
import { PostgresqlServiceHandler } from './handlers/postgresql.handler';
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

@Injectable()
export class ServicesService implements OnModuleInit {
  private readonly logger = new Logger('ServicesService');
  private readonly handlers = new Map<string, ServiceHandler>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AgentRelayService,
  ) {
    this.registerHandler(new ManticoreServiceHandler(agent));
    this.registerHandler(new RedisServiceHandler(agent));
    this.registerHandler(new MariadbServiceHandler(agent));
    this.registerHandler(new PostgresqlServiceHandler(agent));
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
  async onModuleInit(): Promise<void> {
    setTimeout(() => {
      this.syncAllServerServices().catch((err) => {
        this.logger.warn(
          `Initial server-service sync skipped: ${(err as Error).message}`,
        );
      });
    }, 6000);
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
      where: { siteId: { not: null } },
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
        where: { siteId: { not: null }, type: { in: [...catalog.databaseTypes] } },
        select: { siteId: true },
      });
      return new Set(rows.map((r) => r.siteId).filter((v): v is string => !!v)).size;
    }
    return this.prisma.siteService.count({ where: { serviceKey: catalog.key } });
  }

  async installServerService(key: string): Promise<CatalogItemForServer> {
    const catalog = findServiceEntry(key);
    if (!catalog) throw new NotFoundException(`Unknown service "${key}"`);
    const handler = this.getHandler(key);

    try {
      const r = await handler.installOnServer();
      await this.upsertServerRecord(key, {
        installed: true,
        version: r.version,
        lastError: null,
        installedAt: new Date(),
      });
      this.logger.log(`Service ${key} installed on server (${r.version})`);
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.error(`Service ${key} install failed: ${msg}`);
      await this.upsertServerRecord(key, { lastError: msg });
      // Прокидываем читаемую ошибку клиенту (иначе GlobalExceptionFilter
      // схватит обычный Error и отдаст «An unexpected error occurred»).
      throw new BadRequestException(`Установка «${catalog.name}» провалилась: ${msg}`);
    }

    return this.getServerService(key);
  }

  async uninstallServerService(key: string): Promise<void> {
    const catalog = findServiceEntry(key);
    if (!catalog) throw new NotFoundException(`Unknown service "${key}"`);

    if (catalog.uninstallable === false) {
      throw new ConflictException(
        `Сервис «${catalog.name}» отмечен как неудаляемый — управляй им через системный пакетный менеджер.`,
      );
    }

    // Для DB-сервисов (mariadb/postgresql) считаем по таблице Database,
    // включая БД, не привязанные к сайту (siteId IS NULL).
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

    const handler = this.getHandler(key);
    try {
      await handler.uninstallFromServer();
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.error(`Service ${key} uninstall failed: ${msg}`);
      await this.upsertServerRecord(key, { lastError: msg });
      throw new BadRequestException(`Удаление «${catalog.name}» провалилось: ${msg}`);
    }
    await this.prisma.serverService.update({
      where: { serviceKey: key },
      data: { installed: false, version: null, installedAt: null, lastError: null },
    });
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

  async enableSiteService(siteId: string, key: string, config: Record<string, unknown> = {}) {
    const site = await this.requireSite(siteId);
    const catalog = findServiceEntry(key);
    if (!catalog) throw new NotFoundException(`Unknown service "${key}"`);

    if (getServiceScope(catalog) === 'global') {
      throw new ConflictException(
        `«${catalog.name}» — глобальный сервис, его нельзя активировать на одном сайте. БД создаётся через раздел «Базы данных».`,
      );
    }

    const server = await this.prisma.serverService.findUnique({ where: { serviceKey: key } });
    if (!server || !server.installed) {
      throw new ConflictException(
        `Сервис "${catalog.name}" не установлен на сервере. Установи его сначала на странице Сервисы.`,
      );
    }

    const exists = await this.prisma.siteService.findUnique({
      where: { siteId_serviceKey: { siteId, serviceKey: key } },
    });
    if (exists) {
      throw new ConflictException(`Сервис "${catalog.name}" уже активирован для этого сайта`);
    }

    const handler = this.getHandler(key);
    const ctx = this.toCtx(site);

    // Создаём запись со статусом STARTING
    const rec = await this.prisma.siteService.create({
      data: {
        siteId,
        serviceKey: key,
        status: 'STARTING',
        config: JSON.stringify(config || {}),
      },
    });

    try {
      await handler.enableForSite(ctx, config || {});
      await this.prisma.siteService.update({
        where: { id: rec.id },
        data: { status: 'RUNNING', lastError: null },
      });
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.error(`Service ${key} enable for site ${site.name} failed: ${msg}`);
      await this.prisma.siteService.update({
        where: { id: rec.id },
        data: { status: 'ERROR', lastError: msg },
      });
      throw new BadRequestException(`Активация «${catalog.name}» провалилась: ${msg}`);
    }

    return this.getSiteService(siteId, key);
  }

  async disableSiteService(siteId: string, key: string): Promise<void> {
    const site = await this.requireSite(siteId);
    const rec = await this.prisma.siteService.findUnique({
      where: { siteId_serviceKey: { siteId, serviceKey: key } },
    });
    if (!rec) return; // Идемпотентно
    const handler = this.getHandler(key);
    try {
      await handler.disableForSite(this.toCtx(site));
    } catch (err) {
      // Деактивация — фиксируем ошибку в БД, но запись удаляем всё равно
      // (иначе сайт «застрянет» с битым стейтом и переактивировать нельзя).
      this.logger.error(`Service ${key} disable for site ${site.name} failed: ${(err as Error).message}`);
    } finally {
      await this.prisma.siteService.delete({ where: { id: rec.id } });
    }
  }

  async startSiteService(siteId: string, key: string) {
    const site = await this.requireSite(siteId);
    const rec = await this.requireRecord(siteId, key);
    const handler = this.getHandler(key);
    try {
      await handler.startForSite(this.toCtx(site));
      await this.prisma.siteService.update({
        where: { id: rec.id },
        data: { status: 'RUNNING', lastError: null },
      });
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.error(`Service ${key} start for site ${site.name} failed: ${msg}`);
      await this.prisma.siteService.update({
        where: { id: rec.id },
        data: { status: 'ERROR', lastError: msg },
      });
      throw new BadRequestException(`Запуск сервиса провалился: ${msg}`);
    }
    return this.getSiteService(siteId, key);
  }

  async stopSiteService(siteId: string, key: string) {
    const site = await this.requireSite(siteId);
    const rec = await this.requireRecord(siteId, key);
    const handler = this.getHandler(key);
    try {
      await handler.stopForSite(this.toCtx(site));
      await this.prisma.siteService.update({
        where: { id: rec.id },
        data: { status: 'STOPPED', lastError: null },
      });
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.error(`Service ${key} stop for site ${site.name} failed: ${msg}`);
      await this.prisma.siteService.update({
        where: { id: rec.id },
        data: { status: 'ERROR', lastError: msg },
      });
      throw new BadRequestException(`Остановка сервиса провалилась: ${msg}`);
    }
    return this.getSiteService(siteId, key);
  }

  async reconfigureSiteService(siteId: string, key: string, config: Record<string, unknown>) {
    const site = await this.requireSite(siteId);
    const rec = await this.requireRecord(siteId, key);
    const handler = this.getHandler(key);
    try {
      await handler.reconfigureForSite(this.toCtx(site), config || {});
      await this.prisma.siteService.update({
        where: { id: rec.id },
        data: { config: JSON.stringify(config || {}), lastError: null },
      });
    } catch (err) {
      await this.prisma.siteService.update({
        where: { id: rec.id },
        data: { lastError: (err as Error).message },
      });
      throw err;
    }
    return this.getSiteService(siteId, key);
  }

  async getSiteServiceLogs(siteId: string, key: string, lines = 200): Promise<string> {
    const site = await this.requireSite(siteId);
    await this.requireRecord(siteId, key);
    const handler = this.getHandler(key);
    return handler.logsForSite(this.toCtx(site), lines);
  }

  /**
   * Возвращает короткоживущий ticket для входа в Adminer без формы,
   * подключённый к Manticore этого сайта через unix-socket.
   *
   * Manticore говорит на mysql41 — Adminer-овский MySQL-драйвер цепляется
   * через `mysqli_real_connect(host=localhost, ..., socket=/path/.sock)`.
   * Авторизации в Manticore нет, поэтому user/pass — пустые строки.
   *
   * Безопасность:
   *   - TTL 60 секунд (одноразовый short-lived токен).
   *   - Доступ проверяется на уровне роута (только админ).
   *   - Сокет принадлежит site-юзеру; www-data в его группе → connect ок.
   */
  async createManticoreAdminerTicket(siteId: string): Promise<{ url: string }> {
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

    const now = Math.floor(Date.now() / 1000);
    const ticket = encryptToken({
      v: 1,
      kind: 'sso',
      service: 'manticore',
      site: site.name,
      siteId: site.id,
      driver: 'server',
      host: 'localhost',
      socket,
      port: null,
      user: '',
      pass: '',
      database: '',
      iat: now,
      exp: now + 60,
    });

    return { url: `/adminer/sso.php?ticket=${ticket}` };
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
