/**
 * Yandex 360 для бизнеса — DNS API через api360.yandex.net.
 *
 * Что это: административная панель admin.yandex.ru/api360.yandex.net для
 * корпоративных доменов. ДНС-зоны привязаны к организации (orgId) и доменам,
 * подключённым в "Я360 для бизнеса". В отличие от Yandex Cloud DNS — это не
 * самостоятельный DNS-сервис, а DNS-записи делегированного на Яндекс домена.
 *
 * Авторизация: OAuth Authorization Code flow с refresh_token.
 *   - Юзер регистрирует OAuth-приложение на oauth.yandex.ru → получает client_id и client_secret.
 *   - Получает Authorization Code через response_type=code (redirect_uri=oauth.yandex.ru/verification_code).
 *   - Бэк меняет code → {access_token, refresh_token, expires_in} через POST oauth.yandex.ru/token.
 *   - access_token живёт ~1 год, но мы рефрешим за 5 минут до истечения через refresh_token.
 *   - refresh_token живёт бессрочно (пока юзер не отзовёт в Я.Аккаунте).
 *
 * Заголовок: "Authorization: OAuth <token>" (НЕ "Bearer"!).
 *
 * Скоупы (нужны ОБА):
 *   - directory:read_domains — список доменов организации (= list зон)
 *   - directory:manage_dns   — CRUD по DNS-записям домена
 *
 * Модель:
 *   - "Зона" = домен организации. externalId зоны = имя домена (например, "example.com").
 *   - "Запись" имеет числовой recordId (уникальный в рамках домена). externalId = string(recordId).
 *
 * Endpoint:
 *   GET    /directory/v1/org/{orgId}/domains              — список доменов
 *   GET    /directory/v1/org/{orgId}/domains/{domain}/dns — записи
 *   POST   /directory/v1/org/{orgId}/domains/{domain}/dns — создать
 *   POST   /directory/v1/org/{orgId}/domains/{domain}/dns/{recordId} — обновить
 *   DELETE /directory/v1/org/{orgId}/domains/{domain}/dns/{recordId} — удалить
 *
 * Лимиты бесплатного тарифа: ~1000 запросов/сутки на организацию.
 */

import { ApiFetchError, apiFetchJson } from '../../common/http/api-fetch';
import { assertSafeExternalUrl } from '../../common/http/url-guard';
import {
  DnsProvider, DnsProviderContext, DnsProviderType, DnsRecordInput,
  DnsRecordRemote, DnsValidationResult, DnsZoneRemote,
} from './dns-provider.interface';

/**
 * Полный набор кредов для Y360. Хранится в credentialsEnc.
 * accessToken/refreshToken/expiresAt обновляются через onCredentialsUpdate
 * при auto-refresh.
 */
export interface Y360Credentials {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  /** Unix-ms когда access_token истекает. */
  expiresAt: number;
}

interface Y360DomainsResponse {
  domains?: Array<{
    name: string;
    verified?: boolean;
    delegated?: boolean;
    master?: boolean;
    mx?: boolean;
    pop?: boolean;
    imap?: boolean;
  }>;
  page?: number;
  pages?: number;
  perPage?: number;
  total?: number;
}

interface Y360OrgsResponse {
  organizations?: Array<{
    id: number;
    name?: string;
    subscriptionPlan?: string;
  }>;
  nextPageToken?: string;
}

interface Y360DnsRecord {
  recordId: number;
  name?: string;
  type: string;
  ttl?: number;
  // Type-specific поля:
  address?: string;       // A, AAAA
  target?: string;        // CNAME, NS, SRV
  text?: string;          // TXT
  exchange?: string;      // MX
  preference?: number;    // MX
  priority?: number;      // SRV
  weight?: number;        // SRV
  port?: number;          // SRV
  flag?: number;          // CAA
  tag?: string;           // CAA
  value?: string;         // CAA
}

interface Y360DnsListResponse {
  records?: Y360DnsRecord[];
  page?: number;
  pages?: number;
  perPage?: number;
  total?: number;
}

interface OAuthTokenResponse {
  access_token: string;
  expires_in: number; // seconds
  refresh_token?: string;
  token_type?: string;
}

