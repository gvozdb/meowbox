import {
  navigateDownloadDelivery,
  publicDeliveryIdempotencyKey,
  uploadTransferFile,
} from '~/utils/public-delivery';

const DATABASE_OPERATION_TIMEOUT_MS = 24 * 60 * 60_000;
const DATABASE_IMPORT_MAX_BYTES = 50 * 1024 ** 3;
const DATABASE_IMPORT_FILENAME = /^[A-Za-z0-9._-]{1,180}$/;

function validateDatabaseImportFile(file: File): void {
  const lower = file.name.toLowerCase();
  if (
    !DATABASE_IMPORT_FILENAME.test(file.name) ||
    (!lower.endsWith('.sql') && !lower.endsWith('.sql.gz'))
  ) throw new Error('Импорт поддерживает только .sql и .sql.gz');
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    throw new Error('Файл импорта пуст');
  }
  if (file.size > DATABASE_IMPORT_MAX_BYTES) {
    throw new Error('Файл импорта больше 50 ГиБ');
  }
}

export function useDatabaseTransfer() {
  const api = useRemoteApi();
  const { waitForOperation } = useOperation();
  const serverStore = useServerStore();

  async function exportDatabase(databaseEndpoint: string): Promise<void> {
    const popup = window.open('about:blank', '_blank');
    let navigated = false;
    try {
      const context = serverStore.captureSelectedTargetContext();
      const assertContextCurrent = () => serverStore.assertSelectedTargetContextCurrent(context);
      const accepted = await api.post<AcceptedOperation>(`${databaseEndpoint}/export`, {}, {
        headers: { 'Idempotency-Key': operationIdempotencyKey('database-export') },
      });
      assertContextCurrent();
      await waitForOperation(accepted.operationId, {
        timeoutMs: DATABASE_OPERATION_TIMEOUT_MS,
      });
      assertContextCurrent();
      const delivery = await api.post<unknown>(
        `${databaseEndpoint}/exports/${accepted.operationId}/delivery`,
        {},
        { headers: { 'Idempotency-Key': publicDeliveryIdempotencyKey('DOWNLOAD') } },
      );
      assertContextCurrent();
      await navigateDownloadDelivery(delivery, popup, 'DATABASE_EXPORT');
      navigated = true;
    } finally {
      if (!navigated && popup && !popup.closed) popup.close();
    }
  }

  async function importDatabase(
    databaseEndpoint: string,
    databaseId: string,
    file: File,
  ): Promise<void> {
    validateDatabaseImportFile(file);
    const context = serverStore.captureSelectedTargetContext();
    const assertContextCurrent = () => serverStore.assertSelectedTargetContextCurrent(context);
    const rawDelivery = await api.post<unknown>(
      `${databaseEndpoint}/import-session`,
      { filename: file.name, contentLength: file.size },
      { headers: { 'Idempotency-Key': operationIdempotencyKey('database-import-upload') } },
    );
    assertContextCurrent();
    const delivery = await uploadTransferFile(
      rawDelivery,
      file,
      'DATABASE_IMPORT',
      databaseId,
      { assertContextCurrent },
    );
    assertContextCurrent();
    const accepted = await api.post<AcceptedOperation>(
      `${databaseEndpoint}/import`,
      { uploadSessionId: delivery.leaseId },
      { headers: { 'Idempotency-Key': operationIdempotencyKey('database-import') } },
    );
    assertContextCurrent();
    await waitForOperation(accepted.operationId, {
      timeoutMs: DATABASE_OPERATION_TIMEOUT_MS,
    });
    assertContextCurrent();
  }

  return { exportDatabase, importDatabase };
}
