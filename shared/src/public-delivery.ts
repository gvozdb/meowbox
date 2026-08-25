import type { FederationReasonCode } from './federation';
import { FEDERATION_REASON_CODES } from './federation';
import {
  isContractRecord,
  requireBoolean,
  requireEnum,
  requireExactKeys,
  requireInteger,
  requireIsoDate,
  requireString,
  requireUniqueStrings,
} from './contract-validation';

export const PUBLIC_DELIVERY_KINDS = [
  'PublicEndpoint',
  'AppHandoff',
  'TransferSession',
  'ExternalProvider',
  'AuthenticatedProxyResult',
] as const;
export type PublicDeliveryKind = (typeof PUBLIC_DELIVERY_KINDS)[number];

export const PUBLIC_DELIVERY_PURPOSES = [
  'VPN_SUBSCRIPTION',
  'DEPLOY_WEBHOOK',
  'ADMINER',
  'MANTICORE',
  'MODX_LOGIN',
  'DOWNLOAD',
  'UPLOAD',
  'AUTHENTICATED_ACTION',
] as const;
export type PublicDeliveryPurpose = (typeof PUBLIC_DELIVERY_PURPOSES)[number];

export interface DeliveryResourceBinding {
  kind: string;
  id: string;
}

export interface PublicDeliveryBase {
  kind: PublicDeliveryKind;
  purpose: PublicDeliveryPurpose;
  targetInstallationId: string;
  resource: DeliveryResourceBinding;
  method: 'GET' | 'HEAD' | 'POST' | 'PUT';
  allowedHeaders: readonly string[];
  cachePolicy: 'NO_STORE';
  referrerPolicy: 'NO_REFERRER';
  expiresAt: string | null;
  browserReachabilityRequired: boolean;
  rangeSupported: boolean;
  resumeSupported: boolean;
  fallbackReason: FederationReasonCode | null;
}

export interface PublicEndpointDelivery extends PublicDeliveryBase {
  kind: 'PublicEndpoint';
  url: string;
  reusable: true;
}

export interface AppHandoffDelivery extends PublicDeliveryBase {
  kind: 'AppHandoff';
  url: string;
  oneTime: true;
}

export interface TransferSessionDelivery extends PublicDeliveryBase {
  kind: 'TransferSession';
  url: string;
  reusable: boolean;
  transferMode: 'GENERATED_STREAM' | 'STAGED_ARTIFACT';
  contentLength: number | null;
  sha256: string | null;
  leaseId: string;
}

export interface ExternalProviderDelivery extends PublicDeliveryBase {
  kind: 'ExternalProvider';
  url: string;
  reusable: true;
  provider: 'S3';
}

export interface AuthenticatedProxyResultDelivery extends PublicDeliveryBase {
  kind: 'AuthenticatedProxyResult';
  actionId: string;
  requestId: string;
}

export type PublicDelivery =
  | PublicEndpointDelivery
  | AppHandoffDelivery
  | TransferSessionDelivery
  | ExternalProviderDelivery
  | AuthenticatedProxyResultDelivery;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTION_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9_-]+)+$/;
const HEADER = /^[a-z0-9-]+$/;
const RESOURCE_KIND = /^[A-Z][A-Z0-9_]{1,63}$/;
const RESOURCE_ID = /^[A-Za-z0-9._:-]{1,256}$/;

function requireDeliveryUrl(value: unknown, label: string): string {
  const raw = requireString(value, label, { max: 4096, pattern: /^[\x21-\x7e]+$/ });
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error(`${label} must use HTTPS without credentials`);
  }
  return raw;
}

function validateBase(value: Record<string, unknown>): void {
  requireEnum(value.kind, PUBLIC_DELIVERY_KINDS, 'delivery.kind');
  requireEnum(value.purpose, PUBLIC_DELIVERY_PURPOSES, 'delivery.purpose');
  requireString(value.targetInstallationId, 'delivery.targetInstallationId', { pattern: UUID });
  if (!isContractRecord(value.resource)) throw new Error('delivery.resource is invalid');
  requireExactKeys(value.resource, ['kind', 'id'], [], 'delivery.resource');
  requireString(value.resource.kind, 'delivery.resource.kind', { pattern: RESOURCE_KIND });
  requireString(value.resource.id, 'delivery.resource.id', { pattern: RESOURCE_ID });
  requireEnum(value.method, ['GET', 'HEAD', 'POST', 'PUT'] as const, 'delivery.method');
  requireUniqueStrings(value.allowedHeaders, 'delivery.allowedHeaders', {
    maxItems: 16,
    maxLength: 128,
    pattern: HEADER,
  });
  if (value.cachePolicy !== 'NO_STORE' || value.referrerPolicy !== 'NO_REFERRER') {
    throw new Error('delivery cache/referrer policy is invalid');
  }
  if (value.expiresAt !== null) requireIsoDate(value.expiresAt, 'delivery.expiresAt');
  requireBoolean(value.browserReachabilityRequired, 'delivery.browserReachabilityRequired');
  requireBoolean(value.rangeSupported, 'delivery.rangeSupported');
  requireBoolean(value.resumeSupported, 'delivery.resumeSupported');
  if (value.fallbackReason !== null) {
    requireEnum(value.fallbackReason, FEDERATION_REASON_CODES, 'delivery.fallbackReason');
  }
}