const DEFAULT_API_BASE = 'https://api360.yandex.net/directory/v1';
const OAUTH_TOKEN_URL = 'https://oauth.yandex.ru/token';
/** Обновляем access_token за N мс до истечения. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
/**
 * Лимиты `perPage` у Y360 List API (живая проверка через curl, документация врёт):
 *   - GET /domains       — max 10 (perPage>10 → 400 invalid_page; default тоже 10)
 *   - GET /domains/.../dns — max 200+ (default 10, документированный default=50 верен)
 *
 * Для разных endpoint'ов используем разные лимиты, иначе list domains падает на 400.
 */
const PAGE_SIZE_DOMAINS = 10;
const PAGE_SIZE_RECORDS = 100;

const guardedUrlCache = new Set<string>();

/** Инвалидирует cached SSRF-guard результат для конкретного apiBaseUrl. */
export function evictYandex360UrlGuardCache(url?: string | null): void {
  if (!url) return;
  guardedUrlCache.delete(url);
}

async function ensureSafeApiBase(apiBaseUrl?: string): Promise<void> {
  if (!apiBaseUrl) return;
  if (guardedUrlCache.has(apiBaseUrl)) return;
  await assertSafeExternalUrl(apiBaseUrl);
  guardedUrlCache.add(apiBaseUrl);
}

function asCreds(creds: unknown): Y360Credentials {
  if (!creds || typeof creds !== 'object') throw new Error('Yandex 360 credentials missing');
  const c = creds as Record<string, unknown>;
  if (typeof c.clientId !== 'string' || !c.clientId) throw new Error('credentials.clientId required');
  if (typeof c.clientSecret !== 'string' || !c.clientSecret) throw new Error('credentials.clientSecret required');
  if (typeof c.accessToken !== 'string' || !c.accessToken) throw new Error('credentials.accessToken required');
  if (typeof c.refreshToken !== 'string' || !c.refreshToken) throw new Error('credentials.refreshToken required');
  const expiresAt = typeof c.expiresAt === 'number' ? c.expiresAt : 0;
  return {
    clientId: c.clientId,
    clientSecret: c.clientSecret,
    accessToken: c.accessToken,
    refreshToken: c.refreshToken,
    expiresAt,
  };
}

/**
 * Обменивает Authorization Code на пару (access_token, refresh_token).
 * Используется один раз — при создании провайдера.
 * Экспортируется чтобы DnsService мог вызвать её при createProvider.
 */
