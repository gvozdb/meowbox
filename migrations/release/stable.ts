import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename } from 'node:path';

import type { DatabaseFileFingerprint, JsonObject, JsonValue } from './types';

/**
 * JSON.stringify preserves insertion order, which is not suitable for a
 * schema contract. Sort every object key first so two equal reports are byte
 * identical regardless of SQLite row order or JavaScript object construction.
 */
export function stableJson(value: JsonValue): string {
  return JSON.stringify(sortJson(value));
}

export function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    const object: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
      object[key] = sortJson(value[key]);
    }
    return object;
  }
  return value;
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function sha256Json(value: JsonValue): string {
  return sha256Text(stableJson(value));
}

export async function sha256File(filePath: string): Promise<string> {
  await access(filePath, constants.R_OK);
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk: string | Buffer) => { hash.update(chunk); });
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function optionalFileHash(filePath: string): Promise<string | null> {
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile()) return null;
    return await sha256File(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Hash SQLite's main/WAL/SHM triplet without exposing its absolute location.
 * The caller must take its own read/update lock; this detects a concurrent
 * writer between the beginning and end of a supposedly read-only preflight.
 */
export async function fingerprintDatabaseFiles(dbPath: string): Promise<DatabaseFileFingerprint> {
  const main = await sha256File(dbPath);
  const [wal, shm] = await Promise.all([
    optionalFileHash(`${dbPath}-wal`),
    optionalFileHash(`${dbPath}-shm`),
  ]);
  const combined = sha256Json({ main, wal, shm });
  return { main, wal, shm, combined };
}

/** Do not emit deployment-specific directory structure in public reports. */
export function publicFileLabel(filePath: string): string {
  return basename(filePath) || 'sqlite.db';
}

export function asJsonObject(value: unknown, context: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${context} must be a JSON object`);
  }
  const candidate = value as Record<string, unknown>;
  const result: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(candidate)) result[key] = asJsonValue(child, `${context}.${key}`);
  return result;
}

export function asJsonValue(value: unknown, context: string): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${context} must be finite JSON`);
    return value;
  }
  if (Array.isArray(value)) return value.map((child, index) => asJsonValue(child, `${context}[${index}]`));
  if (typeof value === 'object') return asJsonObject(value, context);
  throw new Error(`${context} is not JSON-safe`);
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && !Array.isArray(value) && typeof value === 'object';
}
