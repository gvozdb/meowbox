import {
  navigateDownloadDelivery,
  publicDeliveryIdempotencyKey,
  uploadTransferFile,
} from '~/utils/public-delivery';

const FILE_TRANSFER_MAX_BYTES = 50 * 1024 ** 3;
const FILE_OPERATION_TIMEOUT_MS = 24 * 60 * 60_000;

export function useFileTransfer() {
  const api = useRemoteApi();
  const { waitForOperation } = useOperation();
  const serverStore = useServerStore();

  async function downloadSiteFile(domainEndpoint: string, relativePath: string): Promise<void> {
    const popup = window.open('about:blank', '_blank');
    let navigated = false;
    try {
      const context = serverStore.captureSelectedTargetContext();
      const delivery = await api.post<unknown>(
        `${domainEndpoint}/files/download-session`,
        { path: relativePath },
        { headers: { 'Idempotency-Key': publicDeliveryIdempotencyKey('DOWNLOAD') } },
      );
      serverStore.assertSelectedTargetContextCurrent(context);
      await navigateDownloadDelivery(delivery, popup, 'SITE_FILE');
      navigated = true;
    } finally {
      if (!navigated && popup && !popup.closed) popup.close();
    }
  }

  async function uploadSiteFile(
    domainEndpoint: string,
    domainId: string,
    targetDir: string,
    file: File,
  ): Promise<void> {
    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
      throw new Error('Нельзя загрузить пустой файл');
    }
    if (file.size > FILE_TRANSFER_MAX_BYTES) {
      throw new Error('Файл больше 50 ГиБ');
    }
    const context = serverStore.captureSelectedTargetContext();
    const assertContextCurrent = () => serverStore.assertSelectedTargetContextCurrent(context);
    const rawDelivery = await api.post<unknown>(
      `${domainEndpoint}/files/upload-session`,
      { targetDir, filename: file.name, contentLength: file.size },
      { headers: { 'Idempotency-Key': operationIdempotencyKey('file-upload-session') } },
    );
    assertContextCurrent();
    const delivery = await uploadTransferFile(
      rawDelivery,
      file,
      'SITE_FILE_UPLOAD',
      domainId,
      { assertContextCurrent },
    );
    assertContextCurrent();
    const accepted = await api.post<AcceptedOperation>(
      `${domainEndpoint}/files/upload-commit`,
      { uploadSessionId: delivery.leaseId, targetDir },
      { headers: { 'Idempotency-Key': operationIdempotencyKey('file-upload-commit') } },
    );
    assertContextCurrent();
    await waitForOperation(accepted.operationId, { timeoutMs: FILE_OPERATION_TIMEOUT_MS });
    assertContextCurrent();
  }

  async function downloadBackupFile(backupId: string, popup: Window | null): Promise<void> {
    const context = serverStore.captureSelectedTargetContext();
    const delivery = await api.post<unknown>(
      `/backups/${backupId}/download-session`,
      {},
      { headers: { 'Idempotency-Key': publicDeliveryIdempotencyKey('DOWNLOAD') } },
    );
    serverStore.assertSelectedTargetContextCurrent(context);
    await navigateDownloadDelivery(delivery, popup, 'BACKUP_FILE');
  }

  return { downloadSiteFile, uploadSiteFile, downloadBackupFile };
}
