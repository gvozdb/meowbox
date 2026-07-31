import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';

export const MODX_PRESETS = new Set(['MODX_REVO', 'MODX_3']);
export const KNOWN_PRESETS = new Set(['MODX_REVO', 'MODX_3', 'CUSTOM']);
const RELATIVE_PATH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export interface ValidationFailure {
  readonly code: string;
  readonly message: string;
}

export function isModxPreset(value: string): boolean {
  return MODX_PRESETS.has(value);
}

export function normalizeRelativePath(value: string): string | ValidationFailure {
  if (value.length === 0) return { code: 'PATH_EMPTY', message: 'filesRelPath is empty' };
  if (/[\u0000-\u001f\u007f]/.test(value)) return { code: 'PATH_CONTROL_CHARACTER', message: 'filesRelPath contains a control character' };
  const slashNormalized = value.replaceAll('\\', '/');
  if (slashNormalized.startsWith('/') || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    return { code: 'PATH_ABSOLUTE', message: 'filesRelPath must be relative' };
  }
  const parts = slashNormalized.split('/');
  if (parts.some((part) => part === '..')) return { code: 'PATH_TRAVERSAL', message: 'filesRelPath contains a parent traversal segment' };
  const normalized = parts.filter((part) => part.length > 0 && part !== '.').join('/');
  if (normalized.length === 0) return { code: 'PATH_EMPTY', message: 'filesRelPath resolves to an empty path' };
  if (!RELATIVE_PATH_RE.test(normalized)) {
    return {
      code: 'PATH_CHARACTERS',
      message: 'filesRelPath contains unsupported characters',
    };
  }
  return normalized;
}

/** Logical containment only; destructive callers must additionally resolve symlinks. */
export function isRelativePathContained(rootPath: string, relativePath: string): boolean {
  if (!path.isAbsolute(rootPath)) return false;
  const root = path.resolve(rootPath);
  const resolved = path.resolve(root, relativePath);
  const relation = path.relative(root, resolved);
  return relation !== '' && !relation.startsWith(`..${path.sep}`) && relation !== '..' && !path.isAbsolute(relation);
}

export function deriveSecondaryRuntimeKey(domainId: string): string {
  return `d${createHash('sha256').update(domainId, 'utf8').digest('hex').slice(0, 20)}`;
}

export function isSafeRuntimeKey(runtimeKey: string): boolean {
  return /^[a-z][a-z0-9._-]{0,63}$/.test(runtimeKey);
}

export function socketPathWithinLimit(
  runtimeKey: string,
  socketDirectory = '/var/run/php',
  maxBytes = 107,
  phpVersion = '8.2',
): boolean {
  if (!/^\d+\.\d+$/.test(phpVersion)) return false;
  return Buffer.byteLength(
    path.posix.join(socketDirectory, `php${phpVersion}-fpm-${runtimeKey}.sock`),
    'utf8',
  ) <= maxBytes;
}

export function normalizeHostname(value: string): string | ValidationFailure {
  let normalized = value.trim().toLowerCase();
  if (normalized.endsWith('.')) normalized = normalized.slice(0, -1);
  if (normalized.length === 0) return { code: 'HOSTNAME_EMPTY', message: 'hostname is empty' };
  if (normalized.includes('*')) return { code: 'HOSTNAME_WILDCARD', message: 'wildcard hostnames are unsupported' };
  const ascii = domainToASCII(normalized);
  if (ascii.length === 0 || ascii.length > 253) return { code: 'HOSTNAME_INVALID', message: 'hostname cannot be converted to a valid ASCII hostname' };
  const labels = ascii.split('.');
  if (labels.some((label) => label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    return { code: 'HOSTNAME_INVALID', message: 'hostname has an invalid DNS label' };
  }
  return ascii;
}

export interface AliasParseSuccess {
  readonly ok: true;
  readonly hostnames: readonly string[];
}

export interface AliasParseFailure {
  readonly ok: false;
  readonly failure: ValidationFailure;
}

/** Supports both historical aliases=["www.example"] and object aliases. */
export function parseAliases(raw: string): AliasParseSuccess | AliasParseFailure {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { ok: false, failure: { code: 'ALIASES_INVALID_JSON', message: 'aliases is not valid JSON' } };
  }
  if (!Array.isArray(decoded)) return { ok: false, failure: { code: 'ALIASES_INVALID_JSON', message: 'aliases must be a JSON array' } };
  const hostnames: string[] = [];
  for (const value of decoded) {
    const hostname = typeof value === 'string'
      ? value
      : value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).domain === 'string'
        ? (value as Record<string, unknown>).domain as string
        : null;
    if (hostname === null) return { ok: false, failure: { code: 'ALIASES_INVALID_ITEM', message: 'aliases contains an unsupported item' } };
    const normalized = normalizeHostname(hostname);
    if (typeof normalized !== 'string') return { ok: false, failure: normalized };
    hostnames.push(normalized);
  }
  return { ok: true, hostnames };
}
