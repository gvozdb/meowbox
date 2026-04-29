import * as crypto from 'crypto';
import { ApiFetchError, apiFetchJson, apiFetch } from '../../common/http/api-fetch';
import { assertSafeExternalUrl } from '../../common/http/url-guard';
import {
  DnsProvider, DnsProviderContext, DnsProviderType, DnsRecordHint, DnsRecordInput,
  DnsRecordRemote, DnsValidationResult, DnsZoneRemote,
} from './dns-provider.interface';

/**
 * VK Cloud DNS — построен по OpenStack Designate v2 API. Документация скрыта,
 * URL могут отличаться от публичных. По умолчанию указывает на наиболее
 * правдоподобный публичный endpoint, но юзер может переопределить через
 * apiBaseUrl + (косвенно) через keystone-URL — берётся из catalog'а после auth.
 *
 * Если интеграция упадёт на реальном инстансе — поддержку нужно будет переписать
 * под фактические URL'ы. Внутри сервиса все методы возвращают осмысленные
 * ошибки, чтобы юзер видел актуальный статус из upstream.
 */

interface VkCredentials {
  appCredentialId: string;
  appCredentialSecret: string;
}

interface VkDesignateZone {
  id: string;
  name: string; // FQDN с trailing dot
  status?: string;
  email?: string;
}

interface VkDesignateRecordSet {
  id: string;
  name: string;
  type: string;
  ttl: number;
  records: string[];
  description?: string;
}

const DEFAULT_KEYSTONE_URL = 'https://infra.mail.ru:35357/v3';
const DEFAULT_DNS_BASE = 'https://public-dns.mcs.mail.ru/v2';

interface CachedToken { token: string; expiresAt: number; dnsEndpoint: string }
const tokenCache = new Map<string, CachedToken>();
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

function asCreds(creds: unknown): VkCredentials {
  if (!creds || typeof creds !== 'object') throw new Error('VK Cloud credentials missing');
  const c = creds as Record<string, unknown>;
  if (typeof c.appCredentialId !== 'string' || typeof c.appCredentialSecret !== 'string') {
    throw new Error('credentials.appCredentialId and credentials.appCredentialSecret required');
  }
  return {
    appCredentialId: c.appCredentialId,
    appCredentialSecret: c.appCredentialSecret,
  };
}

function cacheKey(creds: VkCredentials): string {
  // Включаем hash(secret) — при ротации secret старый кэшированный токен не отдастся.
  const sHash = crypto.createHash('sha256').update(creds.appCredentialSecret).digest('hex').slice(0, 16);
  return crypto
    .createHash('sha256')
    .update(`${creds.appCredentialId}:${sHash}`)
    .digest('hex');
}

/** Инвалидирует кэш Keystone-токена. Вызывается при удалении/ротации провайдера. */
export function evictVkTokenCache(creds: unknown): void {
  try {
    const c = asCreds(creds);
    tokenCache.delete(cacheKey(c));
  } catch { /* invalid creds */ }
}

function apexFromName(zoneName: string): string {
  return zoneName.endsWith('.') ? zoneName.slice(0, -1) : zoneName;
}

function fqdnFor(name: string, zoneApex: string): string {
  if (!name || name === '@') return `${zoneApex}.`;
  const stripped = name.endsWith('.') ? name.slice(0, -1) : name;
  // Apex variants: ВВЕРХ ПЕРЕД endsWith('.'), иначе ввод "example.com"
  // даст "example.com.example.com." (баг до фикса).
  if (stripped.toLowerCase() === zoneApex.toLowerCase()) return `${zoneApex}.`;
  if (name.endsWith('.')) return name;
  if (stripped.toLowerCase().endsWith(`.${zoneApex.toLowerCase()}`)) return `${name}.`;
  return `${name}.${zoneApex}.`;
}

function relName(fqdn: string, zoneApex: string): string {
  const fq = fqdn.endsWith('.') ? fqdn.slice(0, -1) : fqdn;
  if (fq === zoneApex) return '@';
  const suffix = `.${zoneApex}`;
  if (fq.endsWith(suffix)) return fq.slice(0, -suffix.length);
  return fq;
}

interface KeystoneCatalogEndpoint { url: string; interface?: string; region?: string }
interface KeystoneCatalogService { type: string; endpoints: KeystoneCatalogEndpoint[] }
interface KeystoneAuthBody { token: { catalog?: KeystoneCatalogService[] } }

/**
 * Запрос Application Credential → Keystone token + поиск DNS-endpoint в catalog.
 * apiBaseUrl override (если указан) — приоритетнее catalog.
 */
