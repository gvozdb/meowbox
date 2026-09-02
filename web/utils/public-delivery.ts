import type {
  AppHandoffDelivery,
  ExternalProviderDelivery,
  PublicEndpointDelivery,
  PublicDeliveryPurpose,
  TransferSessionDelivery,
} from '@meowbox/shared';
import { createIdempotencyKey } from './idempotency-key';

const DIRECT_PROBE_TIMEOUT_MS = 5_000;
export type VpnSubscriptionDelivery = PublicEndpointDelivery;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESOURCE_KIND = /^[A-Z][A-Z0-9_]{1,63}$/;
const RESOURCE_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const APP_HANDOFF_KEYS = [
  'allowedHeaders', 'browserReachabilityRequired', 'cachePolicy', 'expiresAt',
  'fallbackReason', 'kind', 'method', 'oneTime', 'purpose', 'rangeSupported',
  'referrerPolicy', 'resource', 'resumeSupported', 'targetInstallationId', 'url',
].sort();
const TRANSFER_SESSION_KEYS = [
  'allowedHeaders', 'browserReachabilityRequired', 'cachePolicy', 'contentLength',
  'expiresAt', 'fallbackReason', 'kind', 'leaseId', 'method', 'purpose',
  'rangeSupported', 'referrerPolicy', 'resource', 'resumeSupported', 'reusable', 'sha256',
  'targetInstallationId', 'transferMode', 'url',
].sort();
const EXTERNAL_PROVIDER_KEYS = [
  'allowedHeaders', 'browserReachabilityRequired', 'cachePolicy', 'expiresAt',
  'fallbackReason', 'kind', 'method', 'provider', 'purpose', 'rangeSupported',
  'referrerPolicy', 'resource', 'resumeSupported', 'reusable', 'targetInstallationId', 'url',
].sort();
const PUBLIC_ENDPOINT_KEYS = [
  'allowedHeaders', 'browserReachabilityRequired', 'cachePolicy', 'expiresAt',
  'fallbackReason', 'kind', 'method', 'purpose', 'rangeSupported',
  'referrerPolicy', 'resource', 'resumeSupported', 'reusable', 'targetInstallationId', 'url',
].sort();

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join('\0') === expected.join('\0');
}

function validResource(value: unknown, expectedKind?: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const resource = value as Record<string, unknown>;
  return (
    Object.keys(resource).sort().join('\0') === 'id\0kind' &&
    typeof resource.kind === 'string' && RESOURCE_KIND.test(resource.kind) &&
    (!expectedKind || resource.kind === expectedKind) &&
    typeof resource.id === 'string' && RESOURCE_ID.test(resource.id)
  );
}

function validDownloadDeliveryBase(value: Record<string, unknown>, expectedResourceKind?: string): boolean {
  return (
    value.purpose === 'DOWNLOAD' &&
    typeof value.targetInstallationId === 'string' && UUID.test(value.targetInstallationId) &&
    validResource(value.resource, expectedResourceKind) &&
    value.method === 'GET' &&
    Array.isArray(value.allowedHeaders) &&
    value.allowedHeaders.every((header) => typeof header === 'string' && /^[a-z0-9-]+$/.test(header)) &&
    new Set(value.allowedHeaders).size === value.allowedHeaders.length &&
    value.cachePolicy === 'NO_STORE' &&
    value.referrerPolicy === 'NO_REFERRER' &&
    typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt)) &&
    Date.parse(value.expiresAt) > Date.now() &&
    value.fallbackReason === null
  );
}

function safeHttpsUrl(raw: unknown): URL {
  if (typeof raw !== 'string' || raw.length > 4096 || !/^[\x21-\x7e]+$/.test(raw)) {
    throw new Error('Сервер вернул неверный URL скачивания');
  }
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Сервер вернул неверный URL скачивания'); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Сервер вернул небезопасный URL скачивания');
  }
  return url;
}

