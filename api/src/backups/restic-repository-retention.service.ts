import { Injectable, Logger } from '@nestjs/common';
import { BackupEngine, BackupStatus } from '../common/enums';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { StorageLocationsService } from '../storage-locations/storage-locations.service';
import { resticRepositoryName } from './restic-repository-name';
import { RESTIC_RETENTION_TIMEOUT_MS } from './restic-retention.constants';
import { RetentionSweepState } from './retention-sweep-state';

const RESTIC_COMPATIBLE = new Set(['LOCAL', 'S3']);
const PRUNED_MESSAGE = 'Snapshot удалён из репозитория (retention)';

interface RetentionPolicy {
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
  keepYearly: number;
}

interface RepositorySnapshot {
  id: string;
}

@Injectable()
export class ResticRepositoryRetentionService {
  private readonly logger = new Logger('ResticRepositoryRetentionService');
  private readonly inFlight = new Map<string, {
    policy: string;
    task: Promise<Set<string> | null>;
  }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
    private readonly storageLocations: StorageLocationsService,
  ) {}

  // Called independently of backup completion. A durable per-repository lease
  // makes missed completions and API restarts recoverable without a migration.
  async sweepDueRepositories(now = new Date(), limit = 2): Promise<{ attempted: number; failed: number }> {
    const state = new RetentionSweepState(this.prisma);
    const [panelRows, pathRows] = await Promise.all([
      this.prisma.panelDataBackup.groupBy({
        where: { engine: BackupEngine.RESTIC, storageLocationId: { not: null } },
        by: ['configId', 'storageLocationId'],
      }),
      this.prisma.serverPathBackup.groupBy({
        where: { engine: BackupEngine.RESTIC, storageLocationId: { not: null } },
        by: ['configId', 'storageLocationId'],
      }),
    ]);
    const candidates = [
      ...panelRows.filter((r) => r.storageLocationId).map((r) => ({
        scope: 'panel' as const, configId: r.configId, locationId: r.storageLocationId!,
      })),
      ...pathRows.filter((r) => r.storageLocationId).map((r) => ({
        scope: 'path' as const, configId: r.configId, locationId: r.storageLocationId!,
      })),
    ];
    const configured = [] as Array<(typeof candidates)[number] & {
      config: RetentionPolicy & { name: string; engine: string };
      repoName: string;
    }>;
    const repositoryCounts = new Map<string, number>();
    for (const candidate of candidates) {
      const config = candidate.scope === 'panel'
        ? await this.prisma.panelDataBackupConfig.findUnique({ where: { id: candidate.configId } })
        : await this.prisma.serverPathBackupConfig.findUnique({ where: { id: candidate.configId } });
      if (!config || config.engine !== BackupEngine.RESTIC) continue;
      const repoName = resticRepositoryName(config.name, candidate.scope === 'panel' ? 'panel-data' : 'server-path');
      const repositoryKey = `${candidate.locationId}:${repoName}`;
      repositoryCounts.set(repositoryKey, (repositoryCounts.get(repositoryKey) || 0) + 1);
      configured.push({ ...candidate, config, repoName });
    }
    let attempted = 0;
    let failed = 0;
    for (const candidate of configured) {
      if (attempted >= limit) break;
      const { config, repoName } = candidate;
      if (repositoryCounts.get(`${candidate.locationId}:${repoName}`)! > 1) {
        this.logger.warn(`Retention skipped: ambiguous repository ${candidate.locationId}/${repoName}`);
        continue;
      }
      let active;
      try {
        active = candidate.scope === 'panel'
          ? await this.prisma.panelDataBackup.findFirst({ where: {
            configId: candidate.configId, storageLocationId: candidate.locationId,
            status: { in: [BackupStatus.PENDING, BackupStatus.IN_PROGRESS] },
          } })
          : await this.prisma.serverPathBackup.findFirst({ where: {
            configId: candidate.configId, storageLocationId: candidate.locationId,
            status: { in: [BackupStatus.PENDING, BackupStatus.IN_PROGRESS] },
          } });
      } catch (err) {
        failed++;
        this.logger.warn(`Retention activity lookup failed for ${candidate.scope}/${candidate.configId}/${candidate.locationId}: ${(err as Error).message}`);
        continue;
      }
      if (active) continue;
      let lease;
      try {
        lease = await state.claim(candidate.locationId, repoName, now);
      } catch (err) {
        failed++;
        this.logger.warn(`Retention state unavailable for ${candidate.scope}/${candidate.configId}/${candidate.locationId}: ${(err as Error).message}`);
        continue;
      }
      if (!lease) continue;
      attempted++;
      let succeeded = false;
      try {
        if (candidate.scope === 'panel') {
          await this.applyPanelRepository(candidate.configId, candidate.locationId, config);
        } else {
          await this.applyPathRepository(candidate.configId, candidate.locationId, config);
        }
        succeeded = true;
      } catch (err) {
        failed++;
        this.logger.warn(`Retention sweep failed for ${candidate.scope}/${candidate.configId}/${candidate.locationId}: ${(err as Error).message}`);
      }
      try {
        if (!await state.finish(lease, succeeded, now)) {
          failed++;
          this.logger.warn(`Retention lease changed before finalization for ${candidate.scope}/${candidate.configId}/${candidate.locationId}`);
        }
      } catch (err) {
        failed++;
        this.logger.warn(`Retention state update failed for ${candidate.scope}/${candidate.configId}/${candidate.locationId}: ${(err as Error).message}`);
      }
    }
    return { attempted, failed };
  }

  async applyForPanelBackup(backupId: string): Promise<void> {
    const backup = await this.prisma.panelDataBackup.findUnique({
      where: { id: backupId },
      include: {
        config: {
          select: {
            id: true,
            name: true,
            keepDaily: true,
            keepWeekly: true,
            keepMonthly: true,
            keepYearly: true,
          },
        },
      },
    });
    if (
      !backup ||
      backup.engine !== BackupEngine.RESTIC ||
      !backup.storageLocationId
    ) {
      return;
    }

    await this.applyPanelRepository(backup.config.id, backup.storageLocationId, backup.config);
  }

  private async applyPanelRepository(configId: string, storageLocationId: string, config: RetentionPolicy & { name: string }): Promise<void> {
    const removedIds = await this.applyRepositoryRetention({
      repoName: resticRepositoryName(config.name, 'panel-data'),
      storageLocationId,
      policy: this.policyFromConfig(config),
    });
    if (!removedIds?.size) return;

    await this.prisma.panelDataBackup.updateMany({
      where: {
        configId,
        storageLocationId,
        engine: BackupEngine.RESTIC,
        status: BackupStatus.COMPLETED,
        resticSnapshotId: { in: Array.from(removedIds) },
      },
      data: { filePath: '', errorMessage: PRUNED_MESSAGE },
    });
  }

  async applyForServerPathBackup(backupId: string): Promise<void> {
    const backup = await this.prisma.serverPathBackup.findUnique({
      where: { id: backupId },
      include: {
        config: {
          select: {
            id: true,
            name: true,
            keepDaily: true,
            keepWeekly: true,
            keepMonthly: true,
            keepYearly: true,
          },
        },
      },
    });
    if (
      !backup ||
      backup.engine !== BackupEngine.RESTIC ||
      !backup.storageLocationId
    ) {
      return;
    }

    await this.applyPathRepository(backup.config.id, backup.storageLocationId, backup.config);
  }

  private async applyPathRepository(configId: string, storageLocationId: string, config: RetentionPolicy & { name: string }): Promise<void> {
    const removedIds = await this.applyRepositoryRetention({
      repoName: resticRepositoryName(config.name, 'server-path'),
      storageLocationId,
      policy: this.policyFromConfig(config),
    });
    if (!removedIds?.size) return;

    await this.prisma.serverPathBackup.updateMany({
      where: {
        configId,
        storageLocationId,
        engine: BackupEngine.RESTIC,
        status: BackupStatus.COMPLETED,
        resticSnapshotId: { in: Array.from(removedIds) },
      },
      data: { filePath: '', errorMessage: PRUNED_MESSAGE },
    });
  }

  private policyFromConfig(config: RetentionPolicy): RetentionPolicy {
    return {
      keepDaily: config.keepDaily,
      keepWeekly: config.keepWeekly,
      keepMonthly: config.keepMonthly,
      keepYearly: config.keepYearly,
    };
  }

  private applyRepositoryRetention(params: {
    repoName: string;
    storageLocationId: string;
    policy: RetentionPolicy;
  }): Promise<Set<string> | null> {
    const key = `${params.storageLocationId}:${params.repoName}`;
    const policy = JSON.stringify(params.policy);
    const running = this.inFlight.get(key);
    if (running) {
      if (running.policy !== policy) {
        return Promise.reject(new Error(`Conflicting retention policy for ${params.repoName}`));
      }
      return running.task;
    }

    const task = this.runRepositoryRetention(params).finally(() => {
      if (this.inFlight.get(key)?.task === task) this.inFlight.delete(key);
    });
    this.inFlight.set(key, { policy, task });
    return task;
  }

  private async runRepositoryRetention(params: {
    repoName: string;
    storageLocationId: string;
    policy: RetentionPolicy;
  }): Promise<Set<string> | null> {
    const counts = Object.values(params.policy);
    if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
      throw new Error(`Invalid retention policy for ${params.repoName}`);
    }
    if (counts.every((count) => count === 0)) return null;
    const location = await this.storageLocations.getFullConfigForAgent(
      params.storageLocationId,
    );
    if (!location.resticPassword || !RESTIC_COMPATIBLE.has(location.type)) {
      throw new Error(`Unsupported retention location ${params.storageLocationId}`);
    }

    const storage = {
      type: location.type,
      config: location.config,
      password: location.resticPassword,
    };
    const before = await this.readRepositorySnapshotIds(params.repoName, storage);
    const retention = await this.agentRelay.emitToAgent<{
      success: boolean;
      error?: string;
    }>(
      'restic:forget-repository',
      { repoName: params.repoName, storage, policy: params.policy },
      RESTIC_RETENTION_TIMEOUT_MS,
    );
    if (retention?.success !== true || retention.data?.success === false) {
      throw new Error(retention?.data?.error || retention?.error || `Retention failed for ${params.repoName}`);
    }

    const after = await this.readRepositorySnapshotIds(params.repoName, storage);
    return new Set(Array.from(before).filter((id) => !after.has(id)));
  }

  private async readRepositorySnapshotIds(repoName: string, storage: {
    type: string; config: Record<string, string>; password: string;
  }): Promise<Set<string>> {
    const snapshots = await this.agentRelay.emitToAgent<{
      success?: boolean;
      error?: string;
      snapshots: RepositorySnapshot[];
    }>(
      'restic:repository-snapshots',
      { repoName: repoName, storage },
      60_000,
    );
    if (snapshots?.success !== true ||
      (snapshots.data?.success !== undefined && snapshots.data.success !== true) ||
      !Array.isArray(snapshots.data?.snapshots) ||
      snapshots.data.snapshots.length === 0 ||
      !snapshots.data.snapshots.every((snapshot) => typeof snapshot?.id === 'string' && snapshot.id.length > 0)) {
      throw new Error(snapshots?.data?.error || snapshots?.error || `Snapshot listing failed for ${repoName}`);
    }

    return new Set(snapshots.data.snapshots.map((snapshot) => snapshot.id));
  }
}