const BASE_KEYS = [
  'kind', 'purpose', 'targetInstallationId', 'resource', 'method', 'allowedHeaders',
  'cachePolicy', 'referrerPolicy', 'expiresAt', 'browserReachabilityRequired',
  'rangeSupported', 'resumeSupported', 'fallbackReason',
] as const;

export function validatePublicDelivery(value: unknown): PublicDelivery {
  if (!isContractRecord(value)) throw new Error('PublicDelivery is invalid');
  validateBase(value);
  switch (value.kind) {
    case 'PublicEndpoint':
      requireExactKeys(value, [...BASE_KEYS, 'url', 'reusable'], [], 'delivery');
      requireDeliveryUrl(value.url, 'delivery.url');
      if (value.reusable !== true) throw new Error('delivery.reusable must be true');
      break;
    case 'AppHandoff':
      requireExactKeys(value, [...BASE_KEYS, 'url', 'oneTime'], [], 'delivery');
      requireDeliveryUrl(value.url, 'delivery.url');
      if (value.oneTime !== true || value.expiresAt === null) {
        throw new Error('AppHandoff must be one-time and expiring');
      }
      if (value.rangeSupported || value.resumeSupported) {
        throw new Error('AppHandoff cannot advertise range or resume');
      }
      break;
    case 'TransferSession': {
      requireExactKeys(value, [
        ...BASE_KEYS, 'url', 'reusable', 'transferMode', 'contentLength', 'sha256', 'leaseId',
      ], [], 'delivery');
      requireDeliveryUrl(value.url, 'delivery.url');
      requireBoolean(value.reusable, 'delivery.reusable');
      requireEnum(value.transferMode, ['GENERATED_STREAM', 'STAGED_ARTIFACT'] as const, 'delivery.transferMode');
      requireString(value.leaseId, 'delivery.leaseId', { pattern: UUID });
      if (value.contentLength !== null) requireInteger(value.contentLength, 'delivery.contentLength', 0);
      if (value.sha256 !== null) requireString(value.sha256, 'delivery.sha256', { pattern: /^[0-9a-f]{64}$/ });
      if (value.purpose === 'UPLOAD') {
        if (
          value.method !== 'PUT' ||
          value.transferMode !== 'STAGED_ARTIFACT' ||
          value.reusable !== false ||
          value.contentLength === null ||
          value.sha256 !== null ||
          value.rangeSupported ||
          value.resumeSupported
        ) {
          throw new Error('Upload session requires one-shot staged PUT with declared length');
        }
      } else if (value.purpose !== 'DOWNLOAD') {
        throw new Error('TransferSession purpose is invalid');
      } else if (value.transferMode === 'GENERATED_STREAM') {
        if (
          value.reusable || value.contentLength !== null || value.sha256 !== null ||
          value.rangeSupported || value.resumeSupported
        ) {
          throw new Error('Generated stream cannot advertise length, checksum, range, or resume');
        }
      } else if (
        !value.reusable ||
        value.contentLength === null ||
        value.sha256 === null ||
        !value.rangeSupported ||
        !value.resumeSupported
      ) {
        throw new Error('Staged artifact requires length, checksum, range, and resume');
      }
      break;
    }
    case 'ExternalProvider':
      requireExactKeys(value, [...BASE_KEYS, 'url', 'reusable', 'provider'], [], 'delivery');
      requireDeliveryUrl(value.url, 'delivery.url');
      if (value.provider !== 'S3' || value.reusable !== true) {
        throw new Error('delivery external provider contract is invalid');
      }
      break;
    case 'AuthenticatedProxyResult':
      requireExactKeys(value, [...BASE_KEYS, 'actionId', 'requestId'], [], 'delivery');
      requireString(value.actionId, 'delivery.actionId', { pattern: ACTION_ID });
      requireString(value.requestId, 'delivery.requestId', { pattern: UUID });
      if (value.browserReachabilityRequired || value.rangeSupported || value.resumeSupported) {
        throw new Error('Authenticated proxy result has no direct browser transport');
      }
      break;
    default:
      throw new Error('delivery.kind is invalid');
  }
  return value as unknown as PublicDelivery;
}
