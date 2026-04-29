interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;
  requireAuth?: boolean;
}

// Shared singleton — один refresh на весь клиент, даже если useApi() вызвали в разных компонентах.
let refreshInFlight: Promise<boolean> | null = null;

// Кросс-табовая синхронизация: если юзер держит meowbox открытым в нескольких
// вкладках, все они после pm2 restart одновременно получают 401 и бьют в
// /auth/refresh ОДНИМ и тем же токеном. На бэке это триггерит «token reuse
// detected» → 403 → фронт кикал на /login → копились сессии после каждого деплоя.
//
// Решение: BroadcastChannel. Первая вкладка захватывает мьютекс (через
// localStorage-токен), остальные ждут результата. Новый токен летит через
// BroadcastChannel — все вкладки читают свежий accessToken/refreshToken из
// localStorage и просто ретраят свой запрос.
//
// Дополнительно: бэк теперь grace-period'ит конкурентный refresh в течение 15с,
// так что даже если кросс-таб-лок проспал — сессия не рвётся (выдаются новые
// токены вместо 403). Эти два механизма независимы и усиливают друг друга.
const REFRESH_LOCK_KEY = 'meowbox.refreshLock';
const REFRESH_LOCK_TTL_MS = 10_000; // дольше не держим — защита от зависания вкладки
type RefreshChannelMsg =
  | { type: 'started'; by: string }
  | { type: 'done'; ok: boolean; by: string };
let refreshChannel: BroadcastChannel | null = null;
function getRefreshChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  if (!refreshChannel) {
    try {
      refreshChannel = new BroadcastChannel('meowbox-auth');
    } catch {
      refreshChannel = null;
    }
  }
  return refreshChannel;
}
function acquireRefreshLock(): string | null {
  if (typeof localStorage === 'undefined') return 'noop';
  const now = Date.now();
  const raw = localStorage.getItem(REFRESH_LOCK_KEY);
  if (raw) {
    const ts = parseInt(raw.split(':')[1] || '0', 10);
    if (ts && now - ts < REFRESH_LOCK_TTL_MS) {
      // Другой таб держит лок — не захватываем.
      return null;
    }
  }
  const id = `${Math.random().toString(36).slice(2, 10)}:${now}`;
  localStorage.setItem(REFRESH_LOCK_KEY, id);
  return id;
}
function releaseRefreshLock(id: string) {
  if (typeof localStorage === 'undefined') return;
  const raw = localStorage.getItem(REFRESH_LOCK_KEY);
  if (raw === id) localStorage.removeItem(REFRESH_LOCK_KEY);
}
function waitForOtherTabRefresh(): Promise<boolean> {
  return new Promise((resolve) => {
    const ch = getRefreshChannel();
    if (!ch) return resolve(false);
    const timeout = setTimeout(() => {
      ch.removeEventListener('message', onMsg as EventListener);
      resolve(false);
    }, REFRESH_LOCK_TTL_MS);
    const onMsg = (ev: MessageEvent<RefreshChannelMsg>) => {
      if (ev.data?.type === 'done') {
        clearTimeout(timeout);
        ch.removeEventListener('message', onMsg as EventListener);
        resolve(ev.data.ok);
      }
    };
    ch.addEventListener('message', onMsg as EventListener);
  });
}

interface ApiResult<T> {
  success: boolean;
  data: T;
  meta?: {
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
  };
}

