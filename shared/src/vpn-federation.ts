import {
  isContractRecord,
  requireExactKeys,
  requireInteger,
  requireIsoDate,
  requireString,
} from './contract-validation';

export const FEDERATED_VPN_FRAGMENT_SCHEMA_VERSION = 1 as const;
export const FEDERATED_VPN_FRAGMENT_MAX_ENTRIES = 256;
export const FEDERATED_VPN_FRAGMENT_MAX_BYTES = 256 * 1024;
export const FEDERATED_VPN_FRAGMENT_MAX_VALIDITY_MS = 5 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^ed25519-[A-Za-z0-9_-]{22}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const SAFE_CONTENT = /^[^\u0000\u000b\u000c\u000e-\u001f\u007f]*$/u;

export interface FederatedVpnFragmentEntry {
  fingerprint: string;
  content: string;
}

export interface UnsignedFederatedVpnFragment {
  schemaVersion: typeof FEDERATED_VPN_FRAGMENT_SCHEMA_VERSION;
  targetInstallationId: string;
  sourceId: string;
  epoch: string;
  issuedAt: string;
  expiresAt: string;
  entries: readonly FederatedVpnFragmentEntry[];
}

export interface SignedFederatedVpnFragment extends UnsignedFederatedVpnFragment {
  signature: {
    algorithm: 'Ed25519';
    kid: string;
    value: string;
  };
}

export function validateSignedFederatedVpnFragment(
  value: unknown,
): SignedFederatedVpnFragment {
  if (!isContractRecord(value)) throw new Error('VPN fragment is invalid');
  requireExactKeys(value, [
    'schemaVersion',
    'targetInstallationId',
    'sourceId',
    'epoch',
    'issuedAt',
    'expiresAt',
    'entries',
    'signature',
  ], [], 'vpnFragment');
  if (value.schemaVersion !== FEDERATED_VPN_FRAGMENT_SCHEMA_VERSION) {
    throw new Error('vpnFragment.schemaVersion is invalid');
  }
  requireString(value.targetInstallationId, 'vpnFragment.targetInstallationId', { pattern: UUID });
  requireString(value.sourceId, 'vpnFragment.sourceId', { pattern: UUID });
  requireString(value.epoch, 'vpnFragment.epoch', { pattern: SHA256 });
  const issuedAt = requireIsoDate(value.issuedAt, 'vpnFragment.issuedAt');
  const expiresAt = requireIsoDate(value.expiresAt, 'vpnFragment.expiresAt');
  if (
    Date.parse(expiresAt) <= Date.parse(issuedAt) ||
    Date.parse(expiresAt) - Date.parse(issuedAt) > FEDERATED_VPN_FRAGMENT_MAX_VALIDITY_MS
  ) {
    throw new Error('vpnFragment validity window is invalid');
  }
  if (!Array.isArray(value.entries) || value.entries.length > FEDERATED_VPN_FRAGMENT_MAX_ENTRIES) {
    throw new Error('vpnFragment.entries is invalid');
  }
  let totalBytes = 0;
  const fingerprints = new Set<string>();
  for (const [index, raw] of value.entries.entries()) {
    if (!isContractRecord(raw)) throw new Error(`vpnFragment.entries[${index}] is invalid`);
    requireExactKeys(raw, ['fingerprint', 'content'], [], `vpnFragment.entries[${index}]`);
    const fingerprint = requireString(
      raw.fingerprint,
      `vpnFragment.entries[${index}].fingerprint`,
      { pattern: SHA256 },
    );
    const content = requireString(
      raw.content,
      `vpnFragment.entries[${index}].content`,
      { max: FEDERATED_VPN_FRAGMENT_MAX_BYTES, pattern: SAFE_CONTENT },
    );
    totalBytes += new TextEncoder().encode(content).byteLength;
    if (totalBytes > FEDERATED_VPN_FRAGMENT_MAX_BYTES || fingerprints.has(fingerprint)) {
      throw new Error('vpnFragment.entries exceeds bounds or contains duplicates');
    }
    fingerprints.add(fingerprint);
  }
  if (!isContractRecord(value.signature)) throw new Error('vpnFragment.signature is invalid');
  requireExactKeys(value.signature, ['algorithm', 'kid', 'value'], [], 'vpnFragment.signature');
  if (value.signature.algorithm !== 'Ed25519') {
    throw new Error('vpnFragment.signature.algorithm is invalid');
  }
  requireString(value.signature.kid, 'vpnFragment.signature.kid', { pattern: KEY_ID });
  requireString(value.signature.value, 'vpnFragment.signature.value', { pattern: SIGNATURE });
  return value as unknown as SignedFederatedVpnFragment;
}

export function unsignedFederatedVpnFragment(
  fragment: SignedFederatedVpnFragment,
): UnsignedFederatedVpnFragment {
  const { signature: _signature, ...unsigned } = fragment;
  return unsigned;
}
