import * as crypto from 'crypto';
import { ApiFetchError, apiFetchJson } from '../../common/http/api-fetch';
import { assertSafeExternalUrl } from '../../common/http/url-guard';
import {
  DnsProvider, DnsProviderContext, DnsProviderType, DnsRecordHint, DnsRecordInput,
  DnsRecordRemote, DnsValidationResult, DnsZoneRemote,
} from './dns-provider.interface';

interface YandexServiceAccountKey {
  id: string;                    // key id (kid)
  service_account_id: string;
  private_key: string;           // PEM с -----BEGIN PRIVATE KEY-----
}

interface YandexCredentials {
  serviceAccountKey: YandexServiceAccountKey;
}

interface YcZone {
  id: string;
  folderId: string;
  zone: string; // FQDN с trailing dot, например "example.com."
  status?: string;
}

interface YcRecordSet {
  name: string; // FQDN с trailing dot
  type: string;
  ttl: string | number;
  data: string[];
}

const IAM_TOKEN_URL = 'https://iam.api.cloud.yandex.net/iam/v1/tokens';
const DEFAULT_API_BASE = 'https://dns.api.cloud.yandex.net/dns/v1';

// Кэш IAM токенов: ключ — sha256(privateKey + service_account_id).
// Жизнь токена ~1 час; обновляем за 5 минут до истечения.
interface CachedToken { token: string; expiresAt: number }
const tokenCache = new Map<string, CachedToken>();
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

function asCreds(creds: unknown): YandexCredentials {
  if (!creds || typeof creds !== 'object') throw new Error('Yandex credentials missing');
  const c = creds as Record<string, unknown>;
  const sak = c.serviceAccountKey;
  if (!sak || typeof sak !== 'object') throw new Error('credentials.serviceAccountKey required');
  const k = sak as Record<string, unknown>;
  if (typeof k.id !== 'string' || typeof k.service_account_id !== 'string' || typeof k.private_key !== 'string') {
    throw new Error('serviceAccountKey must contain {id, service_account_id, private_key}');
  }
  return { serviceAccountKey: { id: k.id, service_account_id: k.service_account_id, private_key: k.private_key } };
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function buildJwt(key: YandexServiceAccountKey): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'PS256', typ: 'JWT', kid: key.id };
  const payload = {
    iss: key.service_account_id,
    aud: IAM_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  // PS256 = RSASSA-PSS with SHA-256, mgf1 with SHA-256, salt = hash length (32)
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: key.private_key,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return `${signingInput}.${base64url(signature)}`;
}

function cacheKey(key: YandexServiceAccountKey): string {
  // Включаем hash(private_key) — при ротации ключа (smart rotation с тем же id)
  // старый кэшированный IAM token не отдастся.
  const pkHash = crypto.createHash('sha256').update(key.private_key).digest('hex').slice(0, 16);
  return crypto
    .createHash('sha256')
    .update(`${key.service_account_id}:${key.id}:${pkHash}`)
    .digest('hex');
}

/** Инвалидирует кэш IAM-токена. Вызывается при удалении/ротации провайдера. */
export function evictYandexTokenCache(creds: unknown): void {
  try {
    const c = asCreds(creds);
    tokenCache.delete(cacheKey(c.serviceAccountKey));
  } catch { /* invalid creds — нечего инвалидировать */ }
}

// Кэш URL-ов, прошедших SSRF-guard. Нужен чтобы не делать DNS lookup на каждый
// вызов API провайдера. Инвалидируется при удалении провайдера через
// evictYandexUrlGuardCache(url).
const guardedUrlCache = new Set<string>();

/** Инвалидирует cached SSRF-guard результат для конкретного apiBaseUrl. */
export function evictYandexUrlGuardCache(url?: string | null): void {
  if (!url) return;
  guardedUrlCache.delete(url);
}

async function ensureSafeApiBase(apiBaseUrl?: string): Promise<void> {
  if (!apiBaseUrl) return;
  if (guardedUrlCache.has(apiBaseUrl)) return;
  await assertSafeExternalUrl(apiBaseUrl);
  guardedUrlCache.add(apiBaseUrl);
}

