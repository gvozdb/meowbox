/**
 * Тонкий fetch-обёртка для интеграций с внешними API.
 *
 * Особенности:
 * - таймаут (default 15s) через AbortController
 * - retry on 429 + 5xx с экспоненциальным backoff (1-2-4 сек)
 * - JSON-helper: `.json()` парсит ответ, кидает ApiFetchError при !ok
 *
 * Не используем axios — у Node 22 есть глобальный fetch, лишняя зависимость не нужна.
 */

export interface ApiFetchOptions extends Omit<RequestInit, 'signal'> {
  timeoutMs?: number;
  retries?: number; // default 3
  retryDelayMs?: number; // initial delay; doubles each attempt
}

export class ApiFetchError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly bodyText?: string,
  ) {
    super(message);
    this.name = 'ApiFetchError';
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_INITIAL_DELAY_MS = 1000;

// Идемпотентные методы — можно безопасно ретраить на сетевых/5xx ошибках.
// POST/PATCH могут иметь side-effect → ретрай создаст дубль (например, две A-записи в Cloudflare).
// PUT исключён намеренно: Designate v2 PUT перезаписывает concurrent change → семантически
// не идемпотентен в нашем контексте.
// Для не-идемпотентных методов сетевые ошибки НЕ ретраим: запрос мог дойти до сервера
// и сработать, но ответ потерялся в timeout — повтор создаст дубль.
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'DELETE']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Выполнить fetch к внешнему API с timeout и retry.
 * Бросает ApiFetchError на финальный неуспех.
 */
export async function apiFetch(url: string, init: ApiFetchOptions = {}): Promise<Response> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    retryDelayMs = DEFAULT_INITIAL_DELAY_MS,
    ...rest
  } = init;

  const method = (rest.method || 'GET').toUpperCase();
  const isIdempotent = IDEMPOTENT_METHODS.has(method);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...rest, signal: controller.signal });
      clearTimeout(timeout);
      // 429 — корректно ретраить даже для POST: сервер явно сказал "повтори позже",
      // запрос ещё не был обработан. 5xx ретраим только для идемпотентных методов.
      const shouldRetryByStatus =
        res.status === 429 ||
        (isIdempotent && res.status >= 500 && res.status < 600);
      if (shouldRetryByStatus) {
        if (attempt < retries) {
          const retryAfterHeader = res.headers.get('retry-after');
          let delay = retryDelayMs * Math.pow(2, attempt);
          if (retryAfterHeader) {
            const ra = parseInt(retryAfterHeader, 10);
            if (Number.isFinite(ra) && ra > 0) delay = Math.max(delay, ra * 1000);
          }
          // Не сжигаем response на retry — закрываем body
          try { await res.text(); } catch { /* ignore */ }
          await sleep(delay);
          continue;
        }
      }
      return res;
    } catch (err) {
      clearTimeout(timeout);
      lastErr = err;
      // Сетевая ошибка — ответ не пришёл. Для идемпотентных методов ретраим.
      // Для POST/PATCH/PUT ретраить нельзя: запрос мог дойти до сервера и сработать,
      // но ответ потерялся в timeout — повтор создаст дубль.
      if (isIdempotent && attempt < retries) {
        await sleep(retryDelayMs * Math.pow(2, attempt));
        continue;
      }
      break; // не-идемпотентные: первая же сетевая ошибка — финальная
    }
  }
  throw new ApiFetchError(
    lastErr instanceof Error ? lastErr.message : 'apiFetch failed',
    0,
  );
}

/** Helper: JSON-запрос. Возвращает разобранный JSON. Бросает ApiFetchError на !ok. */
export async function apiFetchJson<T>(url: string, init: ApiFetchOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...((init.headers as Record<string, string>) || {}),
  };
  if (init.body && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await apiFetch(url, { ...init, headers });
  const text = await res.text();
  if (!res.ok) {
    throw new ApiFetchError(
      `${res.status} ${res.statusText}`,
      res.status,
      text.slice(0, 4096),
    );
  }
  if (!text) return undefined as unknown as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiFetchError(
      `Invalid JSON response: ${text.slice(0, 200)}`,
      res.status,
      text,
    );
  }
}
