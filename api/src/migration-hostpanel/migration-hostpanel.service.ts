import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { randomBytes } from 'crypto';

import { PrismaService } from '../common/prisma.service';
import { AgentGateway } from '../gateway/agent.gateway';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { ServicesService } from '../services/services.service';
import {
  assertMigrationSecretConfigured,
  decryptMigrationSecret,
  encryptMigrationSecret,
} from '../common/crypto/migration-cipher';
import { hashPassword } from '../common/crypto/argon2.helper';
import { encryptJson } from '../common/crypto/credentials-cipher';
import { encryptSshPassword } from '../common/crypto/ssh-cipher';
import { encryptCmsPassword } from '../common/crypto/cms-cipher';
import { stringifySiteAliases, stringifyStringArray } from '../common/json-array';
import {
  CreateSavedSourceDto,
  MigrationSourceDto,
  StartDiscoveryDto,
  StartProbeDto,
  StartRunDto,
  UpdatePlanItemDto,
} from './migration-hostpanel.dto';
import {
  DiscoveryResult,
  PlanItem,
  PlanItemCronJob,
  ShortlistResult,
} from './plan-item.types';

interface SourceStored {
  host: string;
  port: number;
  sshUser: string;
  sshPassEnc: string;
  mysqlHost: string;
  mysqlPort: number;
  mysqlUser: string;
  mysqlPassEnc: string;
  hostpanelDb: string;
  hostpanelTablePrefix: string;
}

interface SourceDecrypted {
  host: string;
  port: number;
  sshUser: string;
  sshPassword: string;
  mysqlHost: string;
  mysqlPort: number;
  mysqlUser: string;
  mysqlPassword: string;
  hostpanelDb: string;
  hostpanelTablePrefix: string;
}

const LOG_TAIL_LIMIT = 500_000; // 500 KB
const ITEM_LOG_TAIL_LIMIT = 200_000; // 200 KB

// Лог-флуш: коалесцируем строки от агента, пишем в SQLite пакетом раз в N мс.
// Без этого db-dump-import шлёт сотни строк в секунду → SQLite-локи →
// PrismaClient timeout → unhandledRejection → API уходит в рестарт →
// item помечается orphan FAILED. Buffer + ловля ошибок устраняют каскад.
const LOG_FLUSH_INTERVAL_MS = 750;
const LOG_BUFFER_MAX_PER_KEY = 256_000; // hard cap, чтобы не съесть RAM

@Injectable()
export class MigrationHostpanelService implements OnModuleInit {
  private readonly logger = new Logger('MigrationHostpanelService');

  // In-memory флаги паузы — pause останавливает запуск следующих items.
  private readonly pausedRuns = new Set<string>();

