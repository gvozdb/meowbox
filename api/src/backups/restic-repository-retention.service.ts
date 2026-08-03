import { Injectable, Logger } from '@nestjs/common';
import { BackupEngine, BackupStatus } from '../common/enums';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { StorageLocationsService } from '../storage-locations/storage-locations.service';
import { resticRepositoryName } from './restic-repository-name';
import { RESTIC_RETENTION_TIMEOUT_MS } from './restic-retention.constants';

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
  private readonly inFlight = new Map<string, Promise<Set<string> | null>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
    private readonly storageLocations: StorageLocationsService,
  ) {}

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

    const aliveIds = await this.applyRepositoryRetention({
      repoName: resticRepositoryName(backup.config.name, 'panel-data'),
      storageLocationId: backup.storageLocationId,
      policy: this.policyFromConfig(backup.config),
    });
    if (!aliveIds) return;

    await this.prisma.panelDataBackup.updateMany({
      where: {
        configId: backup.config.id,
        storageLocationId: backup.storageLocationId,
        engine: BackupEngine.RESTIC,
        status: BackupStatus.COMPLETED,
        resticSnapshotId: { not: null },
        ...(aliveIds.size > 0
          ? { NOT: { resticSnapshotId: { in: Array.from(aliveIds) } } }
          : {}),
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

    const aliveIds = await this.applyRepositoryRetention({
      repoName: resticRepositoryName(backup.config.name, 'server-path'),
      storageLocationId: backup.storageLocationId,
      policy: this.policyFromConfig(backup.config),
    });
    if (!aliveIds) return;

    await this.prisma.serverPathBackup.updateMany({
      where: {
        configId: backup.config.id,
        storageLocationId: backup.storageLocationId,
        engine: BackupEngine.RESTIC,
        status: BackupStatus.COMPLETED,
        resticSnapshotId: { not: null },
        ...(aliveIds.size > 0
          ? { NOT: { resticSnapshotId: { in: Array.from(aliveIds) } } }
          : {}),
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
    const running = this.inFlight.get(key);
    if (running) return running;

    const task = this.runRepositoryRetention(params).finally(() => {
      if (this.inFlight.get(key) === task) this.inFlight.delete(key);
    });
    this.inFlight.set(key, task);
    return task;
  }

  private async runRepositoryRetention(params: {
    repoName: string;
    storageLocationId: string;
    policy: RetentionPolicy;
  }): Promise<Set<string> | null> {
    const location = await this.storageLocations.getFullConfigForAgent(
      params.storageLocationId,
    );
    if (!location.resticPassword || !RESTIC_COMPATIBLE.has(location.type)) {
      this.logger.warn(`Skip retention for unsupported location ${location.name}`);
      return null;
    }

    const storage = {
      type: location.type,
      config: location.config,
      password: location.resticPassword,
    };
    const retention = await this.agentRelay.emitToAgent<{
      success: boolean;
      error?: string;
    }>(
      'restic:forget-repository',
      { repoName: params.repoName, storage, policy: params.policy },
      RESTIC_RETENTION_TIMEOUT_MS,
    );
    if (!retention.success) {
      throw new Error(retention.error || `Retention failed for ${params.repoName}`);
    }

    const snapshots = await this.agentRelay.emitToAgent<{
      snapshots: RepositorySnapshot[];
    }>(
      'restic:repository-snapshots',
      { repoName: params.repoName, storage },
      60_000,
    );
    if (!snapshots.success || !snapshots.data?.snapshots) {
      throw new Error(snapshots.error || `Snapshot listing failed for ${params.repoName}`);
    }

    return new Set(snapshots.data.snapshots.map((snapshot) => snapshot.id));
  }
}