async function getToken(ctx: DnsProviderContext): Promise<{ token: string; dnsEndpoint: string }> {
  const creds = asCreds(ctx.credentials);
  const ck = cacheKey(creds);
  const cached = tokenCache.get(ck);
  if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
    return { token: cached.token, dnsEndpoint: ctx.apiBaseUrl || cached.dnsEndpoint };
  }

  // SSRF-guard для admin-controlled apiBaseUrl: блокируем приватные IP / metadata.
  if (ctx.apiBaseUrl) {
    await assertSafeExternalUrl(ctx.apiBaseUrl);
  }

  // Keystone URL не конфигурируется отдельно — VK использует фиксированный.
  const keystoneUrl = `${DEFAULT_KEYSTONE_URL}/auth/tokens`;
  const body = {
    auth: {
      identity: {
        methods: ['application_credential'],
        application_credential: {
          id: creds.appCredentialId,
          secret: creds.appCredentialSecret,
        },
      },
    },
  };
  let res: Response;
  try {
    res = await apiFetch(keystoneUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`VK Cloud Keystone unreachable: ${(err as Error).message}`);
  }
  if (!res.ok) {
    // Жёсткий рecт: НЕ включаем upstream-body в Error.message — он может
    // содержать echo нашего request body с appCredentialSecret. Тело логируется
    // только на сервере (через apiFetch.bodyText в логах исключения), но в
    // юзерское сообщение/lastError/audit улетит только status + generic-описание.
    try { await res.text(); } catch { /* drain */ }
    if (res.status === 401 || res.status === 403) {
      throw new Error('VK Cloud auth failed (проверь appCredentialId/appCredentialSecret)');
    }
    throw new Error(`VK Cloud Keystone error (HTTP ${res.status})`);
  }
  const token = res.headers.get('x-subject-token') || res.headers.get('X-Subject-Token');
  if (!token) throw new Error('VK Cloud: no X-Subject-Token in response');
  let parsed: KeystoneAuthBody;
  try { parsed = (await res.json()) as KeystoneAuthBody; } catch { parsed = { token: {} }; }

  let dnsEndpoint = ctx.apiBaseUrl || DEFAULT_DNS_BASE;
  if (!ctx.apiBaseUrl && parsed.token?.catalog) {
    const dnsSvc = parsed.token.catalog.find((s) => s.type === 'dns');
    const ep = dnsSvc?.endpoints.find((e) => e.interface === 'public') || dnsSvc?.endpoints[0];
    if (ep?.url) {
      // SSRF-guard для catalog endpoint: VK мог вернуть приватный IP в catalog.
      try {
        await assertSafeExternalUrl(ep.url);
        dnsEndpoint = ep.url.replace(/\/+$/, '');
      } catch (err) {
        throw new Error(`VK Cloud catalog returned unsafe DNS endpoint: ${(err as Error).message}`);
      }
    }
  }

  // Берём `expires_at` из самого ответа Keystone, fallback — 12 часов.
  let expiresAt = Date.now() + 12 * 3600 * 1000;
  const tokenExpStr = (parsed.token as { expires_at?: string } | undefined)?.expires_at;
  if (tokenExpStr) {
    const parsedTs = Date.parse(tokenExpStr);
    if (Number.isFinite(parsedTs) && parsedTs > Date.now()) expiresAt = parsedTs;
  }
  tokenCache.set(ck, { token, expiresAt, dnsEndpoint });
  return { token, dnsEndpoint };
}

function authHeaders(token: string): Record<string, string> {
  return { 'X-Auth-Token': token, Accept: 'application/json' };
}

async function vkFetch<T>(token: string, base: string, path: string, init: RequestInit = {}): Promise<T> {
  // Designate v2: PROJECT-id-в-URL обычно не нужен (auth scope в токене).
  const url = path.startsWith('http') ? path : `${base}${path}`;
  try {
    return await apiFetchJson<T>(url, {
      ...init,
      headers: {
        ...authHeaders(token),
        ...((init.headers as Record<string, string>) || {}),
      },
    });
  } catch (err) {
    if (err instanceof ApiFetchError) {
      if (err.status === 401 || err.status === 403) throw new Error('VK Cloud auth failed (token rejected)');
      if (err.status === 404) throw new Error('VK Cloud resource not found');
      // НЕ включаем bodyText в Error.message — может содержать echo нашего request
      // body с секретами. Тело уходит только в server-side log через ApiFetchError.
      throw new Error(`VK Cloud DNS API error (HTTP ${err.status})`);
    }
    throw err;
  }
}

function parseDataValue(type: string, raw: string): { content: string; priority?: number } {
  if (type === 'MX' || type === 'SRV') {
    const m = raw.match(/^(\d+)\s+(.+)$/);
    if (m) return { content: m[2], priority: parseInt(m[1], 10) };
  }
  return { content: raw };
}

function mapRecordSet(rs: VkDesignateRecordSet, zoneApex: string): DnsRecordRemote {
  let content: string;
  let priority: number | undefined;
  if (rs.records.length === 1) {
    const parsed = parseDataValue(rs.type, rs.records[0]);
    content = parsed.content;
    priority = parsed.priority;
  } else {
    content = JSON.stringify(rs.records);
  }
  return {
    externalId: rs.id,
    type: rs.type,
    name: relName(rs.name, zoneApex),
    content,
    ttl: rs.ttl,
    priority,
    comment: rs.description,
  };
}

