import {
  BadRequestException,
  PayloadTooLargeException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  FEDERATED_WEBHOOK_MAX_RAW_BYTES,
  FederatedWebhookProvider,
} from '@meowbox/shared';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';

const CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const DELIVERY_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface VerifiedWebhookProviderDelivery {
  provider: FederatedWebhookProvider;
  providerDeliveryId: string;
  event: string;
  signature: string;
  payload: Record<string, unknown>;
}

function uniqueRawHeader(rawHeaders: readonly string[], name: string): string {
  if (rawHeaders.length % 2 !== 0) throw new BadRequestException('Malformed webhook headers');
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const rawName = rawHeaders[index];
    const rawValue = rawHeaders[index + 1];
    if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(rawName) === false || /[\x00-\x1f\x7f]/.test(rawValue)) {
      throw new BadRequestException('Malformed webhook headers');
    }
    if (rawName.toLowerCase() === name) values.push(rawValue.trim());
  }
  if (values.length !== 1 || values[0].length === 0) {
    throw new BadRequestException(`Webhook header ${name} is required exactly once`);
  }
  return values[0];
}

function safeEqualHex(actual: string, expected: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(actual) || !/^[0-9a-f]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function parseJsonBody(body: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new BadRequestException('Webhook body must be valid JSON UTF-8');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BadRequestException('Webhook body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export function detectWebhookProvider(rawHeaders: readonly string[]): FederatedWebhookProvider {
  const names = new Set<string>();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    names.add(String(rawHeaders[index] || '').toLowerCase());
  }
  return names.has('x-gitea-signature') ? 'GITEA' : 'GITHUB';
}

export function verifyWebhookProviderDelivery(
  provider: FederatedWebhookProvider,
  secret: string,
  rawHeaders: readonly string[],
  body: Buffer,
): VerifiedWebhookProviderDelivery {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new BadRequestException('Webhook body is required');
  }
  if (body.length > FEDERATED_WEBHOOK_MAX_RAW_BYTES) {
    throw new PayloadTooLargeException('Webhook body exceeds 64 KiB');
  }
  const secretBytes = Buffer.byteLength(secret, 'utf8');
  if (secretBytes < 16 || secretBytes > 512 || /[\x00\r\n]/.test(secret)) {
    throw new Error('Webhook verifier secret is invalid');
  }
  const contentType = uniqueRawHeader(rawHeaders, 'content-type');
  if (!CONTENT_TYPE.test(contentType)) {
    throw new BadRequestException('Webhook content type must be application/json');
  }
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const signature = provider === 'GITHUB'
    ? uniqueRawHeader(rawHeaders, 'x-hub-signature-256')
    : uniqueRawHeader(rawHeaders, 'x-gitea-signature');
  const actualDigest = provider === 'GITHUB'
    ? /^sha256=([0-9a-f]{64})$/.exec(signature)?.[1]
    : /^([0-9a-f]{64})$/.exec(signature)?.[1];
  if (!actualDigest || !safeEqualHex(actualDigest, expected)) {
    throw new UnauthorizedException('Webhook signature is invalid');
  }
  const event = uniqueRawHeader(
    rawHeaders,
    provider === 'GITHUB' ? 'x-github-event' : 'x-gitea-event',
  );
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(event)) {
    throw new BadRequestException('Webhook event is invalid');
  }
  const providerDeliveryId = uniqueRawHeader(
    rawHeaders,
    provider === 'GITHUB' ? 'x-github-delivery' : 'x-gitea-delivery',
  );
  if (!DELIVERY_ID.test(providerDeliveryId)) {
    throw new BadRequestException('Webhook delivery ID is invalid');
  }
  return {
    provider,
    providerDeliveryId,
    event,
    signature,
    payload: parseJsonBody(body),
  };
}