async function getIamToken(creds: YandexCredentials): Promise<string> {
  const ck = cacheKey(creds.serviceAccountKey);
  const cached = tokenCache.get(ck);
  if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
    return cached.token;
  }
  const jwt = buildJwt(creds.serviceAccountKey);
  try {
    const res = await apiFetchJson<{ iamToken: string; expiresAt: string }>(IAM_TOKEN_URL, {
      method: 'POST',
      body: JSON.stringify({ jwt }),
    });
    const expiresAtMs = res.expiresAt ? Date.parse(res.expiresAt) : Date.now() + 3600 * 1000;
    tokenCache.set(ck, { token: res.iamToken, expiresAt: expiresAtMs });
    return res.iamToken;
  } catch (err) {
    if (err instanceof ApiFetchError) {
      // bodyText не включаем в Error.message — JWT может содержать iss=service_account_id,
      // а body может содержать echo для отладочных режимов. Логируем тело через сам ApiFetchError.
      throw new Error(`Yandex IAM token error (HTTP ${err.status})`);
    }
    throw err;
  }
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function apexFromZone(zone: string): string {
  // "example.com." → "example.com"
  return zone.endsWith('.') ? zone.slice(0, -1) : zone;
}

function relName(fqdn: string, zoneApex: string): string {
  const fq = fqdn.endsWith('.') ? fqdn.slice(0, -1) : fqdn;
  if (fq.toLowerCase() === zoneApex.toLowerCase()) return '@';
  const suffix = `.${zoneApex}`;
  if (fq.toLowerCase().endsWith(suffix.toLowerCase())) return fq.slice(0, -suffix.length);
  return fq;
}

function fqdnFor(name: string, zoneApex: string): string {
  // Apex variants: "@" / пусто / точное имя зоны (с/без trailing dot).
  if (!name || name === '@') return `${zoneApex}.`;
  const stripped = name.endsWith('.') ? name.slice(0, -1) : name;
  if (stripped.toLowerCase() === zoneApex.toLowerCase()) return `${zoneApex}.`;
  if (name.endsWith('.')) return name; // уже FQDN с точкой
  if (stripped.toLowerCase().endsWith(`.${zoneApex.toLowerCase()}`)) return `${name}.`;
  return `${name}.${zoneApex}.`;
}

/**
 * Парсит value из Yandex recordset, выделяя priority для MX.
 * Для MX/SRV Yandex кладёт priority как первый токен в строке data.
 * Возвращает {content, priority?}, где content — value БЕЗ priority-префикса.
 */
function parseDataValue(type: string, raw: string): { content: string; priority?: number } {
  if (type === 'MX') {
    const m = raw.match(/^(\d+)\s+(.+)$/);
    if (m) return { content: m[2], priority: parseInt(m[1], 10) };
  }
  // SRV: "priority weight port target" — priority хранится отдельно, остальное в content.
  if (type === 'SRV') {
    const m = raw.match(/^(\d+)\s+(.+)$/);
    if (m) return { content: m[2], priority: parseInt(m[1], 10) };
  }
  return { content: raw };
}

function mapRecordSet(rs: YcRecordSet, zoneApex: string): DnsRecordRemote {
  // Yandex recordset = (name, type, ttl, data[]). У нас одна запись на data-element
  // не получится сделать (provider возвращает recordset как одно целое). Поэтому
  // храним всю data как JSON-массив в content. externalId = "<name>|<type>".
  const ttlNum = typeof rs.ttl === 'string' ? parseInt(rs.ttl, 10) : rs.ttl;
  const name = relName(rs.name, zoneApex);
  let content: string;
  let priority: number | undefined;
  if (rs.data.length === 1) {
    const parsed = parseDataValue(rs.type, rs.data[0]);
    content = parsed.content;
    priority = parsed.priority;
  } else {
    // Multi-value: храним JSON-массив целиком (с priority внутри).
    // priority здесь не имеет смысла — у multi-value MX каждое значение со своим prio.
    content = JSON.stringify(rs.data);
  }
  return {
    externalId: `${rs.name.toLowerCase()}|${rs.type.toUpperCase()}`,
    type: rs.type,
    name,
    content,
    ttl: Number.isFinite(ttlNum) ? ttlNum : 300,
    priority,
  };
}

function dataFromInput(input: DnsRecordInput): string[] {
  // Если content — JSON-array, возвращаем его. Иначе — single value.
  // Для MX/SRV вшиваем priority в content при необходимости.
  const c = input.content.trim();
  if (c.startsWith('[') && c.endsWith(']')) {
    try {
      const arr = JSON.parse(c);
      if (Array.isArray(arr) && arr.every((v) => typeof v === 'string')) return arr;
    } catch { /* ignore — fallthrough */ }
  }
  if ((input.type === 'MX' || input.type === 'SRV') && input.priority !== undefined && !/^\d+\s/.test(c)) {
    return [`${input.priority} ${c}`];
  }
  return [c];
}

