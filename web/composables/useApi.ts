import {
  resolveApiRequestScope,
  type ApiRequestScope,
} from '~/utils/api-request-scope';
import {
  assertSelectedTargetContext,
  type SelectedTargetSnapshot,
} from '~/utils/selected-target-context';
import { evaluateRemoteCapability } from '~/utils/remote-capability';
import { resolveRemoteHttpAction } from '~/utils/remote-action-resolver';

export interface ApiCallOptions {
  scope?: ApiRequestScope;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

interface ApiOptions extends ApiCallOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;
  requireAuth?: boolean;
}

interface RemoteAbortHandle {
  signal: AbortSignal | undefined;
  release(): void;
}

interface ApiTransportContext {
  prefix: string;
  snapshot: SelectedTargetSnapshot | null;
}

interface ClientRemoteCapabilityError extends Error {
  code: string;
  reasonCode: string | null;
  actionId: string | null;
}

const remoteAbortControllers = new Set<AbortController>();

export function cancelRemoteApiRequests(): void {
  for (const controller of remoteAbortControllers) controller.abort();
  remoteAbortControllers.clear();
}

function remoteAbortHandle(
  remote: boolean,
  external: AbortSignal | undefined,
): RemoteAbortHandle {
  if (!remote) return { signal: external, release: () => undefined };
  const controller = new AbortController();
  remoteAbortControllers.add(controller);
  const abort = () => controller.abort();
  if (external?.aborted) controller.abort();
  else external?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    release: () => {
      external?.removeEventListener('abort', abort);
      remoteAbortControllers.delete(controller);
    },
  };
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

const MUTATION_METHODS = new Set(['DELETE', 'PATCH', 'POST', 'PUT']);

function hasHeader(headers: Record<string, string>, expected: string): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase() === expected);
}

function newIdempotencyKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (!uuid) throw new Error('Secure idempotency key generation is unavailable');
  return `web-${uuid}`;
}

function attachRemoteMutationIdempotency(
  headers: Record<string, string>,
  method: string,
  remote: boolean,
): void {
  if (remote && MUTATION_METHODS.has(method) && !hasHeader(headers, 'idempotency-key')) {
    headers['Idempotency-Key'] = newIdempotencyKey();
  }
}

function assertRemoteActionAvailable(
  endpoint: string,
  method: string,
  transport: ApiTransportContext,
): void {
  if (!transport.snapshot || transport.snapshot.registryGeneration === 0) return;
  const action = resolveRemoteHttpAction(method, endpoint);
  const store = useServerStore();
  const decision = evaluateRemoteCapability({
    isLocal: false,
    context: store.remoteContext,
    role: useAuthStore().user?.role ?? null,
    requirement: {
      actionId: action?.actionId ?? '__uncatalogued__',
      transport: 'http',
      mutation: MUTATION_METHODS.has(method),
    },
  });
  if (action && decision.available) return;
  const error = new Error(
    action ? decision.message : 'Target не объявил capability для этого действия.',
  ) as ClientRemoteCapabilityError;
  error.name = 'RemoteCapabilityError';
  error.code = decision.code ?? 'REMOTE_ACTION_UNSUPPORTED';
  error.reasonCode = decision.reasonCode;
  error.actionId = action?.actionId ?? null;
  throw error;
}

