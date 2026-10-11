import { BackupStatus } from '../common/enums';

interface BackupRunTable {
  updateMany(args: {
    where: {
      status: { in: BackupStatus[] };
      createdAt: { lt: Date };
      id?: { notIn: string[] };
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
  activeAgentIds: string[] = [],
): Promise<{ site: number; serverPath: number; panelData: number }> {
  const where = {
    status: { in: [BackupStatus.PENDING, BackupStatus.IN_PROGRESS] },
    createdAt: { lt: cutoff },
    ...(activeAgentIds.length ? { id: { notIn: activeAgentIds } } : {}),
  };
  const data = {
    status: BackupStatus.FAILED,
    errorMessage: 'Операция зависла: агент не подтвердил результат; требуется сверка с хранилищем',
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
