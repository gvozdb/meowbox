/**
 * Basic Auth server middleware (Nuxt/Nitro).
 *
 * Проверяет HTTP Basic Authorization на всех входящих запросах к панели
 * (кроме /api/internal/* — внутренний самообмен, защищён своим токеном).
 *
 * Конфиг и верификация идут через внутренние API-эндпоинты:
 *   GET  /api/internal/basic-auth         → { enabled, username }
 *   POST /api/internal/basic-auth/verify  → { ok }
 * Защищены заголовком X-Internal-Token (env INTERNAL_TOKEN / AGENT_SECRET).
 *
 * Так Nuxt не хранит argon2-хэши и не нуждается в argon2-зависимости.
 * Кеш «enabled?» — 30 сек (негативный 5 сек), чтобы не дёргать API на каждый запрос.
 */
import { defineEventHandler, getRequestURL, getHeader, setHeader, sendError, createError } from 'h3';

interface BasicAuthPubCfg {
  enabled: boolean;
  username: string;
}

let cache: { data: BasicAuthPubCfg; until: number } | null = null;
const CACHE_TTL_MS = Number(process.env.INTERNAL_AUTH_CACHE_TTL_MS) || 30_000;
const CACHE_NEG_TTL_MS = Number(process.env.INTERNAL_AUTH_NEG_CACHE_TTL_MS) || 5_000;
// HTTP-таймауты на запросы к API. На холодном старте API может отвечать
// дольше 2с — лучше дать запас, чем ложный 401 при первом hit'е.
const FETCH_CFG_TIMEOUT_MS = Number(process.env.INTERNAL_AUTH_TIMEOUT_MS) || 2000;
const VERIFY_TIMEOUT_MS = Number(process.env.INTERNAL_AUTH_VERIFY_TIMEOUT_MS) || 3000;

function apiBase(): string {
  const host = process.env.API_HOST || '127.0.0.1';
  const port = process.env.API_PORT || '11860';
  return `http://${host}:${port}`;
}

function internalToken(): string {
  // INTERNAL_TOKEN строго обязателен и не равен AGENT_SECRET — fallback на
  // AGENT_SECRET склеивал секреты агента и панели (см. API guard).
  const t = process.env.INTERNAL_TOKEN || '';
  if (t && t === (process.env.AGENT_SECRET || '')) {
    // Возвращаем пустую строку — API всё равно отобьёт запрос с 401,
    // и Basic-Auth просто останется выключен до исправления .env.
    return '';
  }
  return t;
}

async function fetchConfig(): Promise<BasicAuthPubCfg> {
  const now = Date.now();
  if (cache && cache.until > now) return cache.data;

  try {
    const res = await $fetch<BasicAuthPubCfg>(`${apiBase()}/api/internal/basic-auth`, {
      headers: { 'X-Internal-Token': internalToken() },
      timeout: FETCH_CFG_TIMEOUT_MS,
    });
    const data = { enabled: !!res.enabled, username: res.username || '' };
    cache = { data, until: now + CACHE_TTL_MS };
    return data;
  } catch {
    const data = { enabled: false, username: '' };
    cache = { data, until: now + CACHE_NEG_TTL_MS };
    return data;
  }
}

async function verifyBasic(username: string, password: string): Promise<boolean> {
  try {
    const res = await $fetch<{ ok: boolean }>(`${apiBase()}/api/internal/basic-auth/verify`, {
      method: 'POST',
      headers: { 'X-Internal-Token': internalToken() },
      body: { username, password },
      timeout: VERIFY_TIMEOUT_MS,
    });
    return !!res.ok;
  } catch {
    return false;
  }
}

function parseBasic(header: string | undefined): { user: string; pass: string } | null {
  if (!header || !header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

export default defineEventHandler(async (event) => {
  const url = getRequestURL(event);

  // Internal endpoints: никогда не прикрываем Basic Auth, иначе Nuxt сам себя не достучится.
  if (url.pathname.startsWith('/api/internal/')) return;

  const cfg = await fetchConfig();
  if (!cfg.enabled) return;

  const auth = getHeader(event, 'authorization');
  const creds = parseBasic(auth);

  if (creds && creds.user === cfg.username) {
    const ok = await verifyBasic(creds.user, creds.pass);
    if (ok) return;
  }

  setHeader(event, 'WWW-Authenticate', 'Basic realm="Meowbox Panel", charset="UTF-8"');
  return sendError(event, createError({ statusCode: 401, statusMessage: 'Authentication required' }));
});
