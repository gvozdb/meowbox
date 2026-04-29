import { ApiFetchError, apiFetchJson } from '../../common/http/api-fetch';
import {
  DnsProvider, DnsProviderContext, DnsProviderType, DnsRecordInput,
  DnsRecordRemote, DnsValidationResult, DnsZoneRemote,
} from './dns-provider.interface';

interface CfCredentials {
  apiToken: string;
}

interface CfApiEnvelope<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result: T;
  result_info?: { page: number; per_page: number; total_pages: number; total_count: number };
}

interface CfZone {
  id: string;
  name: string;
  status: string;
  name_servers?: string[];
}

interface CfRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  priority?: number;
  proxied?: boolean;
  comment?: string | null;
  data?: Record<string, unknown>;
}

const BASE_URL = 'https://api.cloudflare.com/client/v4';

function asCreds(creds: unknown): CfCredentials {
  if (!creds || typeof creds !== 'object') throw new Error('Cloudflare credentials missing');
  const c = creds as Record<string, unknown>;
  if (typeof c.apiToken !== 'string' || !c.apiToken) {
    throw new Error('Cloudflare credentials.apiToken required');
  }
  return { apiToken: c.apiToken };
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function relName(recordName: string, zoneName: string): string {
  if (recordName.toLowerCase() === zoneName.toLowerCase()) return '@';
  const suffix = `.${zoneName.toLowerCase()}`;
  if (recordName.toLowerCase().endsWith(suffix)) return recordName.slice(0, -suffix.length);
  return recordName;
}

function fqdn(name: string, zoneName: string): string {
  if (name === '@' || name === '') return zoneName;
  if (name.toLowerCase() === zoneName.toLowerCase()) return zoneName;
  if (name.toLowerCase().endsWith(`.${zoneName.toLowerCase()}`)) return name;
  return `${name}.${zoneName}`;
}

function mapRecord(rec: CfRecord, zoneName: string): DnsRecordRemote {
  return {
    externalId: rec.id,
    type: rec.type,
    name: relName(rec.name, zoneName),
    content: rec.content,
    ttl: rec.ttl,
    priority: rec.priority,
    proxied: rec.proxied,
    comment: rec.comment ?? undefined,
  };
}

// Cloudflare принимает proxied только для A, AAAA, CNAME. Для остальных типов
// поле должно отсутствовать в body, иначе 400 ("proxied is not allowed for ...").
const PROXIABLE_TYPES = new Set(['A', 'AAAA', 'CNAME']);

function buildBody(record: DnsRecordInput, zoneName: string): Record<string, unknown> {
  // CF API для CAA/SRV требует structured `data: {...}` объект, плоский content не работает.
  if (record.type === 'CAA') {
    const m = record.content.trim().match(/^(\d+)\s+(\w+)\s+"?(.+?)"?$/);
    if (!m) {
      throw new Error('CAA content malformed: ожидаемый формат `flags tag value` (например `0 issue "letsencrypt.org"`)');
    }
    const body: Record<string, unknown> = {
      type: 'CAA',
      name: fqdn(record.name, zoneName),
      ttl: record.ttl,
      data: {
        flags: parseInt(m[1], 10),
        tag: m[2],
        value: m[3],
      },
    };
    if (record.comment !== undefined) body.comment = record.comment;
    return body;
  }
  if (record.type === 'SRV') {
    const c = record.content.trim();
    let priority: number;
    let weight: number;
    let port: number;
    let target: string;
    if (record.priority !== undefined) {
      // priority передан отдельно, content = `weight port target`
      const m = c.match(/^(\d+)\s+(\d+)\s+(\S+)$/);
      if (!m) {
        throw new Error('SRV content malformed: ожидаемый формат `weight port target` (priority передаётся отдельно)');
      }
      priority = record.priority;
      weight = parseInt(m[1], 10);
      port = parseInt(m[2], 10);
      target = m[3];
    } else {
      // priority внутри content, формат `priority weight port target`
      const m = c.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)$/);
      if (!m) {
        throw new Error('SRV content malformed: ожидаемый формат `priority weight port target`');
      }
      priority = parseInt(m[1], 10);
      weight = parseInt(m[2], 10);
      port = parseInt(m[3], 10);
      target = m[4];
    }
    const body: Record<string, unknown> = {
      type: 'SRV',
      name: fqdn(record.name, zoneName),
      ttl: record.ttl,
      data: { priority, weight, port, target },
    };
    if (record.comment !== undefined) body.comment = record.comment;
    return body;
  }
  const body: Record<string, unknown> = {
    type: record.type,
    name: fqdn(record.name, zoneName),
    content: record.content,
    ttl: record.ttl,
  };
  if (record.proxied !== undefined && PROXIABLE_TYPES.has(record.type)) {
    body.proxied = record.proxied;
  }
  if (record.priority !== undefined) body.priority = record.priority;
  if (record.comment !== undefined) body.comment = record.comment;
  return body;
}

async function cfFetch<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const url = `${BASE_URL}${path}`;
  try {
    const env = await apiFetchJson<CfApiEnvelope<T>>(url, {
      ...init,
      headers: {
        ...authHeaders(token),
        ...((init.headers as Record<string, string>) || {}),
      },
    });
    if (!env.success) {
      const msg = env.errors?.map((e) => `${e.code}:${e.message}`).join('; ') || 'Cloudflare API error';
      throw new Error(msg);
    }
    return env.result;
  } catch (err) {
    if (err instanceof ApiFetchError) {
      if (err.status === 401 || err.status === 403) throw new Error('Cloudflare auth failed (check API token scope/expiry)');
      if (err.status === 404) throw new Error('Cloudflare resource not found');
      // bodyText не включаем — может содержать токен в редких 4xx-ответах. Логируется через ApiFetchError.
      throw new Error(`Cloudflare API error (HTTP ${err.status})`);
    }
    throw err;
  }
}