function recordsFromInput(input: DnsRecordInput): string[] {
  const c = input.content.trim();
  if (c.startsWith('[') && c.endsWith(']')) {
    try {
      const arr = JSON.parse(c);
      if (Array.isArray(arr) && arr.every((v) => typeof v === 'string')) return arr;
    } catch { /* ignore */ }
  }
  if ((input.type === 'MX' || input.type === 'SRV') && input.priority !== undefined && !/^\d+\s/.test(c)) {
    return [`${input.priority} ${c}`];
  }
  return [c];
}

export class VkCloudProvider implements DnsProvider {
  readonly type: DnsProviderType = 'VK_CLOUD';

  async validateCredentials(ctx: DnsProviderContext): Promise<DnsValidationResult> {
    try { asCreds(ctx.credentials); } catch (e) { return { ok: false, error: (e as Error).message }; }
    try {
      const { token, dnsEndpoint } = await getToken(ctx);
      // Пробуем получить список зон с pagesize=1 — самая лёгкая операция
      await vkFetch<unknown>(token, dnsEndpoint, '/zones?limit=1');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async listZones(ctx: DnsProviderContext): Promise<DnsZoneRemote[]> {
    const { token, dnsEndpoint } = await getToken(ctx);
    const out: DnsZoneRemote[] = [];
    let next: string | undefined;
    for (let i = 0; i < 50; i++) {
      const url = next || '/zones?limit=100';
      const res = await vkFetch<{ zones?: VkDesignateZone[]; links?: { next?: string } }>(token, dnsEndpoint, url);
      for (const z of res.zones || []) {
        out.push({
          externalId: z.id,
          domain: apexFromName(z.name),
          status: z.status,
        });
      }
      if (!res.links?.next) break;
      next = res.links.next; // абсолютная ссылка
    }
    return out;
  }

  async listRecords(ctx: DnsProviderContext, zoneExternalId: string): Promise<DnsRecordRemote[]> {
    const { token, dnsEndpoint } = await getToken(ctx);
    const zone = await vkFetch<VkDesignateZone>(token, dnsEndpoint, `/zones/${encodeURIComponent(zoneExternalId)}`);
    const zoneApex = apexFromName(zone.name);
    const out: DnsRecordRemote[] = [];
    let next: string | undefined;
    for (let i = 0; i < 50; i++) {
      const url = next || `/zones/${encodeURIComponent(zoneExternalId)}/recordsets?limit=500`;
      const res = await vkFetch<{ recordsets?: VkDesignateRecordSet[]; links?: { next?: string } }>(
        token, dnsEndpoint, url,
      );
      for (const rs of res.recordsets || []) out.push(mapRecordSet(rs, zoneApex));
      if (!res.links?.next) break;
      next = res.links.next;
    }
    return out;
  }

  async createRecord(ctx: DnsProviderContext, zoneExternalId: string, record: DnsRecordInput): Promise<DnsRecordRemote> {
    const { token, dnsEndpoint } = await getToken(ctx);
    const zone = await vkFetch<VkDesignateZone>(token, dnsEndpoint, `/zones/${encodeURIComponent(zoneExternalId)}`);
    const zoneApex = apexFromName(zone.name);
    const body: Record<string, unknown> = {
      name: fqdnFor(record.name, zoneApex),
      type: record.type,
      ttl: record.ttl,
      records: recordsFromInput(record),
    };
    if (record.comment) body.description = record.comment;
    const created = await vkFetch<VkDesignateRecordSet>(
      token, dnsEndpoint, `/zones/${encodeURIComponent(zoneExternalId)}/recordsets`,
      { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } },
    );
    return mapRecordSet(created, zoneApex);
  }

  async updateRecord(ctx: DnsProviderContext, zoneExternalId: string, recordExternalId: string, record: DnsRecordInput): Promise<DnsRecordRemote> {
    const { token, dnsEndpoint } = await getToken(ctx);
    const zone = await vkFetch<VkDesignateZone>(token, dnsEndpoint, `/zones/${encodeURIComponent(zoneExternalId)}`);
    const zoneApex = apexFromName(zone.name);
    const body: Record<string, unknown> = {
      ttl: record.ttl,
      records: recordsFromInput(record),
    };
    if (record.comment !== undefined) body.description = record.comment;
    const updated = await vkFetch<VkDesignateRecordSet>(
      token, dnsEndpoint,
      `/zones/${encodeURIComponent(zoneExternalId)}/recordsets/${encodeURIComponent(recordExternalId)}`,
      { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } },
    );
    return mapRecordSet(updated, zoneApex);
  }

  async deleteRecord(ctx: DnsProviderContext, zoneExternalId: string, recordExternalId: string): Promise<void> {
    // hint не используется — Designate v2 удаляет recordset по uuid.
    const { token, dnsEndpoint } = await getToken(ctx);
    await vkFetch<unknown>(
      token, dnsEndpoint,
      `/zones/${encodeURIComponent(zoneExternalId)}/recordsets/${encodeURIComponent(recordExternalId)}`,
      { method: 'DELETE' },
    );
  }
}
