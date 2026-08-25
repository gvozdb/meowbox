import { FederatedWebhookDelivery, FederatedWebhookProvider } from '@meowbox/shared';
import {
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import {
  decryptWithDomain,
  deriveKey,
  encryptWithDomain,
} from './master-key';

interface WebhookRouteVerifierEnvelope {
  version: 1;
  routeId: string;
  provider: FederatedWebhookProvider;
  secret: string;
}

const SPOOL_MAGIC = Buffer.from('MBWH1', 'ascii');

export function deriveWebhookRouteToken(routeId: string, version: number): string {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('Webhook token version is invalid');
  return createHmac('sha256', deriveKey('webhook'))
    .update(`route-token:v1:${routeId}:${version}`, 'utf8')
    .digest('base64url');
}

export function webhookRouteTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function encryptWebhookRouteVerifier(
  routeId: string,
  provider: FederatedWebhookProvider,
  secret: string,
): string {
  return encryptWithDomain('webhook', {
    version: 1,
    routeId,
    provider,
    secret,
  } satisfies WebhookRouteVerifierEnvelope);
}

export function decryptWebhookRouteVerifier(
  routeId: string,
  encoded: string,
): Readonly<{ provider: FederatedWebhookProvider; secret: string }> {
  const envelope = decryptWithDomain<WebhookRouteVerifierEnvelope>('webhook', encoded);
  if (
    envelope.version !== 1 ||
    envelope.routeId !== routeId ||
    !['GITHUB', 'GITEA'].includes(envelope.provider)
  ) throw new Error('Webhook route verifier binding mismatch');
  return { provider: envelope.provider, secret: envelope.secret };
}

function spoolAad(delivery: Pick<FederatedWebhookDelivery, 'deliveryId' | 'routeId' | 'rawBodySha256'>): Buffer {
  return Buffer.from(
    `meowbox:webhook-spool:v1\0${delivery.routeId}\0${delivery.deliveryId}\0${delivery.rawBodySha256}`,
    'utf8',
  );
}

export function encryptWebhookSpool(delivery: FederatedWebhookDelivery): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey('webhook'), iv);
  cipher.setAAD(spoolAad(delivery));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(delivery), 'utf8')),
    cipher.final(),
  ]);
  return Buffer.concat([SPOOL_MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptWebhookSpool(
  binding: Pick<FederatedWebhookDelivery, 'deliveryId' | 'routeId' | 'rawBodySha256'>,
  encoded: Buffer,
): unknown {
  if (encoded.length < SPOOL_MAGIC.length + 12 + 16 + 1 ||
      !encoded.subarray(0, SPOOL_MAGIC.length).equals(SPOOL_MAGIC)) {
    throw new Error('Webhook spool payload is invalid');
  }
  const ivStart = SPOOL_MAGIC.length;
  const tagStart = ivStart + 12;
  const bodyStart = tagStart + 16;
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey('webhook'),
    encoded.subarray(ivStart, tagStart),
  );
  decipher.setAAD(spoolAad(binding));
  decipher.setAuthTag(encoded.subarray(tagStart, bodyStart));
  const plaintext = Buffer.concat([
    decipher.update(encoded.subarray(bodyStart)),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}
