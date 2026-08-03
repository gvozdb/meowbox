import { BackupStatus } from '../common/enums';

interface BackupRunTable {
  updateMany(args: {
    where: {
      status: { in: BackupStatus[] };
      createdAt: { lt: Date };
    };
    data: {
      status: BackupStatus;
      errorMessage: string;
      completedAt: Date;
      progress: number;
    };
  }): Promise<{ count: number }>;
}

export interface BackupRunRecoveryPrisma {
  backup: BackupRunTable;
  serverPathBackup: BackupRunTable;
  panelDataBackup: BackupRunTable;
}

export async function failStaleBackupRuns(
  prisma: BackupRunRecoveryPrisma,
  cutoff: Date,
  completedAt = new Date(),
): Promise<{ site: number; serverPath: number; panelData: number }> {
  const where = {
    status: { in: [BackupStatus.PENDING, BackupStatus.IN_PROGRESS] },
    createdAt: { lt: cutoff },
  };
  const data = {
    status: BackupStatus.FAILED,
    errorMessage: 'Операция зависла (превышен допустимый срок)',
    completedAt,
    progress: 0,
  };

  const [site, serverPath, panelData] = await Promise.all([
    prisma.backup.updateMany({ where, data }),
    prisma.serverPathBackup.updateMany({ where, data }),
    prisma.panelDataBackup.updateMany({ where, data }),
  ]);
  return {
    site: site.count,
    serverPath: serverPath.count,
    panelData: panelData.count,
  };
}