  // Буферы логов: ключ → накопленный хвост строк, ещё не записанный в БД.
  private readonly itemLogBuffer = new Map<string, string>();
  private readonly migrationLogBuffer = new Map<string, string>();
  private logFlushTimer: NodeJS.Timeout | null = null;
  private logFlushInFlight: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
    private readonly servicesService: ServicesService,
    @Inject(forwardRef(() => AgentGateway))
    private readonly agentGateway: AgentGateway,
  ) {}

  onModuleInit() {
    try {
      assertMigrationSecretConfigured();
    } catch (e) {
      this.logger.warn(
        `MIGRATION_SECRET не настроен: ${(e as Error).message}. ` +
          `Миграция hostPanel не будет работать до bootstrap'а.`,
      );
    }
    // Orphan reconciliation: если API убили (рестарт/краш) во время живой
    // миграции, в БД остаются hostpanelMigrationItem.status=RUNNING без
    // активного агентского процесса. Без этого UI бесконечно показывает
    // «db-dump-import выполняется», хотя по факту никто не работает.
    // Помечаем как FAILED с понятной причиной, оператор видит и жмёт retry.
    void this.reconcileOrphanRunningOnStartup().catch((e) =>
      this.logger.error(
        `Orphan reconciliation failed: ${(e as Error).message}`,
      ),
    );
  }

  private async reconcileOrphanRunningOnStartup(): Promise<void> {
    const orphans = await this.prisma.hostpanelMigrationItem.findMany({
      where: { status: 'RUNNING' },
      select: { id: true, migrationId: true, currentStage: true },
    });
    if (orphans.length === 0) return;
    const errorMsg =
      'API был перезапущен во время миграции — стейдж прерван. ' +
      'Состояние в БД могло остаться неконсистентным (юзер/файлы/БД на slave). ' +
      'Нажми «🧹 Очистить и повторить» — мастер откатит артефакты и запустит item заново.';
    for (const o of orphans) {
      await this.prisma.hostpanelMigrationItem.update({
        where: { id: o.id },
        data: {
          status: 'FAILED',
          errorMsg,
          finishedAt: new Date(),
        },
      });
      this.logger.warn(
        `Orphan RUNNING item ${o.id} (stage=${o.currentStage}) → FAILED`,
      );
      try {
        await this.recomputeMigrationFinalStatus(o.migrationId);
      } catch (e) {
        this.logger.error(
          `Recompute migration status for ${o.migrationId} failed: ${(e as Error).message}`,
        );
      }
    }
  }

  // ─── Discovery ─────────────────────────────────────────────────────────

  async startDiscovery(dto: StartDiscoveryDto, userId: string, role: string) {
    this.assertAdmin(role);

    if (!this.agentRelay.isAgentConnected()) {
      throw new InternalServerErrorException(
        'Agent оффлайн — миграция требует подключённого агента',
      );
    }

    // Принимаем либо source (новые креды), либо sourceId (выбор сохранённого
    // пресета). Если есть source — используем его (даже если sourceId тоже
    // передан), но если sourceId есть — обновим lastUsedAt у пресета, чтобы
    // он всплыл наверх в списке.
    let resolvedSource: MigrationSourceDto;
    if (dto.source) {
      resolvedSource = dto.source;
    } else if (dto.sourceId) {
      resolvedSource = await this.resolveSavedSource(dto.sourceId);
    } else {
      throw new BadRequestException(
        'Нужны либо source (полные креды), либо sourceId (сохранённый пресет)',
      );
    }

    if (dto.sourceId) {
      // Идемпотентно — если пресета уже нет (удалили), молча пропускаем.
      await this.prisma.hostpanelMigrationSource
        .update({
          where: { id: dto.sourceId },
          data: { lastUsedAt: new Date() },
        })
        .catch(() => undefined);
    }

    const stored = this.encodeSource(resolvedSource);

    const migration = await this.prisma.hostpanelMigration.create({
      data: {
        status: 'DISCOVERING',
        source: JSON.stringify(stored),
        createdBy: userId,
      },
    });

    // Phase 1 — shortlist (быстрый probe без тяжёлых per-site операций).
    void this.runShortlistAsync(migration.id, resolvedSource).catch((e) =>
      this.logger.error(
        `Shortlist ${migration.id} failed: ${(e as Error).message}`,
      ),
    );

    return { id: migration.id, status: 'DISCOVERING' };
  }

  // ─── Saved source presets (CRUD) ──────────────────────────────────────

  async listSavedSources(role: string) {
    this.assertAdmin(role);
    const rows = await this.prisma.hostpanelMigrationSource.findMany({
      orderBy: [
        { lastUsedAt: 'desc' },
        { updatedAt: 'desc' },
      ],
    });
    // Никогда не отдаём наружу зашифрованные пароли. Только публичные поля.
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      host: r.host,
      port: r.port,
      sshUser: r.sshUser,
      mysqlHost: r.mysqlHost,
      mysqlPort: r.mysqlPort,
      mysqlUser: r.mysqlUser,
      hostpanelDb: r.hostpanelDb,
      hostpanelTablePrefix: r.hostpanelTablePrefix,
      lastUsedAt: r.lastUsedAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  async createSavedSource(
    dto: CreateSavedSourceDto,
    userId: string,
    role: string,
  ) {
    this.assertAdmin(role);
    try {
      const row = await this.prisma.hostpanelMigrationSource.create({
        data: {
          name: dto.name,
          host: dto.host,
          port: dto.port,
          sshUser: dto.sshUser,
          sshPassEnc: encryptMigrationSecret({ pass: dto.sshPassword }),
          mysqlHost: dto.mysqlHost,
          mysqlPort: dto.mysqlPort,
          mysqlUser: dto.mysqlUser,
          mysqlPassEnc: encryptMigrationSecret({ pass: dto.mysqlPassword }),
          hostpanelDb: dto.hostpanelDb,
          hostpanelTablePrefix: dto.hostpanelTablePrefix,
          createdBy: userId,
        },
      });
      return { id: row.id, name: row.name };
    } catch (e: unknown) {
      // Prisma выкидывает P2002 при нарушении UNIQUE(host, sshUser, mysqlUser).
      const err = e as { code?: string };
      if (err.code === 'P2002') {
        throw new ConflictException(
          'Пресет с такой парой host + ssh-user + mysql-user уже сохранён',
        );
      }
      throw e;
    }
  }

  async deleteSavedSource(id: string, role: string) {
    this.assertAdmin(role);
    try {
      await this.prisma.hostpanelMigrationSource.delete({ where: { id } });
    } catch (e: unknown) {
      const err = e as { code?: string };
      if (err.code === 'P2025') {
        throw new NotFoundException('Сохранённый источник не найден');
      }
      throw e;
    }
    return { success: true };
  }

  /**
   * Расшифровывает сохранённый пресет в полноценный MigrationSourceDto.
   * Используется только внутри startDiscovery — никогда не отдаётся в API
   * наружу (пароли в открытом виде покидают сервер только через зашифрованный
   * канал к агенту).
   */
  private async resolveSavedSource(id: string): Promise<MigrationSourceDto> {
    const row = await this.prisma.hostpanelMigrationSource.findUnique({
      where: { id },
    });
    if (!row) {
      throw new NotFoundException('Сохранённый источник не найден');
    }
    return {
      host: row.host,
      port: row.port,
      sshUser: row.sshUser,
      sshPassword: decryptMigrationSecret<{ pass: string }>(row.sshPassEnc).pass,
      mysqlHost: row.mysqlHost,
      mysqlPort: row.mysqlPort,
      mysqlUser: row.mysqlUser,
      mysqlPassword: decryptMigrationSecret<{ pass: string }>(row.mysqlPassEnc)
        .pass,
      hostpanelDb: row.hostpanelDb,
      hostpanelTablePrefix: row.hostpanelTablePrefix,
    };
  }

  /**
   * Phase 1 — shortlist. Получает от агента быстрый список сайтов (без
   * du/DB-size/nginx-парсинга), создаёт HostpanelMigrationItem с placeholder
   * plan'ом (минимальные поля). Статус миграции: DISCOVERING → SHORTLIST_READY.
   *
   * После этого UI показывает Step 2 «Выбор сайтов», оператор отмечает
   * галочки и шлёт POST /:id/probe → startProbeSelected (Phase 2).
   */
  private async runShortlistAsync(
    migrationId: string,
    source: MigrationSourceDto,
  ): Promise<void> {
    try {
      const result = await this.agentRelay.emitToAgent<ShortlistResult>(
        'migrate:hostpanel:shortlist',
        { source, migrationId },
        300_000,
      );

      if (!result.success || !result.data) {
        await this.prisma.hostpanelMigration.update({
          where: { id: migrationId },
          data: {
            status: 'FAILED',
            errorMessage: result.error || 'Shortlist вернул пустой результат',
            finishedAt: new Date(),
          },
        });
        return;
      }

      const shortlist = result.data;
      const sourceRows = shortlist.sourceRows || {};

      await this.prisma.$transaction([
        ...shortlist.items.map((item) => {
          // Placeholder plan: содержит достаточно полей чтобы UI отрисовал
          // Step 2-таблицу. Реальные du/DB-size/nginx будут заполнены на
          // Phase 2 (deep probe). Поля помечены `isShortlist: true` —
          // если UI получит item с этим флагом и открытым «План» step,
          // покажет «загружается».
          const placeholderPlan = {
            sourceSiteId: item.sourceSiteId,
            sourceUser: item.sourceUser,
            sourceDomain: item.sourceDomain,
            sourceWebroot: `/var/www/${item.sourceUser}/www/`,
            sourceCms: item.sourceCms,
            sourceCmsVersion: item.sourceCmsVersion,
            sourcePhpVersion: item.sourcePhpVersion,
            sourceMysqlPrefix: '',
            sourceMysqlDb: item.sourceMysqlDb,
            sourceName: item.sourceName,
            newName: item.newName,
            newDomain: item.newDomain,
            newAliases: [],
            aliasesRedirectToMain: false,
            phpVersion: item.sourcePhpVersion || '8.2',
            homeIncludes: [],
            rsyncExtraExcludes: [],
            dbExcludeDataTables: [],
            cronJobs: [],
            ssl: null,
            manticore: { enable: false },
            modxPaths: { connectorsDir: 'connectors', managerDir: 'manager' },
            phpFpm: {
              pm: 'ondemand',
              pmMaxChildren: 10,
              uploadMaxFilesize: '100M',
              postMaxSize: '100M',
              memoryLimit: '256M',
              custom: '',
            },
            nginxCustomConfig: '',
            nginxHsts: false,
            filesRelPath: 'www',
            fsBytes: item.fsBytesApprox || 0,
            dbBytes: 0,
            warnings: item.warnings,
            blockedReason: item.blockedReason,
            // Marker: UI знает что это shortlist-stub — рендерит Step 2,
            // не Step 3 (полный план не готов).
            isShortlist: true,
            defaultSelected: item.defaultSelected,
          };
          return this.prisma.hostpanelMigrationItem.create({
            data: {
              migrationId,
              sourceSiteId: item.sourceSiteId,
              sourceData: JSON.stringify(sourceRows[item.sourceSiteId] || {}),
              plan: JSON.stringify(placeholderPlan),
              status: item.blockedReason ? 'BLOCKED' : 'PLANNED',
            },
          });
        }),
        this.prisma.hostpanelMigration.update({
          where: { id: migrationId },
          data: {
            status: 'SHORTLIST_READY',
            discovery: JSON.stringify({
              sourceMeta: shortlist.sourceMeta,
              systemCronJobs: shortlist.systemCronJobs,
              warnings: shortlist.warnings,
            }),
            totalSites: shortlist.items.length,
          },
        }),
      ]);
    } catch (err) {
      await this.prisma.hostpanelMigration.update({
        where: { id: migrationId },
        data: {
          status: 'FAILED',
          errorMessage: (err as Error).message,
          finishedAt: new Date(),
        },
      });
      throw err;
    }
  }

  /**
   * Phase 2 — deep probe только по выбранным сайтам. Принимает itemIds
   * (UUID HostpanelMigrationItem), мапит их в sourceSiteId и шлёт агенту.
   * Items не из списка помечаются SKIPPED. Статус миграции:
   * SHORTLIST_READY → PROBING → READY (или FAILED при провале).
   */
  async startProbeSelected(
    id: string,
    dto: StartProbeDto,
    role: string,
  ): Promise<{ id: string; status: string }> {
    this.assertAdmin(role);
    if (!this.agentRelay.isAgentConnected()) {
      throw new InternalServerErrorException('Agent оффлайн');
    }
    const migration = await this.prisma.hostpanelMigration.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!migration) throw new NotFoundException('Migration not found');
    if (migration.status !== 'SHORTLIST_READY') {
      throw new ConflictException(
        `Probe доступен только в статусе SHORTLIST_READY (сейчас ${migration.status})`,
      );
    }
    if (!dto.itemIds || dto.itemIds.length === 0) {
      throw new BadRequestException('Не выбрано ни одного сайта');
    }

    // Валидация: все itemIds принадлежат этой миграции
    const itemMap = new Map(migration.items.map((it) => [it.id, it]));
    const selectedItems = dto.itemIds
      .map((iid) => itemMap.get(iid))
      .filter((it): it is NonNullable<typeof it> => !!it);
    if (selectedItems.length !== dto.itemIds.length) {
      throw new BadRequestException(
        'Некоторые itemIds не относятся к этой миграции',
      );
    }
    const sourceSiteIds = selectedItems.map((it) => it.sourceSiteId);

    // Status → PROBING + non-selected items → SKIPPED
    const skipIds = migration.items
      .filter((it) => !dto.itemIds.includes(it.id))
      .map((it) => it.id);

    await this.prisma.$transaction([
      this.prisma.hostpanelMigration.update({
        where: { id },
        data: { status: 'PROBING' },
      }),
      ...(skipIds.length > 0
        ? [
            this.prisma.hostpanelMigrationItem.updateMany({
              where: { id: { in: skipIds } },
              data: { status: 'SKIPPED', finishedAt: new Date() },
            }),
          ]
        : []),
    ]);

    const decoded = this.decodeSource(JSON.parse(migration.source) as SourceStored);
    void this.runDeepProbeAsync(id, decoded, sourceSiteIds, dto.itemIds).catch((e) =>
      this.logger.error(`Deep probe ${id} failed: ${(e as Error).message}`),
    );

    return { id, status: 'PROBING' };
  }

  /**
   * Phase 2 internals — дёргает агентский handler `migrate:hostpanel:probe-selected`,
   * получает полный DiscoveryResult по выбранным sourceSiteIds, и обновляет
   * соответствующие HostpanelMigrationItem.plan на полные. Системные cron'ы
   * НЕ перезаписываются (они уже сохранены на phase 1 в migration.discovery).
   */
  private async runDeepProbeAsync(
    migrationId: string,
    source: SourceDecrypted,
    sourceSiteIds: number[],
    selectedItemIds: string[],
  ): Promise<void> {
    try {
      const result = await this.agentRelay.emitToAgent<DiscoveryResult>(
        'migrate:hostpanel:probe-selected',
        { source, migrationId, sourceSiteIds },
        900_000,
      );

      if (!result.success || !result.data) {
        await this.prisma.hostpanelMigration.update({
          where: { id: migrationId },
          data: {
            status: 'FAILED',
            errorMessage: result.error || 'Deep probe пустой результат',
            finishedAt: new Date(),
          },
        });
        return;
      }

      const discovery = result.data;
      // Map sourceSiteId → PlanItem (полный) от агента
      const planById = new Map<number, PlanItem>();
      for (const site of discovery.sites) {
        planById.set(site.sourceSiteId, site);
      }

      // Обновляем выбранные items с полным планом. Если агент не вернул
      // план для какого-то id (сайт удалился между shortlist'ом и probe'ом)
      // — помечаем item FAILED.
      const updates: Promise<unknown>[] = [];
      for (const itemId of selectedItemIds) {
        const item = await this.prisma.hostpanelMigrationItem.findUnique({
          where: { id: itemId },
        });
        if (!item) continue;
        const fullPlan = planById.get(item.sourceSiteId);
        if (!fullPlan) {
          updates.push(
            this.prisma.hostpanelMigrationItem.update({
              where: { id: itemId },
              data: {
                status: 'FAILED',
                errorMsg:
                  'Сайт исчез с источника между shortlist\'ом и probe\'ом',
                finishedAt: new Date(),
              },
            }),
          );
          continue;
        }
        updates.push(
          this.prisma.hostpanelMigrationItem.update({
            where: { id: itemId },
            data: {
              plan: JSON.stringify(fullPlan),
              status: fullPlan.blockedReason ? 'BLOCKED' : 'PLANNED',
            },
          }),
        );
      }
      await Promise.all(updates);

      // Обновляем discovery в migration — добавляем актуальные sourceMeta/cron
      // (cron мог обновиться, sourceMeta может содержать php-versions с
      // новыми установками между phase 1 и 2).
      await this.prisma.hostpanelMigration.update({
        where: { id: migrationId },
        data: {
          status: 'READY',
          discovery: JSON.stringify({
            sourceMeta: discovery.sourceMeta,
            systemCronJobs: discovery.systemCronJobs,
            warnings: discovery.warnings,
          }),
        },
      });
    } catch (err) {
      await this.prisma.hostpanelMigration.update({
        where: { id: migrationId },
        data: {
          status: 'FAILED',
          errorMessage: (err as Error).message,
          finishedAt: new Date(),
        },
      });
      throw err;
    }
  }

  // ─── Чтение ────────────────────────────────────────────────────────────

  async findAll(role: string) {
    this.assertAdmin(role);
    return this.prisma.hostpanelMigration.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        status: true,
        totalSites: true,
        doneSites: true,
        failedSites: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
        errorMessage: true,
      },
    });
  }

  async findOne(id: string, role: string) {
    this.assertAdmin(role);
    const migration = await this.prisma.hostpanelMigration.findUnique({
      where: { id },
      include: { items: { orderBy: { sourceSiteId: 'asc' } } },
    });
    if (!migration) throw new NotFoundException('Migration not found');

    const stored = JSON.parse(migration.source) as SourceStored;
    const sourceMeta = {
      host: stored.host,
      port: stored.port,
      sshUser: stored.sshUser,
      mysqlHost: stored.mysqlHost,
      mysqlPort: stored.mysqlPort,
      mysqlUser: stored.mysqlUser,
      hostpanelDb: stored.hostpanelDb,
      hostpanelTablePrefix: stored.hostpanelTablePrefix,
    };

    return {
      id: migration.id,
      status: migration.status,
      totalSites: migration.totalSites,
      doneSites: migration.doneSites,
      failedSites: migration.failedSites,
      createdAt: migration.createdAt,
      startedAt: migration.startedAt,
      finishedAt: migration.finishedAt,
      errorMessage: migration.errorMessage,
      sourceMeta,
      discovery: migration.discovery ? JSON.parse(migration.discovery) : null,
      log: migration.log,
      paused: this.pausedRuns.has(migration.id),
      items: migration.items.map((it) => ({
        id: it.id,
        sourceSiteId: it.sourceSiteId,
        status: it.status,
        progressPercent: it.progressPercent,
        currentStage: it.currentStage,
        errorMsg: it.errorMsg,
        newSiteId: it.newSiteId,
        startedAt: it.startedAt,
        finishedAt: it.finishedAt,
        plan: JSON.parse(it.plan) as PlanItem,
        log: it.log,
      })),
    };
  }

  async getLog(id: string, role: string): Promise<{ log: string }> {
    this.assertAdmin(role);
    const m = await this.prisma.hostpanelMigration.findUnique({
      where: { id },
      select: { log: true },
    });
    if (!m) throw new NotFoundException('Migration not found');
    return { log: m.log || '' };
  }

  // ─── PlanItem редактирование ──────────────────────────────────────────

  async updatePlanItem(
    id: string,
    itemId: string,
    dto: UpdatePlanItemDto,
    role: string,
  ) {
    this.assertAdmin(role);
    const item = await this.prisma.hostpanelMigrationItem.findUnique({
      where: { id: itemId },
      include: { migration: { select: { id: true, status: true } } },
    });
    if (!item || item.migrationId !== id) {
      throw new NotFoundException('Item not found');
    }
    if (
      item.migration.status !== 'READY' &&
      item.migration.status !== 'PLANNED' &&
      item.migration.status !== 'PARTIAL'
    ) {
      throw new BadRequestException(
        `Нельзя редактировать план в статусе ${item.migration.status}`,
      );
    }

    let parsed: PlanItem;
    try {
      parsed = JSON.parse(dto.planJson) as PlanItem;
    } catch {
      throw new BadRequestException('Plan JSON некорректен');
    }
    if (!parsed.newName || !parsed.newDomain) {
      throw new BadRequestException('newName и newDomain обязательны');
    }

    return this.prisma.hostpanelMigrationItem.update({
      where: { id: itemId },
      data: { plan: JSON.stringify(parsed) },
    });
  }

  async skipItem(id: string, itemId: string, role: string) {
    this.assertAdmin(role);
    const item = await this.prisma.hostpanelMigrationItem.findUnique({
      where: { id: itemId },
    });
    if (!item || item.migrationId !== id) {
      throw new NotFoundException('Item not found');
    }
    if (item.status === 'RUNNING' || item.status === 'DONE') {
      throw new BadRequestException(
        `Нельзя пропустить item в статусе ${item.status}`,
      );
    }
    await this.prisma.hostpanelMigrationItem.update({
      where: { id: itemId },
      data: { status: 'SKIPPED', finishedAt: new Date() },
    });
    return { id: itemId, status: 'SKIPPED' };
  }

  /**
   * Проверяет можно ли force-retry'ить FAILED-item: есть ли leak от
   * предыдущей попытки той же миграции, не занят ли name живой миграцией
   * другого migration_id.
   *
   * Логика:
   *  1. item должен быть FAILED
   *  2. имя `plan.newName` НЕ должно быть в `Site.name` (если оно там —
   *     значит это полноценный сайт, чужой; force-cleanup такое сносить
   *     нельзя)
   *  3. Не должно быть RUNNING-миграции, которая использует это имя в плане
   *     (даже не текущая) — иначе force-cleanup выкосит работающий процесс
   *  4. На slave должны быть РЕАЛЬНЫЕ артефакты с этим именем (linux user
   *     или /var/www/<name> или mariadb db) — иначе нечего «чистить»,
   *     просто retry хватит
   */
  async checkForceRetry(id: string, itemId: string, role: string) {
    this.assertAdmin(role);
    const item = await this.prisma.hostpanelMigrationItem.findUnique({
      where: { id: itemId },
      include: { migration: true },
    });
    if (!item || item.migrationId !== id) {
      throw new NotFoundException('Item not found');
    }
    if (item.status !== 'FAILED') {
      return {
        canForceRetry: false,
        reason: `Item в статусе ${item.status} — force-retry доступен только для FAILED`,
      };
    }
    const plan = JSON.parse(item.plan) as { newName: string; newDomain?: string; phpVersion?: string };
    const name = plan.newName;
    if (!name || !/^[a-z][a-z0-9_-]{0,31}$/.test(name)) {
      return { canForceRetry: false, reason: `Невалидное name: ${name}` };
    }
    // 1. Реально занятый Site с таким именем — НЕЛЬЗЯ
    const realSite = await this.prisma.site.findUnique({
      where: { name },
      select: { id: true, name: true, status: true },
    });
    if (realSite) {
      return {
        canForceRetry: false,
        reason: `Имя '${name}' уже принадлежит реальному сайту в meowbox (status=${realSite.status}). Это не leak — это работающий сайт.`,
      };
    }
    // 2. Другая ДЕЙСТВИТЕЛЬНО активная миграция с тем же именем — НЕЛЬЗЯ.
    // Учитываем статус самой миграции: если она CANCELLED/FAILED/PARTIAL —
    // её RUNNING items являются зомби (cancel/crash не каскадировал),
    // их нужно проигнорить и заодно прибить, чтобы не светились дальше.
    const runningOther = await this.prisma.hostpanelMigrationItem.findFirst({
      where: {
        status: 'RUNNING',
        migrationId: { not: id },
        plan: { contains: `"newName":"${name}"` },
        migration: { status: 'RUNNING' },
      },
      select: { id: true, migrationId: true },
    });
    if (runningOther) {
      return {
        canForceRetry: false,
        reason: `Активная другая миграция (${runningOther.migrationId}) сейчас обрабатывает '${name}'. Дождись её или отмени, потом повтори.`,
      };
    }
    // Auto-heal: если нашли RUNNING items, чьи миграции уже не RUNNING —
    // прибиваем их прямо здесь (idempotent, безопасно).
    const zombieIds = await this.prisma.hostpanelMigrationItem.findMany({
      where: {
        status: 'RUNNING',
        plan: { contains: `"newName":"${name}"` },
        migration: { status: { not: 'RUNNING' } },
      },
      select: { id: true, migrationId: true },
    });
    if (zombieIds.length > 0) {
      await this.prisma.hostpanelMigrationItem.updateMany({
        where: { id: { in: zombieIds.map((z) => z.id) } },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          errorMsg: 'Zombie cleanup: миграция уже не RUNNING, item остался висеть',
        },
      });
      this.logger.warn(
        `[force-retry-check] auto-healed ${zombieIds.length} zombie items for name='${name}': ${zombieIds.map((z) => z.id).join(', ')}`,
      );
    }
    // 3. Запрашиваем агента: есть ли реальные артефакты на slave?
    if (!this.agentRelay.isAgentConnected()) {
      return { canForceRetry: false, reason: 'Agent оффлайн — нечем проверять артефакты' };
    }
    let leakSources: string[] = [];
    try {
      const probe = await this.agentRelay.emitToAgent<{
        userExists: boolean;
        homeExists: boolean;
        dbExists: boolean;
      }>('migrate:hostpanel:check-leak', { name }, 10_000);
      if (probe.success && probe.data) {
        if (probe.data.userExists) leakSources.push('linux-user');
        if (probe.data.homeExists) leakSources.push('home-dir');
        if (probe.data.dbExists) leakSources.push('mariadb-db');
      }
    } catch {
      return { canForceRetry: false, reason: 'Agent не ответил на check-leak за 10s' };
    }
    if (leakSources.length === 0) {
      return {
        canForceRetry: false,
        reason: `На slave нет leak'нутых артефактов с именем '${name}' — обычного retry должно хватить`,
      };
    }
    return {
      canForceRetry: true,
      name,
      leakSources,
    };
  }

  /**
   * Force-retry: дёргает агента на cleanup leak'нутых артефактов, потом
   * стандартный retry. Защищён от того же набора кейсов, что и
   * `checkForceRetry`.
   */
  async forceRetryItem(id: string, itemId: string, role: string) {
    this.assertAdmin(role);
    const check = await this.checkForceRetry(id, itemId, role);
    if (!check.canForceRetry) {
      throw new BadRequestException(check.reason || 'Force-retry заблокирован');
    }
    const item = await this.prisma.hostpanelMigrationItem.findUnique({
      where: { id: itemId },
    });
    if (!item) throw new NotFoundException('Item not found');
    const plan = JSON.parse(item.plan) as {
      newName: string;
      newDomain?: string;
      phpVersion?: string;
    };

    // Cleanup на агенте — синхронно (timeout 60s, как в handler'е)
    const cleanup = await this.agentRelay.emitToAgent<{ log: string[] }>(
      'migrate:hostpanel:force-cleanup-name',
      {
        name: plan.newName,
        domain: plan.newDomain,
        phpVersion: plan.phpVersion,
      },
      90_000,
    );
    if (!cleanup.success) {
      throw new InternalServerErrorException(
        `Force-cleanup упал: ${cleanup.error || 'unknown'}`,
      );
    }
    this.logger.log(
      `[force-retry ${itemId}] cleanup OK (${(cleanup.data?.log || []).length} steps): ${(cleanup.data?.log || []).join(' | ')}`,
    );
    // Дальше — обычный retry
    return this.retryItem(id, itemId, role);
  }

  async retryItem(id: string, itemId: string, role: string) {
    this.assertAdmin(role);
    const item = await this.prisma.hostpanelMigrationItem.findUnique({
      where: { id: itemId },
      include: { migration: true },
    });
    if (!item || item.migrationId !== id) {
      throw new NotFoundException('Item not found');
    }
    if (item.status !== 'FAILED' && item.status !== 'SKIPPED') {
      throw new BadRequestException(
        `Можно повторить только FAILED/SKIPPED item (текущий: ${item.status})`,
      );
    }
    if (item.migration.status === 'RUNNING') {
      throw new BadRequestException('Миграция уже выполняется');
    }
    if (!this.agentRelay.isAgentConnected()) {
      throw new InternalServerErrorException('Agent оффлайн');
    }

    // Сбрасываем статус item'а и запускаем только его
    await this.prisma.hostpanelMigrationItem.update({
      where: { id: itemId },
      data: {
        status: 'PLANNED',
        progressPercent: 0,
        currentStage: null,
        errorMsg: null,
        startedAt: null,
        finishedAt: null,
        log: '',
        newSiteId: null,
      },
    });
    await this.prisma.hostpanelMigration.update({
      where: { id },
      data: { status: 'RUNNING', startedAt: item.migration.startedAt || new Date(), finishedAt: null },
    });

    const decoded = this.decodeSource(JSON.parse(item.migration.source) as SourceStored);
    void this.runItemsSequential(id, [itemId], decoded, item.migration.createdBy).catch(
      (e) => this.logger.error(`Retry ${itemId} failed: ${(e as Error).message}`),
    );

    return { id: itemId, status: 'RETRYING' };
  }

  // ─── Live валидация ───────────────────────────────────────────────────

  async checkName(name: string, role: string) {
    this.assertAdmin(role);
    const conflictSite = await this.prisma.site.findUnique({
      where: { name },
      select: { id: true },
    });
    const conflictDb = await this.prisma.database.findUnique({
      where: { name },
      select: { id: true },
    });
    if (conflictSite || conflictDb) {
      return {
        available: false,
        reason: conflictSite
          ? 'Сайт с таким именем уже существует'
          : 'БД с таким именем уже существует',
        suggestions: await this.suggestFreeNames(name),
      };
    }

    if (this.agentRelay.isAgentConnected()) {
      try {
        const r = await this.agentRelay.emitToAgent<{ exists: boolean }>(
          'system:user-exists',
          { username: name },
          5_000,
        );
        if (r.success && r.data?.exists) {
          return {
            available: false,
            reason: 'Linux-юзер с таким именем уже существует',
            suggestions: await this.suggestFreeNames(name),
          };
        }
      } catch {
        /* not critical */
      }
    }

    return { available: true };
  }

  /**
   * Перебирает кандидатов `<base>-2`, `<base>-imported`, `<base>-old`, `<base>-3`,
   * `<base>-4` и возвращает первые 3 свободных. Только локальная БД-проверка —
   * без вопроса агенту, чтобы не плодить N round-trip'ов.
   */
  private async suggestFreeNames(base: string): Promise<string[]> {
    const trimmed = base.replace(/[^a-z0-9_-]/g, '').slice(0, 28);
    if (!trimmed) return [];
    const candidates = [
      `${trimmed}-2`,
      `${trimmed}-imported`,
      `${trimmed}-old`,
      `${trimmed}-3`,
      `${trimmed}-4`,
    ];
    const free: string[] = [];
    for (const c of candidates) {
      if (free.length >= 3) break;
      const [s, d] = await Promise.all([
        this.prisma.site.findUnique({ where: { name: c }, select: { id: true } }),
        this.prisma.database.findUnique({ where: { name: c }, select: { id: true } }),
      ]);
      if (!s && !d) free.push(c);
    }
    return free;
  }

  async checkDomain(domain: string, role: string) {
    this.assertAdmin(role);
    const conflict = await this.prisma.site.findUnique({
      where: { domain },
      select: { id: true, name: true },
    });
    if (conflict) {
      return {
        available: false,
        reason: `Сайт ${conflict.name} уже использует этот домен`,
      };
    }
    // spec §12.1: «Site.domain свободно + SiteAlias свободно».
    // Site.aliases — JSON-string (SQLite), массив либо строк, либо
    // {domain, redirect}-объектов. Простейший способ — substring LIKE по
    // сериализованному JSON. Точная проверка делается потом в JS, чтобы
    // отсеять false-positive (когда искомая строка лежит внутри другого
    // значения).
    const aliasCandidates = await this.prisma.site.findMany({
      where: { aliases: { contains: `"${domain}"` } },
      select: { id: true, name: true, aliases: true },
      take: 5,
    });
    for (const cand of aliasCandidates) {
      try {
        const parsed = JSON.parse(cand.aliases || '[]') as unknown;
        if (Array.isArray(parsed)) {
          const hit = parsed.some((a) => {
            if (typeof a === 'string') return a === domain;
            if (a && typeof a === 'object' && 'domain' in a) {
              return (a as { domain: string }).domain === domain;
            }
            return false;
          });
          if (hit) {
            return {
              available: false,
              reason: `Сайт ${cand.name} использует этот домен как алиас`,
            };
          }
        }
      } catch { /* JSON-parse errors — skip кандидат */ }
    }
    return { available: true };
  }

  // ─── Pause / Resume / Cancel ──────────────────────────────────────────

  async pause(id: string, role: string) {
    this.assertAdmin(role);
    const m = await this.prisma.hostpanelMigration.findUnique({ where: { id } });
    if (!m) throw new NotFoundException();
    if (m.status !== 'RUNNING') {
      throw new BadRequestException(`Pause доступен только в RUNNING (сейчас ${m.status})`);
    }
    this.pausedRuns.add(id);
    await this.appendMigrationLog(id, '⏸ pause запрошен — текущий item доделается, далее — стоп');
    return { id, paused: true };
  }

  async resume(id: string, role: string) {
    this.assertAdmin(role);
    const m = await this.prisma.hostpanelMigration.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!m) throw new NotFoundException();
    if (m.status !== 'RUNNING' || !this.pausedRuns.has(id)) {
      throw new BadRequestException('Pause не активен');
    }
    this.pausedRuns.delete(id);

    // Запускаем оставшиеся PLANNED items
    const planned = m.items.filter((it) => it.status === 'PLANNED');
    if (planned.length === 0) {
      await this.appendMigrationLog(id, '▶ resume — нечего продолжать');
      return { id, paused: false };
    }
    const decoded = this.decodeSource(JSON.parse(m.source) as SourceStored);
    void this.runItemsSequential(id, planned.map((it) => it.id), decoded, m.createdBy).catch(
      (e) => this.logger.error(`Resume failed: ${(e as Error).message}`),
    );
    return { id, paused: false };
  }

  async cancel(id: string, role: string) {
    this.assertAdmin(role);
    const migration = await this.prisma.hostpanelMigration.findUnique({
      where: { id },
    });
    if (!migration) throw new NotFoundException();
    if (
      migration.status !== 'RUNNING' &&
      migration.status !== 'PLANNED' &&
      migration.status !== 'READY'
    ) {
      throw new BadRequestException(`Нельзя отменить в статусе ${migration.status}`);
    }
    this.pausedRuns.delete(id);
    if (this.agentRelay.isAgentConnected()) {
      await this.agentRelay
        .emitToAgent('migrate:hostpanel:cancel', { migrationId: id })
        .catch(() => {});
    }
    // Помечаем все ещё-PLANNED items как SKIPPED (см. spec §5.3:
    // «текущий сайт rollback'ится, остальные — SKIPPED»).
    await this.prisma.hostpanelMigrationItem.updateMany({
      where: { migrationId: id, status: 'PLANNED' },
      data: { status: 'SKIPPED', finishedAt: new Date() },
    });
    // RUNNING items при cancel'е становятся зомби — рантайм агента уже
    // начал их обрабатывать, но мы прервали. Помечаем FAILED, иначе
    // force-retry guard позже примет их за «активную чужую миграцию».
    await this.prisma.hostpanelMigrationItem.updateMany({
      where: { migrationId: id, status: 'RUNNING' },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        errorMsg: 'Миграция отменена пользователем во время выполнения',
      },
    });
    await this.prisma.hostpanelMigration.update({
      where: { id },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });
    // spec §15.5: broadcast complete сразу при отмене (UI закрывает
    // прогресс-индикаторы, не ждёт finalStatus).
    try {
      const counts = await this.prisma.hostpanelMigrationItem.groupBy({
        by: ['status'],
        where: { migrationId: id },
        _count: { _all: true },
      });
      const totalDone = counts.find((c) => c.status === 'DONE')?._count._all || 0;
      const totalFailed = counts.find((c) => c.status === 'FAILED')?._count._all || 0;
      this.agentGateway.broadcastMigrationComplete(
        id,
        'CANCELLED',
        totalDone,
        totalFailed,
      );
    } catch { /* best-effort */ }
    return { id, status: 'CANCELLED' };
  }

  // ─── Запуск миграции ──────────────────────────────────────────────────

  async start(id: string, dto: StartRunDto, role: string) {
    this.assertAdmin(role);
    if (!this.agentRelay.isAgentConnected()) {
      throw new InternalServerErrorException('Agent оффлайн');
    }

    const migration = await this.prisma.hostpanelMigration.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!migration) throw new NotFoundException('Migration not found');
    if (migration.status !== 'READY' && migration.status !== 'PARTIAL') {
      throw new ConflictException(
        `Нельзя запустить в статусе ${migration.status}`,
      );
    }

    const selectedItems = migration.items.filter((it) =>
      dto.itemIds.includes(it.id),
    );
    if (selectedItems.length === 0) {
      throw new BadRequestException('Не выбрано ни одного сайта для миграции');
    }
    for (const it of selectedItems) {
      if (it.status === 'BLOCKED' || it.status === 'CONFLICT') {
        throw new BadRequestException(
          `Item ${it.id} в статусе ${it.status} — нельзя запустить`,
        );
      }
    }

    // Bulk-create system cron jobs (root) из discovery — спека §6.1 stage 9
    if (migration.discovery) {
      try {
        const disc = JSON.parse(migration.discovery) as {
          systemCronJobs?: PlanItemCronJob[];
        };
        if (disc.systemCronJobs && disc.systemCronJobs.length > 0) {
          await this.bulkCreateSystemCron(id, disc.systemCronJobs);
        }
      } catch (e) {
        this.logger.warn(`bulk system-cron import: ${(e as Error).message}`);
      }
    }

    await this.prisma.hostpanelMigration.update({
      where: { id },
      data: { status: 'RUNNING', startedAt: new Date() },
    });

    const decoded = this.decodeSource(JSON.parse(migration.source));
    void this.runItemsSequential(
      id,
      selectedItems.map((i) => i.id),
      decoded,
      migration.createdBy,
    ).catch((e) =>
      this.logger.error(`Migration ${id} run failed: ${(e as Error).message}`),
    );

    return { id, status: 'RUNNING', items: selectedItems.length };
  }

  // ─── Внутренний run-loop ──────────────────────────────────────────────

  private async runItemsSequential(
    migrationId: string,
    itemIds: string[],
    source: SourceDecrypted,
    createdBy: string,
  ): Promise<void> {
    let done = 0;
    let failed = 0;

    for (const itemId of itemIds) {
      // Pause: останавливаем перед запуском следующего item'а
      if (this.pausedRuns.has(migrationId)) {
        await this.appendMigrationLog(
          migrationId,
          `⏸ pause активен — выходим из цикла, оставшиеся items в PLANNED`,
        );
        break;
      }
      // spec §11.3: cancel race-defense. Если оператор нажал «Отменить»
      // между предыдущим item и стартом текущего — мастер переводит
      // migration в CANCELLED и шлёт `migrate:hostpanel:cancel` агенту.
      // Здесь — проверяем DB-состояние до запуска, чтобы не стартовать
      // следующий item в уже отменённой миграции.
      const m = await this.prisma.hostpanelMigration.findUnique({
        where: { id: migrationId },
        select: { status: true },
      });
      if (m && m.status === 'CANCELLED') {
        await this.appendMigrationLog(
          migrationId,
          `❌ migration в статусе CANCELLED — выходим из цикла, оставшиеся items не запускаем`,
        );
        break;
      }
      try {
        const item = await this.prisma.hostpanelMigrationItem.findUnique({
          where: { id: itemId },
        });
        if (!item) {
          this.logger.error(`Item ${itemId} not found, skipping`);
          continue;
        }
        await this.prisma.hostpanelMigrationItem.update({
          where: { id: itemId },
          data: { status: 'RUNNING', startedAt: new Date() },
        });
        const plan = JSON.parse(item.plan) as PlanItem;

        // SSL force-cleanup: если в БД панели нет ни одного Site и ни одного
        // SslCertificate с этим доменом — значит LE-папки на slave остались
        // как orphan после удаления сайта (`certbot revoke` фейлится для
        // migrated сертов из-за account mismatch, и delete-flow глотает
        // ошибку → файлы остаются). Без этого copy-ssl падает с
        // «уже существует на slave», и оператор вынужден чистить руками.
        // Считаем рассчётно перед каждым run-item — состояние БД могло
        // измениться между планированием и запуском.
        if (plan.ssl?.transfer && plan.newDomain) {
          const [siteUsing, sslUsing] = await Promise.all([
            this.prisma.site.count({ where: { domain: plan.newDomain } }),
            this.prisma.sslCertificate.findFirst({
              where: { domains: { contains: `"${plan.newDomain}"` } },
              select: { id: true },
            }),
          ]);
          if (siteUsing === 0 && !sslUsing) {
            plan.ssl = { ...plan.ssl, forceCleanStaleLE: true };
            await this.appendMigrationLog(
              migrationId,
              `🧹 ${plan.newDomain}: домен свободен в БД → агент снесёт orphan LE-артефакты перед copy-ssl`,
            );
          }
        }

        const result = await this.agentRelay.emitToAgent<{
          newSiteId?: string;
          ssl?: { notBefore: string | null; notAfter: string | null };
          verifyHttpCode?: string | null;
          creds?: {
            sshPassword: string | null;
            dbName: string | null;
            dbUser: string | null;
            dbPassword: string | null;
            cmsAdminUser: string | null;
            cmsAdminPassword: string | null;
          };
        }>(
          'migrate:hostpanel:run-item',
          { migrationId, itemId, source, plan },
          12 * 60 * 60 * 1000,
        );
        if (result.success) {
          // spec §11.3 guard: между ack-callback от агента и persist может
          // прийти cancel (`POST /:id/cancel`). Если миграция уже CANCELLED —
          // persist пропускаем, item помечаем SKIPPED. Иначе мы создадим
          // Site после отмены — состояние гонки.
          const stillRunning = await this.prisma.hostpanelMigration.findUnique({
            where: { id: migrationId },
            select: { status: true },
          });
          if (stillRunning?.status === 'CANCELLED') {
            await this.prisma.hostpanelMigrationItem.update({
              where: { id: itemId },
              data: {
                status: 'SKIPPED',
                errorMsg: 'отменено оператором между завершением стейджей и persist',
                finishedAt: new Date(),
              },
            });
            await this.appendMigrationLog(
              migrationId,
              `⚠ item ${itemId} завершился агентом, но миграция CANCELLED — persist пропущен`,
            );
            continue;
          }
          // Успех — создаём Site/Database/SslCertificate/CronJob записи
          try {
            const newSiteId = await this.persistMigratedSiteRecords(
              migrationId,
              itemId,
              plan,
              createdBy,
              {
                sslNotBefore: result.data?.ssl?.notBefore || null,
                sslNotAfter: result.data?.ssl?.notAfter || null,
                verifyHttpCode: result.data?.verifyHttpCode || null,
                creds: result.data?.creds || null,
              },
            );
            await this.prisma.hostpanelMigrationItem.update({
              where: { id: itemId },
              data: {
                status: 'DONE',
                newSiteId,
                progressPercent: 100,
                currentStage: 'mark-running',
                finishedAt: new Date(),
              },
            });
            done += 1;
          } catch (persistErr) {
            failed += 1;
            const msg =
              `Site/DB/SSL persist failed: ${(persistErr as Error).message}`;
            this.logger.error(`Item ${itemId} ${msg}`);
            await this.prisma.hostpanelMigrationItem.update({
              where: { id: itemId },
              data: {
                status: 'FAILED',
                errorMsg: msg,
                finishedAt: new Date(),
              },
            });
          }
        } else {
          failed += 1;
          this.logger.error(`Item ${itemId} failed: ${result.error}`);
          await this.prisma.hostpanelMigrationItem.update({
            where: { id: itemId },
            data: {
              status: 'FAILED',
              errorMsg: result.error || 'unknown',
              finishedAt: new Date(),
            },
          });
        }
      } catch (err) {
        failed += 1;
        this.logger.error(`Item ${itemId} threw: ${(err as Error).message}`);
        await this.prisma.hostpanelMigrationItem.update({
          where: { id: itemId },
          data: {
            status: 'FAILED',
            errorMsg: (err as Error).message,
            finishedAt: new Date(),
          },
        });
      }
    }

    // Финальный статус: учитываем все items миграции (а не только текущий
    // запуск), чтобы правильно ставить PARTIAL после retry/resume.
    await this.recomputeMigrationFinalStatus(migrationId);
  }

  private async recomputeMigrationFinalStatus(
    migrationId: string,
  ): Promise<void> {
    const all = await this.prisma.hostpanelMigrationItem.findMany({
      where: { migrationId },
      select: { status: true },
    });
    const totalDone = all.filter((i) => i.status === 'DONE').length;
    const totalFailed = all.filter((i) => i.status === 'FAILED').length;
    const totalRunning = all.filter((i) => i.status === 'RUNNING').length;
    const totalPlanned = all.filter((i) => i.status === 'PLANNED').length;

    if (totalRunning > 0) return; // ещё что-то крутится — не трогаем

    let finalStatus: 'DONE' | 'FAILED' | 'PARTIAL' | 'RUNNING';
    if (totalPlanned > 0) {
      finalStatus = 'RUNNING'; // ждём resume
    } else if (totalFailed === 0 && totalDone > 0) {
      finalStatus = 'DONE';
    } else if (totalDone === 0) {
      finalStatus = 'FAILED';
    } else {
      finalStatus = 'PARTIAL';
    }

    await this.prisma.hostpanelMigration.update({
      where: { id: migrationId },
      data: {
        status: finalStatus,
        doneSites: totalDone,
        failedSites: totalFailed,
        finishedAt: totalPlanned === 0 ? new Date() : null,
      },
    });

    // spec §15.5 broadcast: терминальный статус → разово сообщаем подписчикам.
    // Subscribers (Step 3 wizard в UI) уже подсчитывают done/failed по
    // item:status событиям, но это явный сигнал «миграция закончена» для
    // отрисовки финальной плашки + остановки прогресс-бара.
    if (finalStatus !== 'RUNNING') {
      try {
        this.agentGateway.broadcastMigrationComplete(
          migrationId,
          finalStatus,
          totalDone,
          totalFailed,
        );
      } catch (e) {
        this.logger.warn(
          `broadcastMigrationComplete failed for ${migrationId}: ${(e as Error).message}`,
        );
      }
    }
  }

  /**
   * Создаёт Site / Database / SslCertificate / CronJob записи в БД мастера
   * после успешной отработки агента. Все записи помечаются metadata.migrationId,
   * чтобы cleanup-контракт мог их различать.
   */
  private async persistMigratedSiteRecords(
    migrationId: string,
    itemId: string,
    plan: PlanItem,
    createdBy: string,
    extras: {
      sslNotBefore: string | null;
      sslNotAfter: string | null;
      verifyHttpCode: string | null;
      creds: {
        sshPassword: string | null;
        dbName: string | null;
        dbUser: string | null;
        dbPassword: string | null;
        cmsAdminUser: string | null;
        cmsAdminPassword: string | null;
      } | null;
    } = {
      sslNotBefore: null,
      sslNotAfter: null,
      verifyHttpCode: null,
      creds: null,
    },
  ): Promise<string> {
    const SITES_BASE_PATH =
      process.env.SITES_BASE_PATH || '/var/www';
    const rootPath = `${SITES_BASE_PATH}/${plan.newName}`;
    const nginxConfigPath = `/etc/nginx/sites-available/${plan.newName}.conf`;

    // 1) Site
    const siteType =
      plan.sourceCms === 'modx' ? 'MODX_REVO' : 'CUSTOM';
    // MODX-специфичные поля переносим только для MODX-сайтов: пути менеджера/
    // коннекторов из spec §7.2 (см. discover.ts → modxPaths) и версия CMS,
    // парсящаяся из hostpanel.version. Без них UI MODX-вкладка пустая, а
    // layered-template не знает кастомных директорий manager_xxx / connectors_yyy.
    const isModx = plan.sourceCms === 'modx';
    const modxManagerPath = isModx ? plan.modxPaths?.managerDir || null : null;
    const modxConnectorsPath = isModx ? plan.modxPaths?.connectorsDir || null : null;
    const modxVersion = isModx ? plan.sourceCmsVersion || null : null;
    // Aliases с redirect=true, если на источнике найдено
    // `if ($host != $main_host) return 301 ...` (см. spec §7.2).
    const redirectAliases = plan.aliasesRedirectToMain === true;
    const aliasObjs = plan.newAliases.map((d) => ({
      domain: d,
      redirect: redirectAliases,
    }));
    const site = await this.prisma.site.create({
      data: {
        name: plan.newName,
        displayName: null,
        domain: plan.newDomain,
        aliases: stringifySiteAliases(aliasObjs),
        type: siteType,
        status: 'RUNNING',
        phpVersion: plan.phpVersion || null,
        rootPath,
        nginxConfigPath,
        systemUser: plan.newName,
        managerPath: modxManagerPath,
        connectorsPath: modxConnectorsPath,
        modxVersion,
        // SSH-пароль = sftp_pass с источника (spec §6.2). Шифруем перед
        // записью в БД (master-key cipher, см. spec master-key-unification).
        sshPasswordEnc: extras.creds?.sshPassword
          ? encryptSshPassword(extras.creds.sshPassword)
          : null,
        // CMS admin login/password = manager_user/manager_pass с источника
        // (`modx_host_hostpanel_sites`). На hostpanel пароль в плейне → шифруем
        // в Site.cmsAdminPasswordEnc. Без этого блок CMS на странице сайта
        // показывал бы только «Версия» (условие `v-if=site.cmsAdminUser` в
        // [id].vue ложное), и оператор не мог бы залогиниться через панель.
        // Применяется только для MODX-сайтов.
        cmsAdminUser: isModx ? extras.creds?.cmsAdminUser || null : null,
        cmsAdminPasswordEnc:
          isModx && extras.creds?.cmsAdminPassword
            ? encryptCmsPassword(extras.creds.cmsAdminPassword)
            : null,
        dbEnabled: !!plan.dbExcludeDataTables?.length || plan.sourceCms === 'modx',
        httpsRedirect: !!plan.ssl?.transfer,
        // filesRelPath = webroot относительно rootPath. Парсится discover.ts из
        // nginx `root` директивы, fallback на 'www'. Spec §7.2.
        filesRelPath: plan.filesRelPath || 'www',
        nginxCustomConfig: plan.nginxCustomConfig || null,
        // HSTS — отдельный флаг (а не add_header в custom-блоке): иначе при
        // regen layered-конфигом через UI он бы пропадал. 50-security шаблон
        // сам вставит add_header Strict-Transport-Security при nginxHsts=true.
        nginxHsts: plan.nginxHsts === true,
        // Кастом php-fpm pool (php_admin_value-директивы из source pool.d, кроме
        // upload/post/memory которые мапятся в стандартные настройки сайта).
        // Без этого поля при смене PHP-версии в UI custom-блок пропадёт.
        phpPoolCustom: plan.phpFpm?.custom || null,
        userId: createdBy,
        metadata: JSON.stringify({
          migrationId,
          itemId,
          importedFrom: 'hostpanel',
          sourceUser: plan.sourceUser,
          sourceDomain: plan.sourceDomain,
          sourceHostpanelId: plan.sourceSiteId,
          requiresSslReissue: !!plan.ssl?.transfer,
          createdAt: new Date().toISOString(),
        }),
      },
    });

    // 1b) Основной домен (мульти-доменная модель). hostpanel-сайт переносится
    // как один основной домен (главный). Алиасы / HSTS / custom-nginx — на нём.
    const primaryDomain = await this.prisma.siteDomain.create({
      data: {
        siteId: site.id,
        domain: plan.newDomain,
        isPrimary: true,
        position: 0,
        aliases: stringifySiteAliases(aliasObjs),
        filesRelPath: null, // null → наследует Site.filesRelPath
        httpsRedirect: !!plan.ssl?.transfer,
        nginxHsts: plan.nginxHsts === true,
        nginxCustomConfig: plan.nginxCustomConfig || null,
      },
    });

    // 2) SslCertificate (всегда создаём — иначе UI ssl:* падает)
    const sslDomains = [plan.newDomain, ...plan.newAliases];
    const isLeTransfer = !!plan.ssl?.transfer;
    const issuedAt = extras.sslNotBefore ? new Date(extras.sslNotBefore) : null;
    const expiresAt = extras.sslNotAfter ? new Date(extras.sslNotAfter) : null;
    const daysRemaining =
      expiresAt
        ? Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 86_400_000))
        : null;
    await this.prisma.sslCertificate.create({
      data: {
        siteId: site.id,
        domainId: primaryDomain.id,
        domains: stringifyStringArray(sslDomains),
        status: isLeTransfer ? 'ACTIVE' : 'NONE',
        issuer: isLeTransfer ? "Let's Encrypt" : '',
        issuedAt: isLeTransfer ? issuedAt : null,
        expiresAt: isLeTransfer ? expiresAt : null,
        daysRemaining: isLeTransfer ? daysRemaining : null,
        certPath: isLeTransfer
          ? `/etc/letsencrypt/live/${plan.newDomain}/fullchain.pem`
          : null,
        keyPath: isLeTransfer
          ? `/etc/letsencrypt/live/${plan.newDomain}/privkey.pem`
          : null,
      },
    });

    // 3) Database (если на источнике была БД)
    if (plan.dbExcludeDataTables?.length || plan.sourceCms === 'modx') {
      // Spec §6.2: «В Database.dbPasswordEnc шифруем тот же пароль» (что
      // ушёл в источник — иначе MODX не подключится после patch-modx и
      // оператор не сможет авторизоваться в Adminer SSO). Агент вернул
      // реальный пароль в result.creds.dbPassword. Если по какой-то причине
      // его нет — fallback на random (UI хотя бы не упадёт), но логируем
      // warning, чтобы оператор разобрался.
      const dbPlain =
        extras.creds?.dbPassword ||
        (() => {
          this.logger.warn(
            `Database persist for ${plan.newName}: agent did not return creds.dbPassword — generating random (Adminer/SSO will not match real DB password)`,
          );
          return randomBytes(16).toString('base64url');
        })();
      const dbName = extras.creds?.dbName || plan.newName;
      const dbUser = extras.creds?.dbUser || plan.newName;
      const dbPasswordHash = await hashPassword(dbPlain);
      const dbPasswordEnc = encryptJson({ password: dbPlain });
      await this.prisma.database
        .create({
          data: {
            name: dbName,
            type: 'MARIADB',
            dbUser: dbUser,
            dbPasswordHash,
            dbPasswordEnc,
            siteId: site.id,
          },
        })
        .catch((e) => {
          this.logger.warn(
            `Database record create failed for ${plan.newName}: ${(e as Error).message}`,
          );
        });
    }

    // 4) Manticore enable (best-effort; падение не валит сайт)
    if (plan.manticore?.enable) {
      try {
        await this.servicesService.enableSiteService(site.id, 'manticore');
        await this.appendMigrationLog(
          migrationId,
          `🔍 manticore enabled for site=${plan.newName}`,
        );
      } catch (e) {
        await this.appendMigrationLog(
          migrationId,
          `WARN: manticore enable failed (${(e as Error).message}) — включи в /sites/${site.id} вручную`,
        );
      }
    }

    // 5) CronJob записи (per-site)
    const accepted = plan.cronJobs.filter((j) => j.target === 'this-site');
    for (const [idx, job] of accepted.entries()) {
      try {
        await this.prisma.cronJob.create({
          data: {
            siteId: site.id,
            name: `imported-${idx + 1}`,
            schedule: job.schedule,
            command: job.command,
            status: 'ACTIVE',
          },
        });
      } catch (e) {
        this.logger.warn(
          `CronJob persist failed: ${(e as Error).message}`,
        );
      }
    }

    // 6) Per-user CLI-шим PHP — чтобы команда `php` под юзером сайта
    // (`su - <user>`) указывала на ту же версию, что и FPM-пул. Без этого
    // оператор после миграции получает global PHP (обычно последний
    // установленный — 8.4), и крон-задачи / SSH-сессии работают на
    // несовместимой версии. Best-effort: если упало — миграция всё равно
    // считается успешной, оператор может позже дёрнуть
    // `make php-shim-resync` или `POST /api/sites/php-shim/resync`.
    if (plan.phpVersion && this.agentRelay.isAgentConnected()) {
      try {
        const shimRes = await this.agentRelay.emitToAgent<{ success: boolean; error?: string }>(
          'user:setup-php-shim',
          {
            username: plan.newName,
            homeDir: rootPath,
            phpVersion: plan.phpVersion,
          },
          20_000,
        );
        if (!shimRes?.success) {
          await this.appendMigrationLog(
            migrationId,
            `WARN: PHP CLI shim setup для site=${plan.newName} (php=${plan.phpVersion}) не прошёл: ${shimRes?.error || 'unknown'}. Запусти ручной resync: make php-shim-resync`,
          );
        }
      } catch (e) {
        await this.appendMigrationLog(
          migrationId,
          `WARN: PHP CLI shim emit упал для site=${plan.newName}: ${(e as Error).message}. Запусти ручной resync: make php-shim-resync`,
        );
      }
    }

    return site.id;
  }

  /**
   * Bulk-create SystemCronJob из discovery.systemCronJobs. Идемпотентно по
   * (schedule + command) — если уже есть, пропускаем. Дополнительно пушит
   * каждую новую запись в OS root crontab через агентский handler `cron:add`,
   * иначе строки только лежат в БД и не выполняются. На fail агентского
   * вызова — DB-запись остаётся (видна в /cron как DISABLED-ish), но логируем
   * warning, чтобы оператор пересинхронизировал руками.
   */
  private async bulkCreateSystemCron(
    migrationId: string,
    jobs: PlanItemCronJob[],
  ): Promise<void> {
    let imported = 0;
    let skipped = 0;
    let pushFailed = 0;
    const agentOnline = this.agentRelay.isAgentConnected();
    for (const job of jobs) {
      if (job.target === 'skip') {
        skipped += 1;
        continue;
      }
      const existing = await this.prisma.systemCronJob.findFirst({
        where: { schedule: job.schedule, command: job.command },
      });
      if (existing) {
        skipped += 1;
        continue;
      }
      const created = await this.prisma.systemCronJob.create({
        data: {
          name: `imported-${migrationId.slice(0, 8)}-${imported + 1}`,
          schedule: job.schedule,
          command: job.command,
          source: 'IMPORTED_HOSTPANEL',
          comment: job.noteStripped
            ? `from hostpanel (stripped: ${job.noteStripped})`
            : 'from hostpanel migration',
        },
      });
      imported += 1;

      if (!agentOnline) {
        pushFailed += 1;
        continue;
      }
      try {
        const r = await this.agentRelay.emitToAgent('cron:add', {
          id: created.id,
          schedule: created.schedule,
          command: created.command,
          enabled: true,
          user: 'root',
        });
        if (!r.success) pushFailed += 1;
      } catch {
        pushFailed += 1;
      }
    }
    await this.appendMigrationLog(
      migrationId,
      `📋 system-cron import: +${imported} новых, ${skipped} пропущено (дубликаты/skip)` +
        (pushFailed > 0
          ? `; ⚠ ${pushFailed} не записаны в root crontab (агент offline или ошибка) — пересинхронизируй вручную в /cron`
          : ''),
    );
  }

  // ─── Вызывается из gateway listener'ов ────────────────────────────────

  // appendItemLog — горячий путь из gateway listener'а (мб сотни вызовов/сек
  // во время db-dump-import). Не пишем в БД на каждой строке: буферизуем в
  // памяти, флашим раз в LOG_FLUSH_INTERVAL_MS одним findUnique+update на
  // item. Возвращаемся синхронно — listener не зависает от SQLite-локов.
  appendItemLog(itemId: string, line: string): void {
    const cur = this.itemLogBuffer.get(itemId) || '';
    let next = cur + line + '\n';
    // Если буфер раздулся (агент шлёт быстрее чем флашим) — режем хвост.
    if (next.length > LOG_BUFFER_MAX_PER_KEY) {
      next = next.slice(next.length - LOG_BUFFER_MAX_PER_KEY);
    }
    this.itemLogBuffer.set(itemId, next);
    this.scheduleLogFlush();
  }

  // appendMigrationLog — два режима: можно вызвать в режиме "потокового" лога
  // (быстрая буферизация, как у item) или await'ом из логики, где важно чтоб
  // запись в БД произошла до возврата (для пользовательских действий типа
  // pause/resume). Сейчас буферизуем — пишется в той же пачке, задержка <1с,
  // что для лога приемлемо. Все вызовы внутри сервиса обёрнуты в try, поэтому
  // даже если флаш упадёт — это не уронит миграционный pipeline.
  async appendMigrationLog(migrationId: string, line: string): Promise<void> {
    const cur = this.migrationLogBuffer.get(migrationId) || '';
    let next = cur + line + '\n';
    if (next.length > LOG_BUFFER_MAX_PER_KEY) {
      next = next.slice(next.length - LOG_BUFFER_MAX_PER_KEY);
    }
    this.migrationLogBuffer.set(migrationId, next);
    this.scheduleLogFlush();
  }

  private scheduleLogFlush(): void {
    if (this.logFlushTimer) return;
    this.logFlushTimer = setTimeout(() => {
      this.logFlushTimer = null;
      // Не наслаиваем флаши — если предыдущий ещё в полёте, дождёмся его.
      if (this.logFlushInFlight) {
        this.logFlushInFlight.finally(() => {
          if (this.itemLogBuffer.size || this.migrationLogBuffer.size) {
            this.scheduleLogFlush();
          }
        });
        return;
      }
      this.logFlushInFlight = this.flushLogBuffers().finally(() => {
        this.logFlushInFlight = null;
        // Появилось ещё что-то — снова запланируем.
        if (this.itemLogBuffer.size || this.migrationLogBuffer.size) {
          this.scheduleLogFlush();
        }
      });
    }, LOG_FLUSH_INTERVAL_MS);
  }

  private async flushLogBuffers(): Promise<void> {
    // Снимаем снапшот и сразу очищаем — новые строки уйдут в следующий флаш.
    const itemEntries = Array.from(this.itemLogBuffer.entries());
    this.itemLogBuffer.clear();
    const migrationEntries = Array.from(this.migrationLogBuffer.entries());
    this.migrationLogBuffer.clear();

    for (const [itemId, pending] of itemEntries) {
      if (!pending) continue;
      try {
        const item = await this.prisma.hostpanelMigrationItem.findUnique({
          where: { id: itemId },
          select: { log: true },
        });
        if (!item) continue;
        let next = (item.log || '') + pending;
        if (next.length > ITEM_LOG_TAIL_LIMIT) {
          next = next.slice(next.length - ITEM_LOG_TAIL_LIMIT);
        }
        await this.prisma.hostpanelMigrationItem.update({
          where: { id: itemId },
          data: { log: next },
        });
      } catch (e) {
        // Глотаем ошибку — лог не критичен, миграцию ронять нельзя.
        // Возвращать строки в буфер не будем: при таймауте SQLite оно
        // потенциально снова упадёт и буфер раздуется бесконечно.
        this.logger.warn(
          `flush itemLog ${itemId} failed: ${(e as Error).message}`,
        );
      }
    }

    for (const [migrationId, pending] of migrationEntries) {
      if (!pending) continue;
      try {
        const m = await this.prisma.hostpanelMigration.findUnique({
          where: { id: migrationId },
          select: { log: true },
        });
        if (!m) continue;
        let next = (m.log || '') + pending;
        if (next.length > LOG_TAIL_LIMIT) {
          next = next.slice(next.length - LOG_TAIL_LIMIT);
        }
        await this.prisma.hostpanelMigration.update({
          where: { id: migrationId },
          data: { log: next },
        });
      } catch (e) {
        this.logger.warn(
          `flush migrationLog ${migrationId} failed: ${(e as Error).message}`,
        );
      }
    }
  }

  async updateItemStatus(
    itemId: string,
    patch: {
      status?: string;
      currentStage?: string | null;
      progressPercent?: number;
      errorMsg?: string | null;
      newSiteId?: string | null;
      startedAt?: Date | null;
      finishedAt?: Date | null;
    },
  ): Promise<void> {
    await this.prisma.hostpanelMigrationItem
      .update({ where: { id: itemId }, data: patch })
      .catch(() => {});
  }

  // ─── Crypto helpers ───────────────────────────────────────────────────

  private encodeSource(s: MigrationSourceDto): SourceStored {
    return {
      host: s.host,
      port: s.port,
      sshUser: s.sshUser,
      sshPassEnc: encryptMigrationSecret({ pass: s.sshPassword }),
      mysqlHost: s.mysqlHost,
      mysqlPort: s.mysqlPort,
      mysqlUser: s.mysqlUser,
      mysqlPassEnc: encryptMigrationSecret({ pass: s.mysqlPassword }),
      hostpanelDb: s.hostpanelDb,
      hostpanelTablePrefix: s.hostpanelTablePrefix,
    };
  }

  private decodeSource(s: SourceStored): SourceDecrypted {
    const sshPass = decryptMigrationSecret<{ pass: string }>(s.sshPassEnc).pass;
    const mysqlPass = decryptMigrationSecret<{ pass: string }>(s.mysqlPassEnc).pass;
    return {
      host: s.host,
      port: s.port,
      sshUser: s.sshUser,
      sshPassword: sshPass,
      mysqlHost: s.mysqlHost,
      mysqlPort: s.mysqlPort,
      mysqlUser: s.mysqlUser,
      mysqlPassword: mysqlPass,
      hostpanelDb: s.hostpanelDb,
      hostpanelTablePrefix: s.hostpanelTablePrefix,
    };
  }

  private assertAdmin(role: string) {
    if (role !== 'ADMIN') {
      throw new ForbiddenException('Only admins can manage hostPanel migrations');
    }
  }
}