export function useApi(defaultScope: ApiRequestScope = 'selected-target') {
  const config = useRuntimeConfig();
  const baseUrl = config.public.apiBase as string;

  function captureTransportContext(
    endpoint: string,
    requestedScope: ApiRequestScope,
  ): ApiTransportContext {
    if (resolveApiRequestScope(endpoint, requestedScope) === 'master') {
      return { prefix: '', snapshot: null };
    }
    const snapshot = useServerStore().captureRemoteRequestContext();
    return snapshot
      ? { prefix: `/proxy/${snapshot.transportServerId}`, snapshot }
      : { prefix: '', snapshot: null };
  }

  function assertTransportContextCurrent(context: ApiTransportContext): void {
    if (!context.snapshot) return;
    const store = useServerStore();
    const current = store.isRemoteRequestContextCurrent(context.snapshot)
      ? store.captureRemoteRequestContext()
      : null;
    assertSelectedTargetContext(context.snapshot, current);
  }

  function requestedScope(endpoint: string, options: ApiCallOptions): ApiRequestScope {
    return resolveApiRequestScope(endpoint, options.scope ?? defaultScope);
  }

  async function request<T>(endpoint: string, options: ApiOptions = {}): Promise<T> {
    const {
      method = 'GET',
      body,
      requireAuth = true,
      signal,
      headers: customHeaders,
    } = options;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...customHeaders,
    };

    if (requireAuth) {
      const token = localStorage.getItem('accessToken');
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }

    const scope = requestedScope(endpoint, options);
    const transport = captureTransportContext(endpoint, scope);
    attachRemoteMutationIdempotency(headers, method, transport.snapshot !== null);
    const abort = remoteAbortHandle(transport.snapshot !== null, signal);

    try {
      assertTransportContextCurrent(transport);
      assertRemoteActionAvailable(endpoint, method, transport);
      const response = await $fetch<ApiResult<T>>(`${baseUrl}${transport.prefix}${endpoint}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers,
        signal: abort.signal,
      });

      assertTransportContextCurrent(transport);
      return response.data;
    } catch (err: unknown) {
      const fetchErr = err as { data?: { error?: { message?: string | string[] } }; statusCode?: number; response?: { status?: number } };
      const status = fetchErr.statusCode || fetchErr.response?.status;

      // If 401 and we have a refresh token, try to refresh
      if (status === 401 && requireAuth) {
        const refreshed = await tryRefreshToken();
        if (refreshed) {
          assertTransportContextCurrent(transport);
          assertRemoteActionAvailable(endpoint, method, transport);
          const newToken = localStorage.getItem('accessToken');
          if (newToken) {
            headers['Authorization'] = `Bearer ${newToken}`;
          }
          const retryResponse = await $fetch<ApiResult<T>>(`${baseUrl}${transport.prefix}${endpoint}`, {
            method,
            body: body === undefined ? undefined : JSON.stringify(body),
            headers,
            signal: abort.signal,
          });
          assertTransportContextCurrent(transport);
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
        const apiError = new Error(
          Array.isArray(apiMessage) ? apiMessage.join(', ') : apiMessage,
        ) as Error & { status?: number };
        apiError.status = status;
        throw apiError;
      }
      throw err;
    } finally {
      abort.release();
    }
  }

  async function requestWithMeta<T>(endpoint: string, options: ApiOptions = {}): Promise<{ data: T; meta: ApiResult<T>['meta'] }> {
    const {
      method = 'GET',
      body,
      requireAuth = true,
      headers: customHeaders,
      signal,
    } = options;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...customHeaders,
    };

    if (requireAuth) {
      const token = localStorage.getItem('accessToken');
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }

    const scope = requestedScope(endpoint, options);
    const transport = captureTransportContext(endpoint, scope);
    attachRemoteMutationIdempotency(headers, method, transport.snapshot !== null);
    const abort = remoteAbortHandle(transport.snapshot !== null, signal);
    try {
      assertTransportContextCurrent(transport);
      assertRemoteActionAvailable(endpoint, method, transport);
      const response = await $fetch<ApiResult<T>>(`${baseUrl}${transport.prefix}${endpoint}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers,
        signal: abort.signal,
      });
      assertTransportContextCurrent(transport);
      return { data: response.data, meta: response.meta };
    } finally {
      abort.release();
    }
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
  async function download(
    endpoint: string,
    filename: string,
    onProgress?: (pct: number) => void,
    options: ApiCallOptions = {},
  ) {
    const token = localStorage.getItem('accessToken');
    const scope = requestedScope(endpoint, options);
    const transport = captureTransportContext(endpoint, scope);
    const abort = remoteAbortHandle(transport.snapshot !== null, options.signal);

    try {
      assertTransportContextCurrent(transport);
      assertRemoteActionAvailable(endpoint, 'GET', transport);
      const response = await fetch(`${baseUrl}${transport.prefix}${endpoint}`, {
        headers: { Authorization: `Bearer ${token || ''}`, ...options.headers },
        signal: abort.signal,
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
      assertTransportContextCurrent(transport);

      const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);

      // Only use streaming when we have progress callback, Content-Length, and a readable body
      if (onProgress && contentLength && response.body) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          assertTransportContextCurrent(transport);
          chunks.push(value);
          received += value.length;
          onProgress(Math.min(99, Math.round((received / contentLength) * 100)));
        }

        const blob = new Blob(
          chunks.map((chunk) => chunk.slice().buffer as ArrayBuffer),
        );
        assertTransportContextCurrent(transport);
        onProgress(100);
        triggerBlobDownload(blob, filename);
      } else {
        // Simple fallback: read entire response as blob
        const blob = await response.blob();
        assertTransportContextCurrent(transport);
        onProgress?.(100);
        triggerBlobDownload(blob, filename);
      }
    } finally {
      abort.release();
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
  async function upload<T>(
    endpoint: string,
    file: File,
    extraFields?: Record<string, string>,
    options: ApiCallOptions = {},
  ): Promise<T> {
    const token = localStorage.getItem('accessToken');
    const scope = requestedScope(endpoint, options);
    const transport = captureTransportContext(endpoint, scope);
    const abort = remoteAbortHandle(transport.snapshot !== null, options.signal);

    const formData = new FormData();
    formData.append('file', file);
    if (extraFields) {
      for (const [k, v] of Object.entries(extraFields)) {
        formData.append(k, v);
      }
    }

    try {
      assertTransportContextCurrent(transport);
      assertRemoteActionAvailable(endpoint, 'POST', transport);
      const response = await fetch(`${baseUrl}${transport.prefix}${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token || ''}`,
          ...options.headers,
        },
        body: formData,
        signal: abort.signal,
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
      assertTransportContextCurrent(transport);
      return json.data;
    } finally {
      abort.release();
    }
  }

  async function rawText(endpoint: string, options: ApiCallOptions = {}): Promise<string> {
    const scope = requestedScope(endpoint, options);
    const transport = captureTransportContext(endpoint, scope);
    const abort = remoteAbortHandle(transport.snapshot !== null, options.signal);
    const fetchText = async () => {
      assertTransportContextCurrent(transport);
      assertRemoteActionAvailable(endpoint, 'GET', transport);
      const token = localStorage.getItem('accessToken');
      return fetch(`${baseUrl}${transport.prefix}${endpoint}`, {
        headers: { Authorization: `Bearer ${token || ''}`, ...options.headers },
        cache: 'no-store',
        signal: abort.signal,
      });
    };

    try {
      let response = await fetchText();
      if (response.status === 401 && (await tryRefreshToken())) {
        response = await fetchText();
      }
      if (!response.ok) {
        let message = `Ошибка запроса (${response.status})`;
        try {
          const body = await response.json();
          message = body?.error?.message || message;
        } catch {
          /* response is not JSON */
        }
        throw new Error(Array.isArray(message) ? message.join(', ') : message);
      }
      const text = await response.text();
      assertTransportContextCurrent(transport);
      return text;
    } finally {
      abort.release();
    }
  }

  return {
    capability: (method: string, endpoint: string) => {
      const scope = resolveApiRequestScope(endpoint, defaultScope);
      const transport = captureTransportContext(endpoint, scope);
      try {
        assertRemoteActionAvailable(endpoint, method.toUpperCase(), transport);
        return { available: true, code: null, reasonCode: null, actionId: resolveRemoteHttpAction(method, endpoint)?.actionId ?? null };
      } catch (error) {
        const denied = error as ClientRemoteCapabilityError;
        return {
          available: false,
          code: denied.code ?? 'REMOTE_ACTION_UNSUPPORTED',
          reasonCode: denied.reasonCode ?? null,
          actionId: denied.actionId ?? null,
          message: denied.message,
        };
      }
    },
    get: <T>(
      endpoint: string,
      opts?: ApiCallOptions,
    ) => request<T>(endpoint, {
      ...opts,
    }),
    post: <T>(
      endpoint: string,
      body?: unknown,
      opts?: ApiCallOptions,
    ) =>
      request<T>(endpoint, {
        method: 'POST',
        body,
        ...opts,
      }),
    put: <T>(
      endpoint: string,
      body?: unknown,
      opts?: ApiCallOptions,
    ) =>
      request<T>(endpoint, {
        method: 'PUT',
        body,
        ...opts,
      }),
    del: <T>(
      endpoint: string,
      body?: unknown,
      opts?: ApiCallOptions,
    ) => request<T>(endpoint, { method: 'DELETE', body, ...opts }),
    // alias `delete` для DRY: исторически было только `del` (зарезервированное
    // слово в JS как имя method-call было нормально, но кто-то по привычке
    // пишет `api.delete(...)` — раньше это давало "p.delete is not a function".
    // Поддерживаем оба имени, чтобы новые коллеги/места не ловили этот баг.
    delete: <T>(
      endpoint: string,
      body?: unknown,
      opts?: ApiCallOptions,
    ) => request<T>(endpoint, { method: 'DELETE', body, ...opts }),
    patch: <T>(
      endpoint: string,
      body?: unknown,
      opts?: ApiCallOptions,
    ) => request<T>(endpoint, { method: 'PATCH', body, ...opts }),
    publicPost: <T>(endpoint: string, body?: unknown, opts?: ApiCallOptions) =>
      request<T>(endpoint, { method: 'POST', body, requireAuth: false, ...opts }),
    publicGet: <T>(endpoint: string, opts?: ApiCallOptions) =>
      request<T>(endpoint, { requireAuth: false, ...opts }),
    getWithMeta: <T>(endpoint: string, opts?: ApiCallOptions) =>
      requestWithMeta<T>(endpoint, opts),
    download,
    rawText,
    upload: <T>(
      endpoint: string,
      file: File,
      extraFields?: Record<string, string>,
      options?: ApiCallOptions,
    ) => upload<T>(endpoint, file, extraFields, options),
  };
}