export function validateVpnSubscriptionDelivery(raw: unknown): PublicEndpointDelivery {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Master вернул неверный контракт VPN subscription');
  }
  const value = raw as Record<string, unknown>;
  if (
    !hasExactKeys(value, PUBLIC_ENDPOINT_KEYS) ||
    value.kind !== 'PublicEndpoint' ||
    value.purpose !== 'VPN_SUBSCRIPTION' ||
    typeof value.targetInstallationId !== 'string' || !UUID.test(value.targetInstallationId) ||
    !validResource(value.resource, 'VPN_SUBSCRIPTION') ||
    value.method !== 'GET' ||
    !Array.isArray(value.allowedHeaders) || value.allowedHeaders.length !== 0 ||
    value.cachePolicy !== 'NO_STORE' ||
    value.referrerPolicy !== 'NO_REFERRER' ||
    value.expiresAt !== null ||
    value.browserReachabilityRequired !== false ||
    value.rangeSupported !== false ||
    value.resumeSupported !== false ||
    value.fallbackReason !== null ||
    value.reusable !== true
  ) throw new Error('Master вернул неверный контракт VPN subscription');
  const url = safeHttpsUrl(value.url);
  if (
    url.search ||
    url.hash ||
    !/^\/api\/public\/v1\/vpn\/subscriptions\/[A-Za-z0-9_-]{43}$/.test(url.pathname)
  ) throw new Error('Master вернул небезопасный URL VPN subscription');
  return value as unknown as PublicEndpointDelivery;
}

function validateAppHandoffDelivery(raw: unknown): AppHandoffDelivery {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Сервер вернул неверный контракт handoff');
  }
  const value = raw as Record<string, unknown>;
  if (!hasExactKeys(value, APP_HANDOFF_KEYS)) {
    throw new Error('Сервер вернул неверный контракт handoff');
  }
  const resource = value.resource as Record<string, unknown> | null;
  if (
    value.kind !== 'AppHandoff' ||
    !['ADMINER', 'MANTICORE', 'MODX_LOGIN'].includes(String(value.purpose)) ||
    typeof value.targetInstallationId !== 'string' || !UUID.test(value.targetInstallationId) ||
    !resource || Array.isArray(resource) ||
    Object.keys(resource).sort().join('\0') !== 'id\0kind' ||
    typeof resource.kind !== 'string' || !RESOURCE_KIND.test(resource.kind) ||
    typeof resource.id !== 'string' || !RESOURCE_ID.test(resource.id) ||
    value.method !== 'GET' ||
    !Array.isArray(value.allowedHeaders) || value.allowedHeaders.length !== 0 ||
    value.cachePolicy !== 'NO_STORE' ||
    value.referrerPolicy !== 'NO_REFERRER' ||
    typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) ||
    value.browserReachabilityRequired !== true ||
    value.rangeSupported !== false ||
    value.resumeSupported !== false ||
    value.fallbackReason !== null ||
    value.oneTime !== true ||
    typeof value.url !== 'string'
  ) throw new Error('Сервер вернул неверный контракт handoff');
  let url: URL;
  try { url = new URL(value.url); } catch { throw new Error('Сервер вернул неверный URL handoff'); }
  const adminer = value.purpose === 'ADMINER' || value.purpose === 'MANTICORE';
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search !== '' ||
    (adminer
      ? url.pathname !== '/adminer/' ||
        !/^#handoff=[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/i.test(url.hash)
      : url.pathname !== '/api/public/v1/modx/login' ||
        !/^#handoff=[A-Za-z0-9_-]{43}$/.test(url.hash))
  ) {
    throw new Error('Сервер вернул небезопасный URL handoff');
  }
  return value as unknown as AppHandoffDelivery;
}

export function publicDeliveryIdempotencyKey(
  purpose: Extract<
    PublicDeliveryPurpose,
    'ADMINER' | 'MANTICORE' | 'MODX_LOGIN' | 'DOWNLOAD'
  >,
): string {
  return createIdempotencyKey(`public-delivery-${purpose.toLowerCase()}`);
}

function validateTransferSessionDelivery(
  raw: unknown,
  expectedResourceKind: string,
): TransferSessionDelivery {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Сервер вернул неверный контракт скачивания');
  }
  const value = raw as Record<string, unknown>;
  if (
    !hasExactKeys(value, TRANSFER_SESSION_KEYS) ||
    value.kind !== 'TransferSession' ||
    !validDownloadDeliveryBase(value, expectedResourceKind) ||
    value.browserReachabilityRequired !== true ||
    typeof value.leaseId !== 'string' || !UUID.test(value.leaseId)
  ) throw new Error('Сервер вернул неверный контракт скачивания');

  if (value.transferMode === 'GENERATED_STREAM') {
    if (
      value.contentLength !== null || value.sha256 !== null ||
      value.rangeSupported !== false || value.resumeSupported !== false ||
      value.reusable !== false ||
      (value.allowedHeaders as unknown[]).length !== 0
    ) throw new Error('Сервер ложно объявил live stream возобновляемым');
  } else if (value.transferMode === 'STAGED_ARTIFACT') {
    if (
      !Number.isSafeInteger(value.contentLength) || Number(value.contentLength) < 0 ||
      typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256) ||
      value.rangeSupported !== true || value.resumeSupported !== true ||
      value.reusable !== true ||
      !(value.allowedHeaders as unknown[]).every((header) => ['range', 'if-range'].includes(String(header)))
    ) throw new Error('Сервер вернул неверный контракт артефакта');
  } else {
    throw new Error('Сервер вернул неизвестный режим скачивания');
  }

  const url = safeHttpsUrl(value.url);
  if (
    url.hash ||
    !/^\/api\/public\/v1\/transfers\/[0-9a-f-]{36}\/download$/i.test(url.pathname) ||
    !/^\?secret=[A-Za-z0-9_-]{43}$/.test(url.search)
  ) throw new Error('Сервер вернул небезопасный URL transfer session');
  return value as unknown as TransferSessionDelivery;
}

