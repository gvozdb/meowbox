import { createHash } from 'crypto';
import { existsSync, realpathSync } from 'fs';
import * as path from 'path';
import { domainToASCII } from 'url';

const HOSTNAME_MAX_LENGTH = 253;
const LABEL_MAX_LENGTH = 63;
const RUNTIME_KEY_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const RELATIVE_PATH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export function canonicalizeHostname(input: string): string {
  const trimmed = input.trim().toLowerCase().replace(/\.$/, '');
  if (!trimmed || CONTROL_CHARS_RE.test(trimmed) || trimmed.includes('*')) {
    throw new Error('Invalid hostname');
  }

  const ascii = domainToASCII(trimmed);
  if (!ascii || ascii.length > HOSTNAME_MAX_LENGTH) {
    throw new Error('Invalid hostname');
  }

  const labels = ascii.split('.');
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        !label ||
        label.length > LABEL_MAX_LENGTH ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    throw new Error('Invalid hostname');
  }

  return ascii;
}

export function normalizeFilesRelPath(input: string): string {
  const source = input.trim();
  if (
    !source ||
    CONTROL_CHARS_RE.test(source) ||
    path.posix.isAbsolute(source) ||
    path.win32.isAbsolute(source) ||
    /^[A-Za-z]:/.test(source)
  ) {
    throw new Error('Application path must be a non-empty relative path');
  }

  const slashes = source.replace(/\\/g, '/');
  const segments = slashes.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new Error('Application path must not contain parent traversal');
  }

  const normalized = segments
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/');
  if (!normalized || !RELATIVE_PATH_RE.test(normalized)) {
    throw new Error('Invalid application path');
  }
  return normalized;
}

export function resolveApplicationRoot(
  siteRootPath: string,
  filesRelPath: string,
  options: { resolveSymlinks?: boolean } = {},
): string {
  const root = path.resolve(siteRootPath);
  const candidate = path.resolve(root, normalizeFilesRelPath(filesRelPath));
  assertContained(root, candidate);

  if (options.resolveSymlinks && existsSync(candidate)) {
    const realRoot = existsSync(root) ? realpathSync(root) : root;
    const realCandidate = realpathSync(candidate);
    assertContained(realRoot, realCandidate);
    return realCandidate;
  }

  return candidate;
}

export function runtimeKeyForDomain(domainId: string): string {
  return `d${createHash('sha256').update(domainId).digest('hex').slice(0, 20)}`;
}

export function assertRuntimeKey(value: string): string {
  if (!RUNTIME_KEY_RE.test(value)) {
    throw new Error('Invalid runtime key');
  }
  return value;
}

export function validateEnvVars(
  envVars: Record<string, string> | undefined,
): Record<string, string> {
  if (envVars === undefined) return {};
  const entries = Object.entries(envVars);
  if (
    entries.length > 100 ||
    entries.some(
      ([key, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) ||
        typeof value !== 'string' ||
        value.length > 8192 ||
        value.includes('\0'),
    ) ||
    Buffer.byteLength(JSON.stringify(envVars), 'utf8') > 64 * 1024
  ) {
    throw new Error('Invalid or oversized environment variables');
  }
  return envVars;
}

function assertContained(root: string, candidate: string): void {
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error('Application path escapes the Site root');
  }
}
