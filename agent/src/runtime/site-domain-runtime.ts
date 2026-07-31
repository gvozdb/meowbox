import * as path from 'path';

import { PHP_FPM_SOCKET_DIR } from '../config';

/** Linux sockaddr_un leaves one byte for the terminating NUL. */
export const MAX_UNIX_SOCKET_PATH_BYTES = 107;

const RUNTIME_KEY_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const PHP_VERSION_RE = /^\d+\.\d+$/;
const SITE_DOMAIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RELATIVE_PATH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** Existing and future agent payloads can be consumed without importing API/Prisma types. */
export interface SiteDomainRuntimePayload {
  readonly domainId: string;
  readonly domain: string;
  readonly filesRelPath: string;
  readonly phpVersion: string | null;
  readonly runtimeKey: string;
  readonly socketPath?: string | null;
  /** Alias accepted while API payloads transition from socketPath to socket. */
  readonly socket?: string | null;
  readonly appPort?: number | null;
  readonly preset: string;
  readonly isPrimary: boolean;
}

/** Site is only a transport envelope; application runtime always lives on domains. */
export interface SiteRuntimePayload {
  readonly siteName: string;
  readonly rootPath: string;
  readonly systemUser?: string;
  readonly domains: ReadonlyArray<SiteDomainRuntimePayload>;
}

export interface ResolvedDomainPhpRuntime {
  readonly filesRelPath: string;
  readonly webRoot: string;
  readonly runtimeKey: string;
  readonly phpVersion: string | null;
  readonly socketPath: string | null;
  readonly phpEnabled: boolean;
}

export function validateRuntimeKey(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('runtimeKey is required');
  }
  const runtimeKey = value.trim();
  if (!RUNTIME_KEY_RE.test(runtimeKey)) {
    throw new Error(
      `Invalid runtimeKey "${value}": use 1-64 lowercase letters, digits, dot, underscore or hyphen`,
    );
  }
  return runtimeKey;
}

export function isValidRuntimeKey(value: string): boolean {
  return RUNTIME_KEY_RE.test(value.trim());
}

export function validateSiteDomainId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('siteDomainId is required');
  }
  const siteDomainId = value.trim();
  if (!SITE_DOMAIN_ID_RE.test(siteDomainId)) {
    throw new Error('Invalid siteDomainId');
  }
  return siteDomainId;
}

export function validatePhpVersion(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('phpVersion is required');
  }
  const version = value.trim();
  if (!PHP_VERSION_RE.test(version)) {
    throw new Error(`Invalid PHP version "${value}"`);
  }
  return version;
}

export function isValidPhpVersion(value: string): boolean {
  return PHP_VERSION_RE.test(value.trim());
}

export function validateSocketPath(value: string): string {
  if (!value || !path.posix.isAbsolute(value) || /[\x00\r\n]/.test(value)) {
    throw new Error(`Invalid PHP-FPM socket path "${value}"`);
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error(
      `PHP-FPM socket path is ${bytes} bytes; maximum is ${MAX_UNIX_SOCKET_PATH_BYTES}: ${value}`,
    );
  }
  return value;
}

export function buildPhpSocketPath(
  phpVersion: string,
  runtimeKey: string,
  socketDir = PHP_FPM_SOCKET_DIR,
): string {
  const version = validatePhpVersion(phpVersion);
  const key = validateRuntimeKey(runtimeKey);
  if (!socketDir || /[\x00\r\n]/.test(socketDir) || !path.posix.isAbsolute(socketDir)) {
    throw new Error(`Invalid PHP-FPM socket directory "${socketDir}"`);
  }
  return validateSocketPath(path.posix.join(socketDir, `php${version}-fpm-${key}.sock`));
}

/** Strict relative-path normalizer shared by Nginx, PHP and file-root callsites. */
export function normalizeFilesRelPath(value: string | null | undefined, fallback = 'www'): string {
  const source = (value == null ? fallback : value).trim().replace(/\\/g, '/');
  if (!source || source.startsWith('/') || /^[A-Za-z]:\//.test(source)) {
    throw new Error(`filesRelPath must be a non-empty relative path: "${value ?? ''}"`);
  }
  if (/[\x00-\x1f\x7f]/.test(source)) {
    throw new Error('filesRelPath contains control characters');
  }
  // A legacy caller may already pass the domain web-root as rootPath. Keep a
  // typed, explicit marker for that shape instead of silently appending www.
  if (source === '.') return '.';

  const parts: string[] = [];
  for (const part of source.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error('filesRelPath must not contain ".."');
    parts.push(part);
  }
  const normalized = parts.join('/');
  if (!normalized || !RELATIVE_PATH_RE.test(normalized)) {
    throw new Error(`Invalid filesRelPath "${value ?? ''}"`);
  }
  return normalized;
}

export function resolveSiteDomainRoot(siteRoot: string, filesRelPath: string): string {
  if (!siteRoot || !path.isAbsolute(siteRoot)) {
    throw new Error(`Site root must be absolute: "${siteRoot}"`);
  }
  const root = path.resolve(siteRoot);
  if (typeof filesRelPath !== 'string' || !filesRelPath.trim()) {
    throw new Error('filesRelPath is required');
  }
  const relative = normalizeFilesRelPath(filesRelPath);
  const resolved = relative === '.'
    ? root
    : path.resolve(root, ...relative.split('/'));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`filesRelPath escapes Site root: "${filesRelPath}"`);
  }
  return resolved;
}

export function resolveDomainPhpRuntime(params: {
  readonly siteRoot: string;
  readonly filesRelPath: string;
  readonly phpVersion: string | null;
  readonly runtimeKey: string;
  readonly socketPath?: string | null;
}): ResolvedDomainPhpRuntime {
  const filesRelPath = normalizeFilesRelPath(params.filesRelPath);
  const webRoot = resolveSiteDomainRoot(params.siteRoot, filesRelPath);
  const runtimeKey = validateRuntimeKey(params.runtimeKey);
  const phpVersion = params.phpVersion == null
    ? null
    : validatePhpVersion(params.phpVersion);

  if (!phpVersion) {
    if (params.socketPath != null) {
      throw new Error('A non-PHP domain cannot define a PHP-FPM socket');
    }
    return { filesRelPath, webRoot, runtimeKey, phpVersion: null, socketPath: null, phpEnabled: false };
  }

  const expectedSocket = buildPhpSocketPath(phpVersion, runtimeKey);
  if (params.socketPath != null && validateSocketPath(params.socketPath) !== expectedSocket) {
    throw new Error(
      `socketPath does not match phpVersion/runtimeKey; expected "${expectedSocket}"`,
    );
  }
  return {
    filesRelPath,
    webRoot,
    runtimeKey,
    phpVersion,
    socketPath: expectedSocket,
    phpEnabled: true,
  };
}