function validateExternalProviderDelivery(
  raw: unknown,
  expectedResourceKind: string,
): ExternalProviderDelivery {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Сервер вернул неверный контракт внешнего скачивания');
  }
  const value = raw as Record<string, unknown>;
  if (
    !hasExactKeys(value, EXTERNAL_PROVIDER_KEYS) ||
    value.kind !== 'ExternalProvider' ||
    !validDownloadDeliveryBase(value, expectedResourceKind) ||
    value.provider !== 'S3' ||
    value.reusable !== true ||
    value.browserReachabilityRequired !== false ||
    value.rangeSupported !== true ||
    value.resumeSupported !== true ||
    (value.allowedHeaders as unknown[]).length !== 0
  ) throw new Error('Сервер вернул неверный контракт внешнего скачивания');
  const url = safeHttpsUrl(value.url);
  if (url.hash) throw new Error('Сервер вернул небезопасный URL внешнего скачивания');
  return value as unknown as ExternalProviderDelivery;
}

export function validateTransferUploadDelivery(
  raw: unknown,
  expectedResourceKind: string,
  expectedResourceId: string,
  expectedContentLength: number,
): TransferSessionDelivery {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Сервер вернул неверный контракт загрузки');
  }
  const value = raw as Record<string, unknown>;
  const resource = value.resource as Record<string, unknown> | undefined;
  if (
    !hasExactKeys(value, TRANSFER_SESSION_KEYS) ||
    value.kind !== 'TransferSession' ||
    value.purpose !== 'UPLOAD' ||
    typeof value.targetInstallationId !== 'string' || !UUID.test(value.targetInstallationId) ||
    !validResource(resource, expectedResourceKind) || resource?.id !== expectedResourceId ||
    value.method !== 'PUT' ||
    !Array.isArray(value.allowedHeaders) ||
    value.allowedHeaders.length !== 1 || value.allowedHeaders[0] !== 'content-type' ||
    value.cachePolicy !== 'NO_STORE' || value.referrerPolicy !== 'NO_REFERRER' ||
    typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) <= Date.now() ||
    value.browserReachabilityRequired !== true || value.fallbackReason !== null ||
    value.transferMode !== 'STAGED_ARTIFACT' || value.reusable !== false ||
    value.rangeSupported !== false || value.resumeSupported !== false ||
    value.contentLength !== expectedContentLength || value.sha256 !== null ||
    typeof value.leaseId !== 'string' || !UUID.test(value.leaseId)
  ) throw new Error('Сервер вернул небезопасный контракт загрузки');

  const url = safeHttpsUrl(value.url);
  if (
    url.hash ||
    !/^\/api\/public\/v1\/transfers\/[0-9a-f-]{36}\/upload$/i.test(url.pathname) ||
    !/^\?secret=[A-Za-z0-9_-]{43}$/.test(url.search)
  ) throw new Error('Сервер вернул небезопасный URL загрузки');
  return value as unknown as TransferSessionDelivery;
}

const publicDeliveryControllers = new Set<AbortController>();

export function cancelPublicDeliveryRequests(): void {
  for (const controller of publicDeliveryControllers) controller.abort();
  publicDeliveryControllers.clear();
}

export async function uploadTransferFile(
  rawDelivery: unknown,
  file: File,
  expectedResourceKind: string,
  expectedResourceId: string,
  options: {
    signal?: AbortSignal;
    assertContextCurrent?: () => void;
  } = {},
): Promise<TransferSessionDelivery> {
  const delivery = validateTransferUploadDelivery(
    rawDelivery,
    expectedResourceKind,
    expectedResourceId,
    file.size,
  );
  const controller = new AbortController();
  publicDeliveryControllers.add(controller);
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', abort, { once: true });

  try {
    options.assertContextCurrent?.();
    const response = await fetch(delivery.url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    options.assertContextCurrent?.();
    if (!response.ok) {
      throw new Error(`Ошибка прямой загрузки (${response.status})`);
    }
    return delivery;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abort);
    publicDeliveryControllers.delete(controller);
  }
}