export async function exchangeAuthCodeY360(
  clientId: string, clientSecret: string, code: string,
): Promise<Y360Credentials> {
  if (!clientId || !clientSecret || !code) {
    throw new Error('clientId, clientSecret и code обязательны');
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code.trim(),
    client_id: clientId,
    client_secret: clientSecret,
  }).toString();
  let res: OAuthTokenResponse;
  try {
    res = await apiFetchJson<OAuthTokenResponse>(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (err) {
    if (err instanceof ApiFetchError) {
      const detail = extractY360Body(err.bodyText);
      throw new Error(`Yandex OAuth token exchange failed (HTTP ${err.status}): ${detail || err.message}`);
    }
    throw err;
  }
  if (!res.access_token || !res.refresh_token) {
    throw new Error('Yandex OAuth не вернул access_token или refresh_token');
  }
  return {
    clientId, clientSecret,
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    expiresAt: Date.now() + (res.expires_in * 1000),
  };
}

/**
 * Обновляет access_token через refresh_token. Yandex обычно возвращает НОВЫЙ refresh_token
 * (rotation) — обновляем оба.
 */
async function refreshTokensY360(creds: Y360Credentials): Promise<Y360Credentials> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  }).toString();
  let res: OAuthTokenResponse;
  try {
    res = await apiFetchJson<OAuthTokenResponse>(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (err) {
    if (err instanceof ApiFetchError) {
      const detail = extractY360Body(err.bodyText);
      // Самые типичные причины: refresh_token revoked/expired → юзер должен пересоздать.
      throw new Error(`Yandex OAuth refresh failed (HTTP ${err.status}): ${detail || err.message}. Пересоздай провайдера с новым Authorization Code.`);
    }
    throw err;
  }
  if (!res.access_token) throw new Error('Yandex OAuth refresh не вернул access_token');
  return {
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    accessToken: res.access_token,
    refreshToken: res.refresh_token || creds.refreshToken, // если нового нет — оставляем старый
    expiresAt: Date.now() + (res.expires_in * 1000),
  };
}

/**
 * Гарантирует валидный access_token. Если истекает в течение TOKEN_REFRESH_MARGIN_MS —
 * обновляет через refresh_token и (если есть callback) сохраняет в БД.
 * Возвращает свежие credentials для использования в текущем запросе.
 */
async function ensureFreshToken(
  ctx: DnsProviderContext, creds: Y360Credentials,
): Promise<Y360Credentials> {
  const now = Date.now();
  if (creds.expiresAt && creds.expiresAt - TOKEN_REFRESH_MARGIN_MS > now) {
    return creds;
  }
  const fresh = await refreshTokensY360(creds);
  if (ctx.onCredentialsUpdate) {
    try {
      await ctx.onCredentialsUpdate(fresh);
    } catch (err) {
      // Если БД не записалась — продолжим с in-memory токеном, при следующем вызове
      // будет повторный refresh. Лог через сервис (мы здесь только провайдер).
      // eslint-disable-next-line no-console
      console.warn('[y360] onCredentialsUpdate failed:', (err as Error).message);
    }
  }
  return fresh;
}

function authHeaders(token: string): Record<string, string> {
  // Внимание: Yandex использует "OAuth", а не "Bearer".
  return { Authorization: `OAuth ${token}` };
}

function relName(name: string | undefined, domain: string): string {
  const n = (name || '').trim();
  if (!n || n === '@') return '@';
  const d = domain.toLowerCase();
  const lower = n.toLowerCase().replace(/\.$/, '');
  if (lower === d) return '@';
  if (lower.endsWith(`.${d}`)) return n.replace(/\.$/, '').slice(0, -(d.length + 1));
  return n.replace(/\.$/, '');
}

function nameForApi(name: string): string {
  if (!name || name === '@') return '@';
  return name.replace(/\.$/, '');
}

function mapRecord(rec: Y360DnsRecord, domain: string): DnsRecordRemote {
  const type = (rec.type || '').toUpperCase();
  let content = '';
  let priority: number | undefined;
  switch (type) {
    case 'A':
    case 'AAAA':
      content = rec.address || '';
      break;
    case 'CNAME':
    case 'NS':
      content = rec.target || '';
      break;
    case 'TXT':
      content = rec.text || '';
      break;
    case 'MX':
      content = rec.exchange || '';
      priority = rec.preference;
      break;
    case 'SRV':
      content = [rec.priority ?? 0, rec.weight ?? 0, rec.port ?? 0, rec.target || ''].join(' ');
      priority = rec.priority;
      break;
    case 'CAA':
      content = [rec.flag ?? 0, rec.tag || '', rec.value || ''].join(' ');
      break;
    default:
      content = JSON.stringify(rec);
  }
  return {
    externalId: String(rec.recordId),
    type,
    name: relName(rec.name, domain),
    content,
    ttl: rec.ttl ?? 300,
    priority,
  };
}

function buildBody(input: DnsRecordInput): Record<string, unknown> {
  const type = input.type.toUpperCase();
  const body: Record<string, unknown> = {
    type,
    name: nameForApi(input.name),
    ttl: input.ttl,
  };
  const c = input.content.trim();
  switch (type) {
    case 'A':
    case 'AAAA':
      body.address = c;
      break;
    case 'CNAME':
    case 'NS':
      body.target = c;
      break;
    case 'TXT':
      body.text = c;
      break;
    case 'MX': {
      if (input.priority === undefined || input.priority === null) {
        throw new Error('MX requires priority');
      }
      body.exchange = c;
      body.preference = input.priority;
      break;
    }
    case 'SRV': {
      const parts = c.split(/\s+/);
      let p: number | undefined = input.priority;
      let w: number | undefined;
      let port: number | undefined;
      let target: string | undefined;
      if (parts.length === 4) {
        p = parseInt(parts[0], 10);
        w = parseInt(parts[1], 10);
        port = parseInt(parts[2], 10);
        target = parts[3];
      } else if (parts.length === 3) {
        w = parseInt(parts[0], 10);
        port = parseInt(parts[1], 10);
        target = parts[2];
      } else {
        throw new Error('SRV content must be "priority weight port target" or "weight port target"');
      }
      if (p === undefined || !Number.isFinite(w!) || !Number.isFinite(port!) || !target) {
        throw new Error('SRV: priority/weight/port/target required and must be valid');
      }
      body.priority = p;
      body.weight = w;
      body.port = port;
      body.target = target;
      break;
    }
    case 'CAA': {
      const m = c.match(/^(\d+)\s+(\w+)\s+(.+)$/);
      if (!m) throw new Error('CAA content must be "flag tag value" (e.g. "0 issue letsencrypt.org")');
      body.flag = parseInt(m[1], 10);
      body.tag = m[2];
      body.value = m[3].replace(/^"(.*)"$/, '$1');
      break;
    }
    default:
      throw new Error(`Yandex 360: тип записи ${type} не поддерживается`);
  }
  return body;
}

/**
 * Безопасно извлекает понятное описание ошибки из тела Yandex API ответа.
 * Y360 формат: {"code":N,"message":"...","details":[...]} или просто {"message":"..."}.
 * Длина капируется до 200 символов, прогоняется через redact (на случай эха токена).
 */
function extractY360Body(bodyText?: string): string {
  if (!bodyText) return '';
  let parsed: { code?: number; message?: string; error_description?: string; error?: string } | null = null;
  try { parsed = JSON.parse(bodyText); } catch { /* not JSON */ }
  let raw = '';
  if (parsed && typeof parsed === 'object') {
    if (typeof parsed.message === 'string') raw = parsed.message;
    else if (typeof parsed.error_description === 'string') raw = parsed.error_description;
    else if (typeof parsed.error === 'string') raw = parsed.error;
    else raw = JSON.stringify(parsed);
  } else {
    raw = bodyText;
  }
  return raw
    .replace(/(OAuth\s+|Bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(/("?(?:secret|access_token|refresh_token|token|password|client_secret)"?\s*[:=]\s*"?)([^"\s,}]{6,})/gi, '$1[REDACTED]')
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, '[REDACTED:long]')
    .slice(0, 200);
}

