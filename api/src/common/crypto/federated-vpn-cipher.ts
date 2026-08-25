import { createHash, createHmac } from 'node:crypto';
import {
  decryptWithDomain,
  deriveKey,
  encryptWithDomain,
} from './master-key';

interface CachedVpnFragmentEnvelope<T> {
  version: 1;
  sourceId: string;
  payload: T;
}

export function deriveFederatedVpnSubscriptionToken(subscriptionId: string): string {
  return createHmac('sha256', deriveKey('federated-vpn'))
    .update(`subscription-token:v1:${subscriptionId}`, 'utf8')
    .digest('base64url');
}

export function federatedVpnTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function encryptFederatedVpnFragment<T>(sourceId: string, payload: T): string {
  return encryptWithDomain('federated-vpn', {
    version: 1,
    sourceId,
    payload,
  } satisfies CachedVpnFragmentEnvelope<T>);
}

export function decryptFederatedVpnFragment<T>(sourceId: string, encoded: string): T {
  const envelope = decryptWithDomain<CachedVpnFragmentEnvelope<T>>('federated-vpn', encoded);
  if (envelope.version !== 1 || envelope.sourceId !== sourceId) {
    throw new Error('Federated VPN cache binding mismatch');
  }
  return envelope.payload;
}