async function probeTransfer(delivery: TransferSessionDelivery): Promise<void> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), DIRECT_PROBE_TIMEOUT_MS);
  try {
    await fetch(delivery.url, {
      method: 'HEAD',
      mode: 'no-cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
  } catch {
    throw new Error('TARGET_BROWSER_UNREACHABLE: браузер не может скачать файл с выбранного сервера');
  } finally {
    window.clearTimeout(timer);
  }
}

export async function navigateDownloadDelivery(
  rawDelivery: unknown,
  popup: Window | null,
  expectedResourceKind: string,
): Promise<TransferSessionDelivery | ExternalProviderDelivery> {
  const rawKind = rawDelivery && typeof rawDelivery === 'object'
    ? (rawDelivery as Record<string, unknown>).kind
    : null;
  const delivery = rawKind === 'TransferSession'
    ? validateTransferSessionDelivery(rawDelivery, expectedResourceKind)
    : validateExternalProviderDelivery(rawDelivery, expectedResourceKind);
  if (delivery.kind === 'TransferSession') await probeTransfer(delivery);
  if (popup && !popup.closed) {
    try { popup.opener = null; } catch { /* browser-controlled */ }
    popup.location.replace(delivery.url);
  } else {
    const link = document.createElement('a');
    link.href = delivery.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }
  return delivery;
}

async function probeAdminerOrigin(origin: string): Promise<void> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), DIRECT_PROBE_TIMEOUT_MS);
  try {
    await fetch(`${origin}/api/public/v1/adminer/probe`, {
      method: 'HEAD',
      mode: 'no-cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
  } catch {
    throw new Error('TARGET_BROWSER_UNREACHABLE: браузер не может открыть Adminer на выбранном сервере');
  } finally {
    window.clearTimeout(timer);
  }
}

async function probeModxOrigin(origin: string): Promise<void> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), DIRECT_PROBE_TIMEOUT_MS);
  try {
    await fetch(`${origin}/api/public/v1/modx/login`, {
      method: 'HEAD',
      mode: 'no-cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
  } catch {
    throw new Error('TARGET_BROWSER_UNREACHABLE: браузер не может открыть MODX на выбранном сервере');
  } finally {
    window.clearTimeout(timer);
  }
}

export async function navigateAppHandoff(
  rawDelivery: unknown,
  popup: Window | null,
  expectedPurpose: Extract<PublicDeliveryPurpose, 'ADMINER' | 'MANTICORE'>,
): Promise<AppHandoffDelivery> {
  const delivery = validateAppHandoffDelivery(rawDelivery);
  if (delivery.purpose !== expectedPurpose) {
    throw new Error('Сервер вернул неверный контракт handoff');
  }
  if (!delivery.oneTime || !delivery.browserReachabilityRequired) {
    throw new Error('Сервер вернул небезопасный контракт handoff');
  }
  if (new Date(delivery.expiresAt!).getTime() <= Date.now()) {
    throw new Error('Одноразовый handoff уже истёк');
  }
  const url = new URL(delivery.url);
  await probeAdminerOrigin(url.origin);
  if (popup && !popup.closed) {
    try { popup.opener = null; } catch { /* browser-controlled */ }
    popup.location.replace(delivery.url);
  } else {
    window.location.assign(delivery.url);
  }
  return delivery;
}

export async function navigateModxHandoff(
  rawDelivery: unknown,
  popup: Window | null,
): Promise<AppHandoffDelivery> {
  const delivery = validateAppHandoffDelivery(rawDelivery);
  if (
    delivery.purpose !== 'MODX_LOGIN' ||
    !delivery.oneTime ||
    !delivery.browserReachabilityRequired ||
    new Date(delivery.expiresAt!).getTime() <= Date.now()
  ) throw new Error('Сервер вернул небезопасный MODX handoff');
  const url = new URL(delivery.url);
  await probeModxOrigin(url.origin);
  if (popup && !popup.closed) {
    try { popup.opener = null; } catch { /* browser-controlled */ }
    popup.location.replace(delivery.url);
  } else {
    window.location.assign(delivery.url);
  }
  return delivery;
}