async function y360Fetch<T>(
  token: string, base: string, path: string,
  init: RequestInit & { method?: string } = {},
): Promise<T> {
  const url = `${base}${path}`;
  const method = (init.method || 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD' && method !== 'DELETE';
  try {
    return await apiFetchJson<T>(url, {
      ...init,
      headers: {
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...authHeaders(token),
        ...((init.headers as Record<string, string>) || {}),
      },
    });
  } catch (err) {
    if (err instanceof ApiFetchError) {
      const detail = extractY360Body(err.bodyText);
      const suffix = detail ? ` — ${detail}` : '';
      if (err.status === 400) throw new Error(`Yandex 360: 400 Bad Request${suffix}`);
      if (err.status === 401) throw new Error(`Yandex 360 OAuth-токен невалидный или истёк${suffix}`);
      if (err.status === 403) {
        throw new Error(`Yandex 360: 403 Forbidden (недостаточно прав у OAuth-токена)${suffix}`);
      }
      if (err.status === 404) throw new Error(`Yandex 360: ресурс не найден (orgId/домен/recordId)${suffix}`);
      throw new Error(`Yandex 360 API error (HTTP ${err.status})${suffix}`);
    }
    throw err;
  }
}

/**
 * externalId зоны хранится в формате `<orgId>:<domain>`. Это позволяет
 * одному провайдеру работать с несколькими организациями (у юзера 3 организации
 * = 3 разных orgId, каждая со своим списком доменов). Парсим обратно тут.
 *
 * Формат legacy: просто `<domain>` без двоеточия (старые записи). В этом случае
 * откатываемся на `ctx.scopeId` (если задан). После первого пересинка legacy
 * записи удалятся как orphan (новый externalId не совпадёт).
 */
function parseZoneExternalId(zoneExternalId: string, fallbackOrgId?: string): {
  orgId: string; domain: string;
} {
  const sep = zoneExternalId.indexOf(':');
  if (sep > 0) {
    return {
      orgId: zoneExternalId.slice(0, sep),
      domain: zoneExternalId.slice(sep + 1),
    };
  }
  if (!fallbackOrgId) {
    throw new Error(
      `Yandex 360: не могу определить orgId для зоны "${zoneExternalId}". `
      + 'Пересоздай provider или сделай ручной sync — externalId-формат изменился.',
    );
  }
  return { orgId: fallbackOrgId, domain: zoneExternalId };
}

/**
 * Получает список орг-ов, доступных юзеру. Y360 GET /directory/v1/org
 * возвращает {organizations:[{id,name,subscriptionPlan,...}], nextPageToken}.
 * Пагинация по nextPageToken (опускаем для простоты — у обычного юзера
 * редко больше 100 орг).
 */
async function listOrganizations(
  token: string, base: string,
): Promise<Array<{ id: string; name: string }>> {
  const res = await y360Fetch<Y360OrgsResponse>(token, base, `/org`);
  const orgs = res.organizations || [];
  return orgs.map((o) => ({ id: String(o.id), name: o.name || String(o.id) }));
}

/** Возвращает список orgId, которые надо обойти при listZones. */
async function resolveTargetOrgs(
  token: string, base: string, scopeId?: string,
): Promise<string[]> {
  if (scopeId && scopeId.trim()) return [scopeId.trim()];
  const orgs = await listOrganizations(token, base);
  if (!orgs.length) {
    throw new Error('Yandex 360: у токена нет доступа ни к одной организации.');
  }
  return orgs.map((o) => o.id);
}

export class Yandex360Provider implements DnsProvider {
  readonly type: DnsProviderType = 'YANDEX_360';

  async validateCredentials(ctx: DnsProviderContext): Promise<DnsValidationResult> {
    let creds: Y360Credentials;
    try { creds = asCreds(ctx.credentials); } catch (e) { return { ok: false, error: (e as Error).message }; }
    try {
      await ensureSafeApiBase(ctx.apiBaseUrl);
      const fresh = await ensureFreshToken(ctx, creds);
      const base = ctx.apiBaseUrl || DEFAULT_API_BASE;
      // Если scopeId задан — проверяем list domains в этой орг (и право на эту орг).
      // Если не задан — проверяем что вообще есть хоть одна доступная орг.
      if (ctx.scopeId && ctx.scopeId.trim()) {
        await y360Fetch<Y360DomainsResponse>(
          fresh.accessToken, base,
          `/org/${encodeURIComponent(ctx.scopeId.trim())}/domains?page=1&perPage=${PAGE_SIZE_DOMAINS}`,
        );
      } else {
        const orgs = await listOrganizations(fresh.accessToken, base);
        if (!orgs.length) {
          return { ok: false, error: 'У токена нет доступа ни к одной организации Yandex 360.' };
        }
      }
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('403')) {
        return {
          ok: false,
          error: 'Не хватает scope. Нужны: directory:read_domains (список доменов) и '
            + 'directory:manage_dns (CRUD по DNS-записям). Добавь оба в OAuth-приложение '
            + 'и пересоздай provider (новый Authorization Code). '
            + `Подробности: ${msg}`,
        };
      }
      if (msg.includes('400')) {
        return {
          ok: false,
          error: `Yandex 360 вернул 400. Если задан Org ID — проверь что число корректное `
            + `(admin.yandex.ru/?org=<число>). Можно оставить пустым — тогда будем синкать `
            + `все доступные организации. Подробности: ${msg}`,
        };
      }
      return { ok: false, error: msg };
    }
  }

  async listZones(ctx: DnsProviderContext): Promise<DnsZoneRemote[]> {
    const creds = asCreds(ctx.credentials);
    await ensureSafeApiBase(ctx.apiBaseUrl);
    const fresh = await ensureFreshToken(ctx, creds);
    const base = ctx.apiBaseUrl || DEFAULT_API_BASE;
    const orgIds = await resolveTargetOrgs(fresh.accessToken, base, ctx.scopeId);
    const out: DnsZoneRemote[] = [];
    for (const orgId of orgIds) {
      let page = 1;
      for (let i = 0; i < 50; i++) {
        const res = await y360Fetch<Y360DomainsResponse>(
          fresh.accessToken, base,
          `/org/${encodeURIComponent(orgId)}/domains?page=${page}&perPage=${PAGE_SIZE_DOMAINS}`,
        );
        for (const d of res.domains || []) {
          out.push({
            // externalId формата `<orgId>:<domain>` — даёт уникальность в рамках
            // провайдера, даже если домены повторяются между орг-ами.
            externalId: `${orgId}:${d.name}`,
            domain: d.name.toLowerCase(),
            status: d.verified ? 'ACTIVE' : 'PENDING_VERIFICATION',
          });
        }
        const totalPages = res.pages || 1;
        if (page >= totalPages) break;
        page++;
      }
    }
    return out;
  }

  async listRecords(ctx: DnsProviderContext, zoneExternalId: string): Promise<DnsRecordRemote[]> {
    const creds = asCreds(ctx.credentials);
    await ensureSafeApiBase(ctx.apiBaseUrl);
    const fresh = await ensureFreshToken(ctx, creds);
    const base = ctx.apiBaseUrl || DEFAULT_API_BASE;
    const { orgId, domain: zoneDomain } = parseZoneExternalId(zoneExternalId, ctx.scopeId);
    const orgIdEnc = encodeURIComponent(orgId);
    const domain = encodeURIComponent(zoneDomain);
    const out: DnsRecordRemote[] = [];
    let page = 1;
    for (let i = 0; i < 100; i++) {
      const res = await y360Fetch<Y360DnsListResponse>(
        fresh.accessToken, base,
        `/org/${orgIdEnc}/domains/${domain}/dns?page=${page}&perPage=${PAGE_SIZE_RECORDS}`,
      );
      for (const rec of res.records || []) out.push(mapRecord(rec, zoneDomain));
      const totalPages = res.pages || 1;
      if (page >= totalPages) break;
      page++;
    }
    return out;
  }

  async createRecord(
    ctx: DnsProviderContext, zoneExternalId: string, record: DnsRecordInput,
  ): Promise<DnsRecordRemote> {
    const creds = asCreds(ctx.credentials);
    await ensureSafeApiBase(ctx.apiBaseUrl);
    const fresh = await ensureFreshToken(ctx, creds);
    const base = ctx.apiBaseUrl || DEFAULT_API_BASE;
    const { orgId, domain: zoneDomain } = parseZoneExternalId(zoneExternalId, ctx.scopeId);
    const orgIdEnc = encodeURIComponent(orgId);
    const domain = encodeURIComponent(zoneDomain);
    const body = buildBody(record);
    const created = await y360Fetch<Y360DnsRecord>(
      fresh.accessToken, base,
      `/org/${orgIdEnc}/domains/${domain}/dns`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    return mapRecord(created, zoneDomain);
  }

  async updateRecord(
    ctx: DnsProviderContext, zoneExternalId: string,
    recordExternalId: string, record: DnsRecordInput,
  ): Promise<DnsRecordRemote> {
    const creds = asCreds(ctx.credentials);
    await ensureSafeApiBase(ctx.apiBaseUrl);
    const fresh = await ensureFreshToken(ctx, creds);
    const base = ctx.apiBaseUrl || DEFAULT_API_BASE;
    const { orgId, domain: zoneDomain } = parseZoneExternalId(zoneExternalId, ctx.scopeId);
    const orgIdEnc = encodeURIComponent(orgId);
    const domain = encodeURIComponent(zoneDomain);
    const recordId = encodeURIComponent(recordExternalId);
    const body = buildBody(record);
    const updated = await y360Fetch<Y360DnsRecord>(
      fresh.accessToken, base,
      `/org/${orgIdEnc}/domains/${domain}/dns/${recordId}`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    if (!updated.recordId) updated.recordId = parseInt(recordExternalId, 10);
    return mapRecord(updated, zoneDomain);
  }

  async deleteRecord(
    ctx: DnsProviderContext, zoneExternalId: string, recordExternalId: string,
  ): Promise<void> {
    const creds = asCreds(ctx.credentials);
    await ensureSafeApiBase(ctx.apiBaseUrl);
    const fresh = await ensureFreshToken(ctx, creds);
    const base = ctx.apiBaseUrl || DEFAULT_API_BASE;
    const { orgId, domain: zoneDomain } = parseZoneExternalId(zoneExternalId, ctx.scopeId);
    const orgIdEnc = encodeURIComponent(orgId);
    const domain = encodeURIComponent(zoneDomain);
    const recordId = encodeURIComponent(recordExternalId);
    try {
      await y360Fetch<unknown>(
        fresh.accessToken, base,
        `/org/${orgIdEnc}/domains/${domain}/dns/${recordId}`,
        { method: 'DELETE' },
      );
    } catch (err) {
      if ((err as Error).message.includes('не найден')) return;
      throw err;
    }
  }
}