export function useApi() {
  const config = useRuntimeConfig();
  const baseUrl = config.public.apiBase as string;

  function getProxyPrefix(): string {
    try {
      const serverStore = useServerStore();
      if (serverStore.isLocal) return '';
      return `/proxy/${serverStore.currentServerId}`;
    } catch {
      return '';
    }
  }

  async function request<T>(endpoint: string, options: ApiOptions = {}): Promise<T> {
    const { method = 'GET', body, requireAuth = true } = options;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (requireAuth) {
      const token = localStorage.getItem('accessToken');
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }

    // Proxy prefix for remote servers (skip for /servers and /proxy/* endpoints)
    const prefix = endpoint.startsWith('/servers') || endpoint.startsWith('/proxy/') ? '' : getProxyPrefix();

    try {
      const response = await $fetch<ApiResult<T>>(`${baseUrl}${prefix}${endpoint}`, {
        method,
        body: body ? JSON.stringify(body) : undefined,
        headers,
      });

      return response.data;
    } catch (err: unknown) {
      const fetchErr = err as { data?: { error?: { message?: string | string[] } }; statusCode?: number; response?: { status?: number } };
      const status = fetchErr.statusCode || fetchErr.response?.status;

      // If 401 and we have a refresh token, try to refresh
      if (status === 401 && requireAuth) {
        const refreshed = await tryRefreshToken();
        if (refreshed) {
          const newToken = localStorage.getItem('accessToken');
          if (newToken) {
            headers['Authorization'] = `Bearer ${newToken}`;
          }
          const retryResponse = await $fetch<ApiResult<T>>(`${baseUrl}${prefix}${endpoint}`, {
            method,
            body: body ? JSON.stringify(body) : undefined,
            headers,
          });
          return retryResponse.data;
        } else {
          localStorage.removeItem('accessToken');
          localStorage.removeItem('refreshToken');
          navigateTo('/login');
        }
      }

      // Extract human-readable message from API error response
      // GlobalExceptionFilter returns: { success: false, error: { code, message } }
      const apiMessage = fetchErr.data?.error?.message;
      if (apiMessage) {
        throw new Error(Array.isArray(apiMessage) ? apiMessage.join(', ') : apiMessage);
      }
      throw err;
    }
  }

  async function requestWithMeta<T>(endpoint: string, options: ApiOptions = {}): Promise<{ data: T; meta: ApiResult<T>['meta'] }> {
    const { method = 'GET', body, requireAuth = true } = options;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (requireAuth) {
      const token = localStorage.getItem('accessToken');
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }

    const prefix = endpoint.startsWith('/servers') || endpoint.startsWith('/proxy/') ? '' : getProxyPrefix();

    const response = await $fetch<ApiResult<T>>(`${baseUrl}${prefix}${endpoint}`, {
      method,
      body: body ? JSON.stringify(body) : undefined,
      headers,
    });

    return { data: response.data, meta: response.meta };
  }

  // Singleton-промис: при одновременном 401 с нескольких запросов refresh'имся ровно один раз.
  // Без этого параллельные refresh-запросы могут ротировать jti и рубить друг друга в SessionService.
  // Плюс кросс-табовый лок через localStorage+BroadcastChannel — чтобы другие
  // вкладки ждали результат, а не лупили /auth/refresh тем же токеном.
  async function tryRefreshToken(): Promise<boolean> {
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = (async () => {
      const refreshToken = localStorage.getItem('refreshToken');
      if (!refreshToken) return false;

      // Пытаемся захватить кросс-табовый лок. Если не получилось — другой
      // таб уже refreshит; ждём сигнал о результате и читаем свежий токен.
      const lockId = acquireRefreshLock();
      if (!lockId) {
        const ok = await waitForOtherTabRefresh();
        if (ok) return true;
        // Другой таб не дал сигнал за TTL — попробуем сами, с новой попыткой лока.
        const retryLock = acquireRefreshLock();
        if (!retryLock) return false;
        return await doActualRefresh(retryLock);
      }
      return await doActualRefresh(lockId);
    })();

    return refreshInFlight;
  }

  async function doActualRefresh(lockId: string): Promise<boolean> {
    const refreshToken = localStorage.getItem('refreshToken');
    if (!refreshToken) {
      releaseRefreshLock(lockId);
      return false;
    }
    const ch = getRefreshChannel();
    try {
      ch?.postMessage({ type: 'started', by: lockId } satisfies RefreshChannelMsg);
      const response = await $fetch<ApiResult<{ accessToken: string; refreshToken: string }>>(
        `${baseUrl}/auth/refresh`,
        {
          method: 'POST',
          body: JSON.stringify({ refreshToken }),
          headers: { 'Content-Type': 'application/json' },
        },
      );
      if (response.success) {
        localStorage.setItem('accessToken', response.data.accessToken);
        localStorage.setItem('refreshToken', response.data.refreshToken);
        ch?.postMessage({ type: 'done', ok: true, by: lockId } satisfies RefreshChannelMsg);
        return true;
      }
      ch?.postMessage({ type: 'done', ok: false, by: lockId } satisfies RefreshChannelMsg);
      return false;
    } catch {
      // Refresh failed — чистим локальные токены, чтобы middleware сразу кикнул на /login.
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      ch?.postMessage({ type: 'done', ok: false, by: lockId } satisfies RefreshChannelMsg);
      return false;
    } finally {
      releaseRefreshLock(lockId);
      setTimeout(() => { refreshInFlight = null; }, 0);
    }
  }

  /**
   * Download a file from an API endpoint (binary, with auth).
   * Streams response for progress tracking and triggers browser download.
   * @param onProgress - optional callback receiving 0-100 progress percentage
   */
  async function download(endpoint: string, filename: string, onProgress?: (pct: number) => void) {
    const token = localStorage.getItem('accessToken');
    const prefix = endpoint.startsWith('/servers') || endpoint.startsWith('/proxy/') ? '' : getProxyPrefix();

    const response = await fetch(`${baseUrl}${prefix}${endpoint}`, {
      headers: { Authorization: `Bearer ${token || ''}` },
    });

    if (!response.ok) {
      try {
        const body = await response.json();
        throw new Error(body?.error?.message || `Ошибка скачивания (${response.status})`);
      } catch (err) {
        if (err instanceof Error && err.message !== `Ошибка скачивания (${response.status})`) throw err;
        throw new Error(`Ошибка скачивания (${response.status})`);
      }
    }

    const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);

    // Only use streaming when we have progress callback, Content-Length, and a readable body
    if (onProgress && contentLength && response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        onProgress(Math.min(99, Math.round((received / contentLength) * 100)));
      }

      const blob = new Blob(chunks);
      onProgress(100);
      triggerBlobDownload(blob, filename);
    } else {
      // Simple fallback: read entire response as blob
      const blob = await response.blob();
      onProgress?.(100);
      triggerBlobDownload(blob, filename);
    }
  }

  function triggerBlobDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Upload a file to an API endpoint (multipart/form-data, with auth).
   */
  async function upload<T>(endpoint: string, file: File, extraFields?: Record<string, string>): Promise<T> {
    const token = localStorage.getItem('accessToken');
    const prefix = endpoint.startsWith('/servers') || endpoint.startsWith('/proxy/') ? '' : getProxyPrefix();

    const formData = new FormData();
    formData.append('file', file);
    if (extraFields) {
      for (const [k, v] of Object.entries(extraFields)) {
        formData.append(k, v);
      }
    }

    const response = await fetch(`${baseUrl}${prefix}${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token || ''}` },
      body: formData,
    });

    if (!response.ok) {
      try {
        const body = await response.json();
        throw new Error(body?.error?.message || `Ошибка загрузки (${response.status})`);
      } catch (err) {
        if (err instanceof Error) throw err;
        throw new Error(`Ошибка загрузки (${response.status})`);
      }
    }

    const json = await response.json();
    return json.data;
  }

  return {
    get: <T>(endpoint: string) => request<T>(endpoint),
    post: <T>(endpoint: string, body?: unknown) =>
      request<T>(endpoint, { method: 'POST', body }),
    put: <T>(endpoint: string, body?: unknown) =>
      request<T>(endpoint, { method: 'PUT', body }),
    del: <T>(endpoint: string, body?: unknown) =>
      request<T>(endpoint, { method: 'DELETE', body }),
    patch: <T>(endpoint: string, body?: unknown) =>
      request<T>(endpoint, { method: 'PATCH', body }),
    publicPost: <T>(endpoint: string, body?: unknown) =>
      request<T>(endpoint, { method: 'POST', body, requireAuth: false }),
    publicGet: <T>(endpoint: string) =>
      request<T>(endpoint, { requireAuth: false }),
    getWithMeta: <T>(endpoint: string) => requestWithMeta<T>(endpoint),
    download,
    upload: <T>(endpoint: string, file: File, extraFields?: Record<string, string>) =>
      upload<T>(endpoint, file, extraFields),
  };
}