// Кэш zone-name по zoneId, чтобы CRUD-методы не делали лишний GET /zones/{id}.
// Не глобальный — у нас вызовы happen в одном scope per-аккаунт; ttl 5 мин достаточен.
const zoneNameCache = new Map<string, { name: string; expiresAt: number }>();
const ZONE_NAME_TTL_MS = 5 * 60 * 1000;

async function getZoneName(token: string, zoneId: string): Promise<string> {
  const cached = zoneNameCache.get(zoneId);
  if (cached && cached.expiresAt > Date.now()) return cached.name;
  const z = await cfFetch<CfZone>(token, `/zones/${encodeURIComponent(zoneId)}`);
  zoneNameCache.set(zoneId, { name: z.name, expiresAt: Date.now() + ZONE_NAME_TTL_MS });
  return z.name;
}

/** Полностью очищает кэш zone-name. Вызывается при удалении провайдера CF. */
export function evictAllCloudflareZoneCache(): void {
  zoneNameCache.clear();
}

export class CloudflareProvider implements DnsProvider {
  readonly type: DnsProviderType = 'CLOUDFLARE';

  async validateCredentials(ctx: DnsProviderContext): Promise<DnsValidationResult> {
    let creds: CfCredentials;
    try { creds = asCreds(ctx.credentials); } catch (e) { return { ok: false, error: (e as Error).message }; }
    try {
      // /user/tokens/verify — endpoint специально для проверки валидности скоупа
      await cfFetch<{ id: string; status: string }>(creds.apiToken, '/user/tokens/verify');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async listZones(ctx: DnsProviderContext): Promise<DnsZoneRemote[]> {
    const creds = asCreds(ctx.credentials);
    const out: DnsZoneRemote[] = [];
    let page = 1;
    const perPage = 50;
    for (let i = 0; i < 50; i++) { // защита от зацикливания (50 страниц * 50 = 2500 зон max)
      const url = `/zones?per_page=${perPage}&page=${page}`;
      const res = await apiFetchJson<CfApiEnvelope<CfZone[]>>(`${BASE_URL}${url}`, {
        headers: authHeaders(creds.apiToken),
      });
      if (!res.success) throw new Error(res.errors?.map((e) => e.message).join('; ') || 'Cloudflare zones error');
      for (const z of res.result) {
        out.push({
          externalId: z.id,
          domain: z.name,
          status: z.status,
          nameservers: z.name_servers,
        });
        // запоминаем имя для дальнейших запросов records
        zoneNameCache.set(z.id, { name: z.name, expiresAt: Date.now() + ZONE_NAME_TTL_MS });
      }
      const info = res.result_info;
      if (!info || info.page >= info.total_pages) break;
      page = info.page + 1;
    }
    return out;
  }

  async listRecords(ctx: DnsProviderContext, zoneExternalId: string): Promise<DnsRecordRemote[]> {
    const creds = asCreds(ctx.credentials);
    const zoneName = await getZoneName(creds.apiToken, zoneExternalId);
    const out: DnsRecordRemote[] = [];
    let page = 1;
    const perPage = 100;
    for (let i = 0; i < 50; i++) {
      const url = `/zones/${encodeURIComponent(zoneExternalId)}/dns_records?per_page=${perPage}&page=${page}`;
      const res = await apiFetchJson<CfApiEnvelope<CfRecord[]>>(`${BASE_URL}${url}`, {
        headers: authHeaders(creds.apiToken),
      });
      if (!res.success) throw new Error(res.errors?.map((e) => e.message).join('; ') || 'Cloudflare records error');
      for (const r of res.result) out.push(mapRecord(r, zoneName));
      const info = res.result_info;
      if (!info || info.page >= info.total_pages) break;
      page = info.page + 1;
    }
    return out;
  }

  async createRecord(ctx: DnsProviderContext, zoneExternalId: string, record: DnsRecordInput): Promise<DnsRecordRemote> {
    const creds = asCreds(ctx.credentials);
    const zoneName = await getZoneName(creds.apiToken, zoneExternalId);
    const body = buildBody(record, zoneName);
    const created = await cfFetch<CfRecord>(creds.apiToken, `/zones/${encodeURIComponent(zoneExternalId)}/dns_records`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return mapRecord(created, zoneName);
  }

  async updateRecord(ctx: DnsProviderContext, zoneExternalId: string, recordExternalId: string, record: DnsRecordInput): Promise<DnsRecordRemote> {
    const creds = asCreds(ctx.credentials);
    const zoneName = await getZoneName(creds.apiToken, zoneExternalId);
    const body = buildBody(record, zoneName);
    const updated = await cfFetch<CfRecord>(
      creds.apiToken,
      `/zones/${encodeURIComponent(zoneExternalId)}/dns_records/${encodeURIComponent(recordExternalId)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    );
    return mapRecord(updated, zoneName);
  }

  async deleteRecord(ctx: DnsProviderContext, zoneExternalId: string, recordExternalId: string): Promise<void> {
    // hint не используется — у Cloudflare recordId уникален per-record.
    const creds = asCreds(ctx.credentials);
    await cfFetch<{ id: string }>(
      creds.apiToken,
      `/zones/${encodeURIComponent(zoneExternalId)}/dns_records/${encodeURIComponent(recordExternalId)}`,
      { method: 'DELETE' },
    );
  }
}
