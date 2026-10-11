import { BackupStatus } from '../common/enums';

/** A late authoritative receipt may repair a watchdog/dispatch error, never a completed artifact. */
export function backupCompletionWhere(id: string) {
  return { id, OR: [
    { status: { in: [BackupStatus.PENDING, BackupStatus.IN_PROGRESS] } },
    { status: BackupStatus.FAILED, errorMessage: { startsWith: 'Операция зависла' } },
    { status: BackupStatus.FAILED, errorMessage: { startsWith: 'Dispatch failed:' } },
  ] };
}

export function backupDispatchFailure(error: unknown) {
  const uncertain = (error as Error)?.name === 'AgentTimeoutError';
  return {
    status: uncertain ? BackupStatus.PENDING : BackupStatus.FAILED,
    errorMessage: `Dispatch failed: ${String((error as Error)?.message || 'Agent admission failed').slice(0, 1000)}`,
    completedAt: uncertain ? null : new Date(),
  };
}
