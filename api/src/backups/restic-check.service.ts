import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { StorageLocationsService } from '../storage-locations/storage-locations.service';
import { NotificationDispatcherService } from '../notifications/notification-dispatcher.service';
import { BackupEngine, BackupStatus } from '../common/enums';

// Тип хранилищ, совместимых с Restic (LOCAL/S3). Тут решаем на стороне API, чтобы
// не бегать на агент за очевидным "no".
const RESTIC_COMPATIBLE = new Set(['LOCAL', 'S3']);

// Таймаут check'а на стороне API: агент сам даёт 1 час, но тут нужно чуть больше
// (сеть + overhead). +30s для `--read-data` — всё равно есть резерв.
const CHECK_TIMEOUT_MS = 3600_000 + 30_000;

export interface ResticCheckOptions {
  readData?: boolean;
  readDataSubset?: string; // "10%" или "50%" — передаётся в restic как --read-data-subset=...
  source?: 'manual' | 'scheduled';
}

@Injectable()
export class ResticCheckService {
  private readonly logger = new Logger('ResticCheck');

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
    private readonly storageLocations: StorageLocationsService,
    private readonly notifier: NotificationDispatcherService,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Запуск проверки репы (siteName × storageLocation). */
  async runCheck(params: {
    siteId: string;
    locationId: string;
    userId: string;
    role: string;
    options?: ResticCheckOptions;
  }) {
    const { siteId, locationId, userId, role, options } = params;
    await this.assertSiteAccess(siteId, userId, role);

    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { id: true, name: true },
    });
    if (!site) throw new NotFoundException('Site not found');

    const loc = await this.storageLocations.getFullConfigForAgent(locationId);
    if (!RESTIC_COMPATIBLE.has(loc.type)) {
      throw new BadRequestException(
        `Хранилище ${loc.name} (${loc.type}) не поддерживает Restic — проверка невозможна`,
      );
    }
    if (!loc.resticPassword) {
      throw new BadRequestException('У хранилища нет Restic-пароля');
    }

    // Для плановых запусков вернём throttled-ошибку, если проверка уже шла
    // в последние 30 минут (иначе плановый scheduler + кнопка могут начать
    // две одновременно).
    const recent = await this.prisma.resticCheck.findFirst({
      where: {
        storageLocationId: locationId,
        siteName: site.name,
        completedAt: null,
      },
    });
    if (recent) {
      throw new BadRequestException('Проверка этой репы уже идёт — дождись завершения');
    }

    const row = await this.prisma.resticCheck.create({
      data: {
        storageLocationId: locationId,
        siteId: site.id,
        siteName: site.name,
        source: options?.source || 'manual',
        readData: !!options?.readData,
        readDataSubset: options?.readDataSubset || null,
      },
    });

    // Запускаем проверку асинхронно — не держим HTTP-запрос больше часа.
    this.dispatch(row.id, site.name, loc, options).catch((err) =>
      this.logger.error(`restic:check dispatch failed for ${row.id}: ${(err as Error).message}`),
    );

    return { id: row.id, startedAt: row.startedAt };
  }

  /** История проверок конкретной репы (siteId × locationId). */
  async listChecks(params: {
    siteId: string;
    locationId?: string;
    userId: string;
    role: string;
    limit?: number;
  }) {
    const { siteId, locationId, userId, role } = params;
    const limit = Math.min(params.limit || 50, 200);
    await this.assertSiteAccess(siteId, userId, role);

    const where: Record<string, unknown> = { siteId };
    if (locationId) where.storageLocationId = locationId;

    return this.prisma.resticCheck.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        storageLocationId: true,
        siteName: true,
        success: true,
        errorMessage: true,
        output: true,
        readData: true,
        readDataSubset: true,
        durationMs: true,
        source: true,
        startedAt: true,
        completedAt: true,
        storageLocation: { select: { id: true, name: true, type: true } },
      },
    });
  }

  /** Последние проверки по каждой (siteId × locationId) — для дашборда. */
  async latestPerSite() {
    // Берём самые свежие completedAt/startedAt для каждой пары.
    // SQLite без distinct — делаем group-select в памяти.
    const all = await this.prisma.resticCheck.findMany({
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        storageLocationId: true,
        siteId: true,
        siteName: true,
        success: true,
        errorMessage: true,
        durationMs: true,
        source: true,
        startedAt: true,
        completedAt: true,
        storageLocation: { select: { name: true, type: true } },
      },
    });
    const seen = new Set<string>();
    const latest: typeof all = [];
    for (const c of all) {
      const key = `${c.siteId || ''}|${c.storageLocationId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      latest.push(c);
    }
    return latest;
  }

  // ---------------------------------------------------------------------------
  // Scheduler-level enumerator: какие репы есть (по которым делали бэкапы)
  // ---------------------------------------------------------------------------

  /**
   * Список всех пар (siteId, siteName, locationId), у которых есть хотя бы
   * один успешный Restic-бэкап. Используется планировщиком для перебора
   * реп, которые надо проверять.
   */
  async listAllResticRepos(): Promise<Array<{
    siteId: string;
    siteName: string;
    locationId: string;
  }>> {
    const backups = await this.prisma.backup.findMany({
      where: {
        engine: BackupEngine.RESTIC,
        status: BackupStatus.COMPLETED,
        storageLocationId: { not: null },
      },
      select: {
        siteId: true,
        storageLocationId: true,
        site: { select: { name: true } },
      },
      distinct: ['siteId', 'storageLocationId'],
    });

    return backups
      .filter((b) => b.storageLocationId && b.site?.name)
      .map((b) => ({
        siteId: b.siteId,
        siteName: b.site!.name,
        locationId: b.storageLocationId!,
      }));
  }

  /** Последняя проверка по паре (siteId, locationId) — для throttle в scheduler. */
  async getLastCheck(siteId: string, locationId: string) {
    return this.prisma.resticCheck.findFirst({
      where: { siteId, storageLocationId: locationId },
      orderBy: { startedAt: 'desc' },
      select: { id: true, success: true, startedAt: true, completedAt: true },
    });
  }

  /** Вспомогательный метод для scheduler — запустить проверку без RBAC-проверки. */
  async runCheckInternal(params: {
    siteId: string;
    siteName: string;
    locationId: string;
    options?: ResticCheckOptions;
  }) {
    const { siteId, siteName, locationId, options } = params;

    // Не стартуем, если предыдущий запуск ещё не завершён (completedAt=null).
    const recent = await this.prisma.resticCheck.findFirst({
      where: { storageLocationId: locationId, siteName, completedAt: null },
    });
    if (recent) {
      return { skipped: true, reason: 'in_progress' };
    }

    const loc = await this.storageLocations.getFullConfigForAgent(locationId);
    if (!RESTIC_COMPATIBLE.has(loc.type) || !loc.resticPassword) {
      return { skipped: true, reason: 'not_restic_compatible' };
    }

    const row = await this.prisma.resticCheck.create({
      data: {
        storageLocationId: locationId,
        siteId,
        siteName,
        source: options?.source || 'scheduled',
        readData: !!options?.readData,
        readDataSubset: options?.readDataSubset || null,
      },
    });
    this.dispatch(row.id, siteName, loc, options).catch((err) =>
      this.logger.error(`scheduled check failed for ${row.id}: ${(err as Error).message}`),
    );
    return { id: row.id };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async dispatch(
    checkId: string,
    siteName: string,
    loc: { type: string; config: Record<string, string>; resticPassword: string | null },
    options?: ResticCheckOptions,
  ) {
    const startedAt = Date.now();
    try {
      if (!this.agentRelay.isAgentConnected()) {
        await this.finalize(checkId, {
          success: false,
          errorMessage: 'Agent offline',
          durationMs: 0,
          output: null,
        });
        return;
      }

      const res = await this.agentRelay.emitToAgent<{ output?: string; durationMs?: number }>(
        'restic:check',
        {
          siteName,
          storage: {
            type: loc.type,
            config: loc.config,
            password: loc.resticPassword,
          },
          readData: !!options?.readData,
          readDataSubset: options?.readDataSubset || null,
        },
        CHECK_TIMEOUT_MS,
      );

      await this.finalize(checkId, {
        success: !!res.success,
        errorMessage: res.success ? null : (res.error || 'check failed').substring(0, 2000),
        durationMs: res.data?.durationMs ?? (Date.now() - startedAt),
        output: res.data?.output ?? null,
      });

      if (!res.success) {
        const row = await this.prisma.resticCheck.findUnique({
          where: { id: checkId },
          include: { storageLocation: { select: { name: true } } },
        });
        this.notifier
          .dispatch({
            event: 'BACKUP_FAILED',
            title: 'Restic check failed',
            message: `Проверка репы ${row?.storageLocation?.name || ''} для сайта ${siteName}: ${(res.error || '').slice(0, 200)}`,
            siteName,
            timestamp: new Date(),
          })
          .catch((err) => this.logger.error(`Notify failed: ${(err as Error).message}`));
      }
    } catch (err) {
      await this.finalize(checkId, {
        success: false,
        errorMessage: (err as Error).message.substring(0, 2000),
        durationMs: Date.now() - startedAt,
        output: null,
      });
    }
  }

  private async finalize(
    checkId: string,
    result: { success: boolean; errorMessage: string | null; durationMs: number; output: string | null },
  ) {
    await this.prisma.resticCheck.update({
      where: { id: checkId },
      data: {
        success: result.success,
        errorMessage: result.errorMessage,
        output: result.output,
        durationMs: result.durationMs,
        completedAt: new Date(),
      },
    });
    if (result.success) {
      this.logger.log(`restic check ${checkId} OK (${result.durationMs}ms)`);
    } else {
      this.logger.warn(`restic check ${checkId} FAILED: ${result.errorMessage}`);
    }
  }

  // ---------------------------------------------------------------------------
  // RBAC
  // ---------------------------------------------------------------------------

  private async assertSiteAccess(siteId: string, userId: string, role: string) {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { userId: true },
    });
    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
  }
}
