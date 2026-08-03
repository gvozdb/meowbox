import { Injectable, Logger } from '@nestjs/common';
import { safeErrorMessage } from '@meowbox/shared';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { PrismaService } from '../common/prisma.service';
import { BackupStorageType } from '../common/enums';
import { parseJsonObject } from '../common/json-array';
import { StorageLocationsService } from '../storage-locations/storage-locations.service';
import { BackupExportsService } from './backup-exports.service';

export interface SiteBackupArtifactCleanupOptions {
  removeLocal: boolean;
  removeRestic: boolean;
  removeRemote: boolean;
  strict: boolean;
}

export interface BackupArtifactRow {
  id: string;
  engine: string;
  filePath: string;
  storageType: string | null;
  resticSnapshotId: string | null;
  storageLocationId: string | null;
  storageLocation: { id: string; type: string } | null;
  config: { storageType: string | null; storageConfig: string | null } | null;
}

type BackupAgentStorage = {
  type: string;
  config: Record<string, string>;
  resticPassword: string | null;
};

@Injectable()
export class BackupArtifactCleanupService {
  private readonly logger = new Logger(BackupArtifactCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
    private readonly storageLocations: StorageLocationsService,
    private readonly backupExports: BackupExportsService,
  ) {}

  private storageType(backup: BackupArtifactRow): string | null {
    return (
      backup.storageLocation?.type ||
      backup.storageType ||
      backup.config?.storageType ||
      null
    );
  }

  private async storageForAgent(
    backup: BackupArtifactRow,
    cache?: Map<string, BackupAgentStorage>,
  ): Promise<BackupAgentStorage | null> {
    const locationId = backup.storageLocationId || backup.storageLocation?.id;
    if (locationId) {
      const cached = cache?.get(locationId);
      if (cached) return cached;
      const storage = await this.storageLocations.getFullConfigForAgent(locationId);
      cache?.set(locationId, storage);
      return storage;
    }
    const type = this.storageType(backup);
    if (!type) return null;
    return {
      type,
      config: parseJsonObject<Record<string, string>>(
        backup.config?.storageConfig,
        {},
      ),
      resticPassword: null,
    };
  }

  private async step(
    subjectId: string,
    label: string,
    strict: boolean,
    action: () => Promise<void | { success: boolean; error?: string }>,
  ): Promise<boolean> {
    try {
      const result = await action();
      if (result && result.success === false) {
        throw new Error(result.error || `${label} cleanup failed`);
      }
      return true;
    } catch (error) {
      const message = safeErrorMessage(error, `${label} cleanup failed`);
      if (strict) throw new Error(`Backup ${subjectId}: ${message}`);
      this.logger.warn(`Backup ${subjectId} ${label} cleanup failed: ${message}`);
      return false;
    }
  }

  async cleanupBackupArtifacts(
    backup: BackupArtifactRow,
    siteName: string,
    options: SiteBackupArtifactCleanupOptions,
    storageCache?: Map<string, BackupAgentStorage>,
    cleanupExports = true,
  ): Promise<{ allArtifactsSelected: boolean }> {
    const storageType = this.storageType(backup);
    const hasFile = backup.filePath.trim().length > 0;
    const localFile =
      hasFile &&
      (storageType === BackupStorageType.LOCAL ||
        (!storageType && backup.filePath.startsWith('/')));
    const remoteFile = hasFile && !localFile;
    let allArtifactsSelected = options.removeRemote;

    if (backup.resticSnapshotId) {
      if (!options.removeRestic) {
        allArtifactsSelected = false;
      } else {
        await this.step(
          backup.id,
          'Restic snapshot',
          options.strict,
          async () => {
            if (!this.agentRelay.isAgentConnected()) {
              throw new Error('Agent is offline');
            }
            const storage = await this.storageForAgent(backup, storageCache);
            if (!storage?.resticPassword) {
              throw new Error('Restic storage credentials are unavailable');
            }
            return this.agentRelay.emitToAgent(
              'restic:delete-snapshot',
              {
                siteName,
                snapshotId: backup.resticSnapshotId,
                storage: {
                  type: storage.type,
                  config: storage.config,
                  password: storage.resticPassword,
                },
              },
              300_000,
            );
          },
        );
      }
    }

    if (localFile) {
      if (!options.removeLocal) {
        allArtifactsSelected = false;
      } else {
        await this.step(
          backup.id,
          'local file',
          options.strict,
          async () => {
            if (!this.agentRelay.isAgentConnected()) {
              throw new Error('Agent is offline');
            }
            return this.agentRelay.emitToAgent('backup:delete-file', {
              filePath: backup.filePath,
            });
          },
        );
      }
    }

    if (remoteFile) {
      if (!options.removeRemote) {
        allArtifactsSelected = false;
      } else {
        await this.step(
          backup.id,
          'remote file',
          options.strict,
          async () => {
            if (!this.agentRelay.isAgentConnected()) {
              throw new Error('Agent is offline');
            }
            const storage = await this.storageForAgent(backup, storageCache);
            if (!storage) {
              throw new Error('Remote storage configuration is unavailable');
            }
            return this.agentRelay.emitToAgent(
              'backup:delete-remote',
              {
                filePath: backup.filePath,
                storageConfig: storage.config,
              },
              60_000,
            );
          },
        );
      }
    }

    if (options.removeRemote && cleanupExports) {
      await this.step(backup.id, 'export', options.strict, () =>
        this.backupExports.cleanupArtifactsForBackup(backup.id),
      );
    }

    return { allArtifactsSelected };
  }

  async cleanupSiteBackupArtifacts(
    siteId: string,
    siteName: string,
    options: SiteBackupArtifactCleanupOptions,
  ): Promise<{ backups: number; removedRecords: number }> {
    const backups = await this.prisma.backup.findMany({
      where: { siteId },
      include: {
        storageLocation: true,
        config: {
          select: { storageType: true, storageConfig: true },
        },
      },
    });
    let removedRecords = 0;
    const storageCache = new Map<string, BackupAgentStorage>();

    if (options.removeRemote) {
      await this.step(siteId, 'exports', options.strict, () =>
        this.backupExports.cleanupArtifactsForBackups(
          backups.map((backup) => backup.id),
        ),
      );
    }

    for (const backup of backups) {
      const cleanup = await this.cleanupBackupArtifacts(
        backup,
        siteName,
        options,
        storageCache,
        false,
      );
      if (!cleanup.allArtifactsSelected) continue;
      await this.prisma.backup.delete({ where: { id: backup.id } });
      removedRecords += 1;
    }

    return { backups: backups.length, removedRecords };
  }
}
