import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BACKUP_LOCAL_PATH } from '../config';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const BACKUP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CHECKSUM_RE = /^[a-f0-9]{64}$/;

export function assertSiteBackupId(backupId: string): void {
  if (!BACKUP_ID_RE.test(backupId)) {
    throw new Error('Invalid backup id');
  }
}

export function writeSiteBackupManifest(
  backupId: string,
  serialized: string | undefined,
): string | null {
  if (serialized === undefined) return null;
  assertSiteBackupId(backupId);
  if (
    typeof serialized !== 'string' ||
    Buffer.byteLength(serialized, 'utf8') > MAX_MANIFEST_BYTES
  ) {
    throw new Error('Backup manifest is invalid or too large');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('Backup manifest is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Backup manifest must be an object');
  }
  const envelope = parsed as Record<string, unknown>;
  if (
    envelope.manifestVersion !== 2 ||
    envelope.schemaVersion !== 'domain-applications-v2' ||
    typeof envelope.checksum !== 'string' ||
    !CHECKSUM_RE.test(envelope.checksum)
  ) {
    throw new Error('Unsupported backup manifest envelope');
  }
  const payload = { ...envelope };
  delete payload.checksum;
  if (stableChecksum(payload) !== envelope.checksum) {
    throw new Error('Backup manifest checksum mismatch');
  }

  const directory = path.join(BACKUP_LOCAL_PATH, 'site-manifests');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const manifestPath = path.join(directory, `${backupId}.json`);
  const resolvedDirectory = path.resolve(directory);
  const resolvedPath = path.resolve(manifestPath);
  if (!resolvedPath.startsWith(`${resolvedDirectory}${path.sep}`)) {
    throw new Error('Backup manifest path escapes storage');
  }
  fs.writeFileSync(resolvedPath, serialized, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  return resolvedPath;
}

export function removeSiteBackupManifest(manifestPath: string | null): void {
  if (!manifestPath) return;
  const directory = path.resolve(
    path.join(BACKUP_LOCAL_PATH, 'site-manifests'),
  );
  const resolved = path.resolve(manifestPath);
  if (!resolved.startsWith(`${directory}${path.sep}`)) return;
  try {
    fs.unlinkSync(resolved);
  } catch {
    // Best-effort cleanup. The directory is root-only and stale files are
    // overwritten only after an operator removes them deliberately.
  }
}

function stableChecksum(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
}
