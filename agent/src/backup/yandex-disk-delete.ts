import { setTimeout as sleep } from 'node:timers/promises';
import { BACKUP_HOSTS } from '../config';

// Leave time for the result to reach the panel before its 60-second relay timeout.
const DELETE_TIMEOUT_MS = 50_000;
const OPERATION_POLL_MS = 1_000;

export async function deleteYandexDiskBackup(
  remotePath: string,
  token: string | undefined,
): Promise<{ success: boolean; error?: string }> {
  if (!token) return { success: false, error: 'Yandex Disk OAuth token missing' };
  const origin = `https://${BACKUP_HOSTS.YANDEX_DISK_API}`;
  const signal = AbortSignal.timeout(DELETE_TIMEOUT_MS);
  const options = {
    headers: { Authorization: `OAuth ${token}` },
    redirect: 'error' as const,
    signal,
  };
  try {
    const response = await fetch(
      `${origin}/v1/disk/resources?path=${encodeURIComponent(remotePath)}&permanently=true`,
      { ...options, method: 'DELETE' },
    );
    if (response.status === 204 || response.status === 404) {
      await response.body?.cancel();
      return { success: true };
    }
    if (response.status !== 202) {
      await response.body?.cancel();
      throw new Error(`Yandex Disk DELETE failed (HTTP ${response.status})`);
    }

    const link = await response.json() as { href?: unknown; method?: unknown };
    if (typeof link?.href !== 'string' || link.method !== 'GET') {
      throw new Error('Yandex Disk returned an invalid deletion operation');
    }
    const operationUrl = new URL(link.href);
    if (
      operationUrl.origin !== origin || operationUrl.username || operationUrl.password ||
      !/^\/v1\/disk\/operations\/[^/]+$/.test(operationUrl.pathname)
    ) {
      throw new Error('Yandex Disk returned an invalid deletion operation URL');
    }

    while (true) {
      const poll = await fetch(operationUrl, { ...options, method: 'GET' });
      if (!poll.ok) {
        await poll.body?.cancel();
        throw new Error(`Yandex Disk deletion status failed (HTTP ${poll.status})`);
      }
      const operation = await poll.json() as { status?: unknown };
      if (operation?.status === 'success') return { success: true };
      if (operation?.status !== 'in-progress') {
        throw new Error('Yandex Disk deletion did not succeed');
      }
      await sleep(OPERATION_POLL_MS, undefined, { signal });
    }
  } catch (error) {
    return {
      success: false,
      error: signal.aborted
        ? 'Yandex Disk deletion completion was not confirmed before timeout'
        : error instanceof Error ? error.message : 'Yandex Disk deletion failed',
    };
  }
}
