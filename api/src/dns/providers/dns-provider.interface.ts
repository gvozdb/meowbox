/**
 * Общий контракт для всех DNS-провайдеров. Конкретные реализации:
 *   - CloudflareProvider
 *   - YandexCloudProvider
 *   - VkCloudProvider
 *
 * Креды передаются как `unknown` (валидируются внутри каждого провайдера).
 * Это сделано чтобы не плодить sub-интерфейсы под каждый набор полей.
 */

export type DnsProviderType = 'CLOUDFLARE' | 'YANDEX_CLOUD' | 'VK_CLOUD' | 'YANDEX_360';

export const DNS_PROVIDER_TYPES: readonly DnsProviderType[] = [
  'CLOUDFLARE',
  'YANDEX_CLOUD',
  'VK_CLOUD',
  'YANDEX_360',
] as const;

export interface DnsRecordRemote {
  externalId: string;
  type: string;
  name: string;     // относительный или "@" для apex (без trailing dot)
  content: string;  // string или JSON-stringified для multi-value
  ttl: number;
  priority?: number;
  proxied?: boolean;
  comment?: string;
}

export interface DnsZoneRemote {
  externalId: string;
  domain: string;       // apex без trailing dot
  status?: string;
  nameservers?: string[];
}

export interface DnsRecordInput {
  type: string;
  name: string;     // "@" для apex, "www" и т.п.
  content: string;
  ttl: number;
  priority?: number;
  proxied?: boolean;
  comment?: string;
}

export interface DnsProviderContext {
  credentials: unknown;
  scopeId?: string;
  apiBaseUrl?: string;
  /**
   * Опциональный callback для провайдеров с обновляемыми токенами (Y360 OAuth refresh).
   * Провайдер вызывает его когда обновил access_token через refresh_token, чтобы сервис
   * перезаписал credentialsEnc в БД. Если не передан — refresh работает только in-memory
   * (на текущий запрос), при следующем вызове провайдер опять увидит протухший токен и
   * сделает refresh повторно.
   */
  onCredentialsUpdate?: (creds: unknown) => Promise<void>;
}

export interface DnsValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Подсказка для удаления — у некоторых провайдеров (Yandex Cloud) удаление
 * recordSet требует знать оригинальные ttl + data, чтобы не делать лишний
 * сетевой запрос. Сервис передаёт эти данные из локального БД-кэша.
 */
export interface DnsRecordHint {
  ttl?: number;
  /** Сырое значение записи; для multi-value — JSON-строка массива. */
  content?: string;
}

export interface DnsProvider {
  readonly type: DnsProviderType;
  validateCredentials(ctx: DnsProviderContext): Promise<DnsValidationResult>;
  listZones(ctx: DnsProviderContext): Promise<DnsZoneRemote[]>;
  listRecords(ctx: DnsProviderContext, zoneExternalId: string): Promise<DnsRecordRemote[]>;
  createRecord(ctx: DnsProviderContext, zoneExternalId: string, record: DnsRecordInput): Promise<DnsRecordRemote>;
  updateRecord(ctx: DnsProviderContext, zoneExternalId: string, recordExternalId: string, record: DnsRecordInput): Promise<DnsRecordRemote>;
  deleteRecord(ctx: DnsProviderContext, zoneExternalId: string, recordExternalId: string, hint?: DnsRecordHint): Promise<void>;
}