async function ycFetch<T>(token: string, base: string, path: string, init: RequestInit = {}): Promise<T> {
  const url = `${base}${path}`;
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
      if (err.status === 401 || err.status === 403) throw new Error('Yandex Cloud auth failed (check service account permissions)');
      if (err.status === 404) throw new Error('Yandex Cloud resource not found');
      // bodyText не включаем в Error.message — escape-cracker для секретов. Логируется через ApiFetchError.
      throw new Error(`Yandex Cloud API error (HTTP ${err.status})`);
    }
    throw err;
  }
}

export class YandexCloudProvider implements DnsProvider {
  readonly type: DnsProviderType = 'YANDEX_CLOUD';

  async validateCredentials(ctx: DnsProviderContext): Promise<DnsValidationResult> {
    let creds: YandexCredentials;
    try { creds = asCreds(ctx.credentials); } catch (e) { return { ok: false, error: (e as Error).message }; }
    if (!ctx.scopeId) return { ok: false, error: 'folderId (scopeId) is required for Yandex Cloud' };
    try {
      await ensureSafeApiBase(ctx.apiBaseUrl);
      // Получаем IAM-токен — это уже валидация подписи и SA. Затем GET zones для проверки прав.
      const token = await getIamToken(creds);
      const base = ctx.apiBaseUrl || DEFAULT_API_BASE;
      await ycFetch<{ dnsZones?: YcZone[]; nextPageToken?: string }>(
        token, base, `/dnsZones?folderId=${encodeURIComponent(ctx.scopeId)}&pageSize=1`,
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async listZones(ctx: DnsProviderContext): Promise<DnsZoneRemote[]> {
    const creds = asCreds(ctx.credentials);
    if (!ctx.scopeId) throw new Error('folderId required');
    await ensureSafeApiBase(ctx.apiBaseUrl);
    const token = await getIamToken(creds);
    const base = ctx.apiBaseUrl || DEFAULT_API_BASE;
    const out: DnsZoneRemote[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < 50; i++) {
      const params = new URLSearchParams({ folderId: ctx.scopeId, pageSize: '100' });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await ycFetch<{ dnsZones?: YcZone[]; nextPageToken?: string }>(
        token, base, `/dnsZones?${params.toString()}`,
      );
      for (const z of res.dnsZones || []) {
        out.push({
          externalId: z.id,
          domain: apexFromZone(z.zone),
          status: z.status,
        });
      }
      if (!res.nextPageToken) break;
      pageToken = res.nextPageToken;
    }
    return out;
  }

  async listRecords(ctx: DnsProviderContext, zoneExternalId: string): Promise<DnsRecordRemote[]> {
    const creds = asCreds(ctx.credentials);
    await ensureSafeApiBase(ctx.apiBaseUrl);
    const token = await getIamToken(creds);
    const base = ctx.apiBaseUrl || DEFAULT_API_BASE;
    // Получаем зону — нам нужен её apex для нормализации имён
    const zone = await ycFetch<YcZone>(token, base, `/dnsZones/${encodeURIComponent(zoneExternalId)}`);
    const zoneApex = apexFromZone(zone.zone);
    const out: DnsRecordRemote[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < 50; i++) {
      const params = new URLSearchParams({ pageSize: '500' });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await ycFetch<{ recordSets?: YcRecordSet[]; nextPageToken?: string }>(
        token, base, `/dnsZones/${encodeURIComponent(zoneExternalId)}/recordSets?${params.toString()}`,
      );
      for (const rs of res.recordSets || []) out.push(mapRecordSet(rs, zoneApex));
      if (!res.nextPageToken) break;
      pageToken = res.nextPageToken;
    }
    return out;
  }

  async createRecord(ctx: DnsProviderContext, zoneExternalId: string, record: DnsRecordInput): Promise<DnsRecordRemote> {
    // Создание = replacement (если recordset уже есть — заменим целиком).
    // Это корректное поведение, т.к. у нас 1 запись в UI = 1 recordset (FQDN+type).
    return this.upsertRecord(ctx, zoneExternalId, record, 'replacements');
  }

  async updateRecord(ctx: DnsProviderContext, zoneExternalId: string, _recordExternalId: string, record: DnsRecordInput): Promise<DnsRecordRemote> {
    // Update — обязательно `replacements`. Использовать `merges` нельзя:
    // Yandex API при `merges` ДОБАВЛЯЕТ новые data к существующим, не заменяя.
    return this.upsertRecord(ctx, zoneExternalId, record, 'replacements');
  }

  private async upsertRecord(
    ctx: DnsProviderContext,
    zoneExternalId: string,
    record: DnsRecordInput,
    op: 'replacements' | 'merges',
  ): Promise<DnsRecordRemote> {
    const creds = asCreds(ctx.credentials);
    await ensureSafeApiBase(ctx.apiBaseUrl);
    const token = await getIamToken(creds);
    const base = ctx.apiBaseUrl || DEFAULT_API_BASE;
    const zone = await ycFetch<YcZone>(token, base, `/dnsZones/${encodeURIComponent(zoneExternalId)}`);
    const zoneApex = apexFromZone(zone.zone);
    const fq = fqdnFor(record.name, zoneApex);
    const data = dataFromInput(record);
    const body = {
      [op]: [{
        name: fq,
        type: record.type,
        ttl: record.ttl,
        data,
      }],
    };
    await ycFetch<unknown>(
      token, base, `/dnsZones/${encodeURIComponent(zoneExternalId)}:upsertRecordSets`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    return {
      externalId: `${fq.toLowerCase()}|${record.type.toUpperCase()}`,
      type: record.type,
      name: relName(fq, zoneApex),
      content: data.length === 1 ? data[0] : JSON.stringify(data),
      ttl: record.ttl,
    };
  }

  async deleteRecord(
    ctx: DnsProviderContext,
    zoneExternalId: string,
    recordExternalId: string,
    hint?: DnsRecordHint,
  ): Promise<void> {
    const creds = asCreds(ctx.credentials);
    await ensureSafeApiBase(ctx.apiBaseUrl);
    const token = await getIamToken(creds);
    const base = ctx.apiBaseUrl || DEFAULT_API_BASE;
    // externalId = "FQDN.|TYPE" (FQDN с trailing dot)
    const [fqName, type] = recordExternalId.split('|');
    if (!fqName || !type) throw new Error('Invalid Yandex record id');

    // Yandex API требует {name, type, ttl, data[]} для deletion. ttl и data
    // берём из локального hint (передаётся сервисом из БД-кэша) — это убирает
    // лишний раунд-трип и устраняет проблему пагинации recordSets.
    let ttl = 300;
    let data: string[] = [];
    if (hint) {
      if (typeof hint.ttl === 'number' && Number.isFinite(hint.ttl)) ttl = hint.ttl;
      if (typeof hint.content === 'string' && hint.content.length) {
        const trimmed = hint.content.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) data = parsed;
          } catch { /* fallthrough */ }
        }
        if (!data.length) data = [trimmed];
      }
    }

    // Если hint пустой (например, hint потерян) — fallback: подтянем recordSet
    // из API через filter по name. Но Yandex API не поддерживает фильтр в URL —
    // придётся пагинировать. Делаем это только в крайнем случае.
    if (!data.length) {
      data = await this.fetchRecordSetData(token, base, zoneExternalId, fqName, type);
      if (!data.length) return; // уже удалено — идемпотентно
    }

    const body = {
      deletions: [{ name: fqName, type, ttl, data }],
    };
    await ycFetch<unknown>(
      token, base, `/dnsZones/${encodeURIComponent(zoneExternalId)}:upsertRecordSets`,
      { method: 'POST', body: JSON.stringify(body) },
    );
  }

  /**
   * Fallback для deleteRecord без hint — пагинирует все recordSets зоны.
   * Используется только когда сервис не передал ttl/content (дрейф БД).
   */
  private async fetchRecordSetData(
    token: string, base: string, zoneId: string, name: string, type: string,
  ): Promise<string[]> {
    let pageToken: string | undefined;
    for (let page = 0; page < 200; page++) {
      const params = new URLSearchParams({ pageSize: '500' });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await ycFetch<{ recordSets?: YcRecordSet[]; nextPageToken?: string }>(
        token, base, `/dnsZones/${encodeURIComponent(zoneId)}/recordSets?${params.toString()}`,
      );
      const found = (res.recordSets || []).find(
        (rs) => rs.name.toLowerCase() === name.toLowerCase() && rs.type.toUpperCase() === type.toUpperCase(),
      );
      if (found) return found.data;
      if (!res.nextPageToken) return [];
      pageToken = res.nextPageToken;
    }
    return [];
  }
}
