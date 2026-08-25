import {
  isContractRecord,
  requireBoolean,
  requireEnum,
  requireExactKeys,
  requireInteger,
  requireIsoDate,
  requireString,
} from './contract-validation';

export const FEDERATED_WEBHOOK_PROVIDERS = ['GITHUB', 'GITEA'] as const;
export type FederatedWebhookProvider = (typeof FEDERATED_WEBHOOK_PROVIDERS)[number];

export const FEDERATED_WEBHOOK_MAX_RAW_BYTES = 64 * 1024;
export const FEDERATED_WEBHOOK_MAX_ENCODED_BYTES = Math.ceil(
  FEDERATED_WEBHOOK_MAX_RAW_BYTES * 4 / 3,
);

export interface FederatedWebhookDelivery {
  schemaVersion: 1;
  deliveryId: string;
  routeId: string;
  targetInstallationId: string;
  siteId: string;
  domainId: string;
  domain: string;
  provider: FederatedWebhookProvider;
  providerDeliveryId: string;
  event: 'push';
  receivedAt: string;
  rawBodyBase64: string;
  rawBodySha256: string;
  providerSignature: string;
}

export interface FederatedWebhookDeliveryResult {
  schemaVersion: 1;
  deliveryId: string;
  status: 'DELIVERED' | 'IGNORED';
  deployId: string | null;
  duplicate: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/;
const DELIVERY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SIGNATURE = /^(?:sha256=)?[0-9a-f]{64}$/;

export function validateFederatedWebhookDelivery(
  value: unknown,
): FederatedWebhookDelivery {
  if (!isContractRecord(value)) throw new Error('FederatedWebhookDelivery is invalid');
  requireExactKeys(value, [
    'schemaVersion', 'deliveryId', 'routeId', 'targetInstallationId', 'siteId',
    'domainId', 'domain', 'provider', 'providerDeliveryId', 'event', 'receivedAt',
    'rawBodyBase64', 'rawBodySha256', 'providerSignature',
  ], [], 'webhookDelivery');
  if (value.schemaVersion !== 1) throw new Error('webhookDelivery.schemaVersion is invalid');
  requireString(value.deliveryId, 'webhookDelivery.deliveryId', { pattern: UUID });
  requireString(value.routeId, 'webhookDelivery.routeId', { pattern: UUID });
  requireString(value.targetInstallationId, 'webhookDelivery.targetInstallationId', { pattern: UUID });
  requireString(value.siteId, 'webhookDelivery.siteId', { pattern: UUID });
  requireString(value.domainId, 'webhookDelivery.domainId', { pattern: UUID });
  requireString(value.domain, 'webhookDelivery.domain', { max: 253, pattern: DOMAIN });
  requireEnum(value.provider, FEDERATED_WEBHOOK_PROVIDERS, 'webhookDelivery.provider');
  requireString(value.providerDeliveryId, 'webhookDelivery.providerDeliveryId', {
    max: 128,
    pattern: DELIVERY_ID,
  });
  if (value.event !== 'push') throw new Error('webhookDelivery.event is invalid');
  requireIsoDate(value.receivedAt, 'webhookDelivery.receivedAt');
  requireString(value.rawBodyBase64, 'webhookDelivery.rawBodyBase64', {
    max: FEDERATED_WEBHOOK_MAX_ENCODED_BYTES,
    pattern: BASE64URL,
  });
  requireString(value.rawBodySha256, 'webhookDelivery.rawBodySha256', { pattern: SHA256 });
  requireString(value.providerSignature, 'webhookDelivery.providerSignature', {
    max: 71,
    pattern: SIGNATURE,
  });
  return value as unknown as FederatedWebhookDelivery;
}

export function validateFederatedWebhookDeliveryResult(
  value: unknown,
): FederatedWebhookDeliveryResult {
  if (!isContractRecord(value)) throw new Error('FederatedWebhookDeliveryResult is invalid');
  requireExactKeys(value, [
    'schemaVersion', 'deliveryId', 'status', 'deployId', 'duplicate',
  ], [], 'webhookDeliveryResult');
  if (value.schemaVersion !== 1) throw new Error('webhookDeliveryResult.schemaVersion is invalid');
  requireString(value.deliveryId, 'webhookDeliveryResult.deliveryId', { pattern: UUID });
  requireEnum(value.status, ['DELIVERED', 'IGNORED'] as const, 'webhookDeliveryResult.status');
  if (value.deployId !== null) {
    requireString(value.deployId, 'webhookDeliveryResult.deployId', { pattern: UUID });
  }
  requireBoolean(value.duplicate, 'webhookDeliveryResult.duplicate');
  return value as unknown as FederatedWebhookDeliveryResult;
}

export function assertFederatedWebhookRawLength(encoded: string): number {
  const whole = Math.floor(encoded.length / 4) * 3;
  const remainder = encoded.length % 4;
  const bytes = whole + (remainder === 0 ? 0 : remainder - 1);
  requireInteger(bytes, 'webhookDelivery.rawBodyBytes', 1, FEDERATED_WEBHOOK_MAX_RAW_BYTES);
  return bytes;
}
