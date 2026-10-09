interface AcceptedBackupDeletion {
  operationId: string;
}

interface BackupDeletionRequestOptions {
  headers: Record<string, string>;
  signal?: AbortSignal;
}

interface BackupDeletionOperationOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

interface DeleteBackupAndWaitOptions {
  backupId: string;
  idempotencyKey: string;
  signal?: AbortSignal;
  requestDelete: (
    backupId: string,
    options: BackupDeletionRequestOptions,
  ) => Promise<AcceptedBackupDeletion>;
  waitForOperation: (
    operationId: string,
    options: BackupDeletionOperationOptions,
  ) => Promise<unknown>;
  assertContextCurrent: () => void;
  onDeleted: () => void;
}

const BACKUP_DELETION_TIMEOUT_MS = 2 * 60 * 60_000;

export async function deleteBackupAndWaitForSuccess({
  backupId,
  idempotencyKey,
  signal,
  requestDelete,
  waitForOperation,
  assertContextCurrent,
  onDeleted,
}: DeleteBackupAndWaitOptions): Promise<void> {
  const accepted = await requestDelete(backupId, {
    headers: { 'Idempotency-Key': idempotencyKey },
    signal,
  });
  assertContextCurrent();
  await waitForOperation(accepted.operationId, {
    timeoutMs: BACKUP_DELETION_TIMEOUT_MS,
    signal,
  });
  assertContextCurrent();
  onDeleted();
}
