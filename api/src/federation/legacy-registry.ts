import { createHash } from 'node:crypto';
import { decryptWithDomain, encryptWithDomain } from '../common/crypto/master-key';

export interface LegacyServerRecord {
  id: string;
  name: string;
  url: string;
  token: string;
}

interface EncryptedLegacyToken {
  version: 1;
  kind: 'legacy-proxy-token';
  serverId: string;
  token: string;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const NAME = /^[\p{L}\p{N}_ .-]{2,64}$/u;
const TOKEN = /^[A-Za-z0-9._~-]{16,256}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeLegacyServerUrl(input: string): string {
  if (typeof input !== 'string' || input.length > 256 || /[\s\0\r\n]/.test(input)) {
    throw new Error('Legacy server URL is invalid');
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('Legacy server URL is invalid');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Legacy server URL must be an HTTP(S) origin');
  }
  return parsed.origin;
}

export function validateLegacyServerRecord(value: unknown): LegacyServerRecord {
  if (!isRecord(value)) throw new Error('Legacy server record is invalid');
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'id,name,token,url') throw new Error('Legacy server record fields are invalid');
  if (typeof value.id !== 'string' || !ID.test(value.id)) throw new Error('Legacy server ID is invalid');
  if (typeof value.name !== 'string' || !NAME.test(value.name)) throw new Error('Legacy server name is invalid');
  if (typeof value.token !== 'string' || !TOKEN.test(value.token)) throw new Error('Legacy server token is invalid');
  return {
    id: value.id,
    name: value.name,
    url: normalizeLegacyServerUrl(value.url as string),
    token: value.token,
  };
}

export function parseLegacyRegistry(content: string): LegacyServerRecord[] {
  if (Buffer.byteLength(content, 'utf8') > 1_048_576) {
    throw new Error('Legacy registry exceeds 1 MiB');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Legacy registry JSON is invalid');
  }
  if (!Array.isArray(parsed) || parsed.length > 1_000) {
    throw new Error('Legacy registry must be a bounded array');
  }
  const records = parsed.map(validateLegacyServerRecord);
  if (new Set(records.map(({ id }) => id)).size !== records.length) {
    throw new Error('Legacy registry contains duplicate IDs');
  }
  if (new Set(records.map(({ name }) => name)).size !== records.length) {
    throw new Error('Legacy registry contains duplicate names');
  }
  return records;
}

export function legacyRegistryDigest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function renderLegacyRegistry(records: readonly LegacyServerRecord[]): string {
  const sorted = [...records].sort((left, right) => left.id.localeCompare(right.id));
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

export function encryptLegacyToken(serverId: string, token: string): string {
  if (!ID.test(serverId) || !TOKEN.test(token)) throw new Error('Legacy token binding is invalid');
  const payload: EncryptedLegacyToken = {
    version: 1,
    kind: 'legacy-proxy-token',
    serverId,
    token,
  };
  return encryptWithDomain('federation', payload);
}

export function decryptLegacyToken(serverId: string, encoded: string): string {
  const payload = decryptWithDomain<EncryptedLegacyToken>('federation', encoded);
  if (
    payload.version !== 1 ||
    payload.kind !== 'legacy-proxy-token' ||
    payload.serverId !== serverId ||
    !TOKEN.test(payload.token)
  ) throw new Error('Legacy token binding is invalid');
  return payload.token;
}

