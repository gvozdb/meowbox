import * as path from 'path';

import {
  DEFAULT_PHP_MEMORY_LIMIT_MB,
  DEFAULT_PHP_POST_MAX_SIZE_MB,
  DEFAULT_PHP_UPLOAD_MAX_FILESIZE_MB,
} from '@meowbox/shared';

import {
  PHP_FPM_CONFIG_DIR,
  PHP_LOG_DIR,
  isUnderAllowedSiteRoot,
} from '../config';
import {
  resolveDomainPhpRuntime,
  validateSiteDomainId,
  validateRuntimeKey,
  validatePhpVersion,
  type ResolvedDomainPhpRuntime,
} from '../runtime/site-domain-runtime';
import { validateCustomPhpPoolConfig } from './pool-config.validator';

const LINUX_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const DEFAULT_POOL_MAX_CHILDREN = 8;

export interface PhpPoolRenderParams {
  readonly siteName: string;
  readonly domainId: string;
  readonly domain: string;
  readonly phpVersion: string;
  readonly runtimeKey: string;
  readonly socketPath?: string | null;
  readonly socket?: string | null;
  readonly user?: string;
  readonly systemUser?: string;
  readonly rootPath: string;
  readonly filesRelPath: string;
  readonly sslEnabled?: boolean;
  readonly tempPath?: string;
  readonly sessionPath?: string;
  readonly pmMaxChildren?: number;
  readonly customConfig?: string | null;
}

export interface RenderedPhpPool {
  readonly content: string;
  readonly homeDir: string;
  readonly tempDir: string;
  readonly sessionDir: string;
  readonly poolFile: string;
  readonly poolName: string;
  readonly phpVersion: string;
  readonly runtime: ResolvedDomainPhpRuntime;
  readonly user: string;
}

function assertSafePathValue(name: string, value: string): void {
  if (/[\n\r\0=;$`]/.test(value)) {
    throw new Error(`PHP-FPM ${name} contains forbidden characters`);
  }
}

function resolveManagedPath(homeDir: string, requested: string | undefined, fallback: string): string {
  if (!requested?.trim()) return path.resolve(fallback);
  const value = requested.trim();
  const resolved = path.resolve(path.isAbsolute(value) ? value : path.join(homeDir, value));
  if (resolved !== homeDir && !resolved.startsWith(`${homeDir}${path.sep}`)) {
    throw new Error(`Managed PHP path escapes Site root: ${resolved}`);
  }
  return resolved;
}

function directiveKey(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) return null;
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return null;
  const separator = trimmed.indexOf('=');
  return separator > 0 ? trimmed.slice(0, separator).trim() || null : null;
}

function overriddenDirectiveKeys(customConfig: string | null | undefined): Set<string> {
  const keys = new Set<string>();
  for (const line of (customConfig || '').trim().split(/\r?\n/)) {
    const key = directiveKey(line);
    if (key) keys.add(key);
  }
  return keys;
}

function renderCustomBlock(customConfig: string | null | undefined): string {
  const value = (customConfig || '').trim();
  if (!value) return '';
  return `
; --- Custom overrides (meowbox UI) ---
${value}
`;
}

/**
 * Pure renderer shared by normal agent provisioning and transactional release
 * staging. It validates every value before returning an absolute target path.
 */
export function renderPhpFpmPool(params: PhpPoolRenderParams): RenderedPhpPool {
  validateCustomPhpPoolConfig(params.customConfig);
  const domainId = validateSiteDomainId(params.domainId);
  const phpVersion = validatePhpVersion(params.phpVersion);
  const user = params.user || params.systemUser || 'www-data';
  if (!LINUX_USER_RE.test(user)) throw new Error(`Invalid PHP-FPM user "${user}"`);

  const pmMaxChildren = params.pmMaxChildren ?? DEFAULT_POOL_MAX_CHILDREN;
  if (!Number.isInteger(pmMaxChildren) || pmMaxChildren < 1 || pmMaxChildren > 1024) {
    throw new Error(`Invalid pm.max_children "${pmMaxChildren}"`);
  }

  const runtimeKey = validateRuntimeKey(params.runtimeKey);
  const homeDir = path.resolve(params.rootPath);

  assertSafePathValue('homeDir', homeDir);
  if (!isUnderAllowedSiteRoot(homeDir)) {
    throw new Error(`PHP-FPM homeDir "${homeDir}" is outside allowed Site roots`);
  }

  const runtime = resolveDomainPhpRuntime({
    siteRoot: homeDir,
    filesRelPath: params.filesRelPath,
    phpVersion,
    runtimeKey,
    socketPath: params.socketPath ?? params.socket,
  });
  const poolName = runtime.runtimeKey.replace(/\./g, '_');
  const poolFile = path.join(PHP_FPM_CONFIG_DIR, phpVersion, 'fpm', 'pool.d', `${poolName}.conf`);
  const useLegacySiteTmp = runtime.runtimeKey === params.siteName;
  const tempDir = resolveManagedPath(
    homeDir,
    params.tempPath,
    useLegacySiteTmp
      ? path.join(homeDir, 'tmp')
      : path.join(homeDir, 'tmp', runtime.runtimeKey),
  );
  const sessionDir = resolveManagedPath(homeDir, params.sessionPath, tempDir);
  for (const [name, value] of [
    ['tempDir', tempDir],
    ['sessionDir', sessionDir],
    ['webRoot', runtime.webRoot],
  ] as const) {
    assertSafePathValue(name, value);
  }

  const overriddenKeys = overriddenDirectiveKeys(params.customConfig);
  const baseLines: string[] = [
    `[${poolName}]`,
    `; meowbox-domain-id = ${domainId}`,
    `user = ${user}`,
    `group = ${user}`,
    `listen = ${runtime.socketPath}`,
    'listen.owner = www-data',
    'listen.group = www-data',
    'listen.mode = 0660',
    `chdir = ${runtime.webRoot}`,
    '',
    '; Process manager — ondemand uses minimal resources when idle',
    'pm = ondemand',
    `pm.max_children = ${pmMaxChildren}`,
    'pm.process_idle_timeout = 10s',
    'pm.max_requests = 500',
    '',
    '; Limits',
    'request_terminate_timeout = 300',
    'rlimit_files = 4096',
    '',
    '; Security — SiteDomain runtime',
    `php_admin_value[open_basedir] = ${homeDir}:${tempDir}:${homeDir}/.npm-global:/usr/share/php:/usr/bin:/usr/local/bin:/usr/local/lib/node_modules:/usr/lib/node_modules:/usr/share/npm:/usr/share/nodejs:/usr/share/node_modules`,
    `php_admin_value[sys_temp_dir] = ${tempDir}`,
    `php_admin_value[upload_tmp_dir] = ${tempDir}`,
    `php_admin_value[session.save_path] = ${sessionDir}`,
    'php_admin_value[disable_functions] = exec,passthru,shell_exec,system,popen',
    'php_admin_value[expose_php] = Off',
    'php_admin_value[allow_url_fopen] = Off',
    'php_admin_value[session.cookie_httponly] = On',
    `php_admin_value[session.cookie_secure] = ${params.sslEnabled ? 'On' : 'Off'}`,
    'php_admin_value[session.use_strict_mode] = On',
    '',
    '; Logging — one error log per runtimeKey',
    `php_admin_value[error_log] = ${PHP_LOG_DIR}/${runtime.runtimeKey}-error.log`,
    'php_admin_flag[log_errors] = On',
    '',
    '; Performance',
    `php_value[memory_limit] = ${DEFAULT_PHP_MEMORY_LIMIT_MB}M`,
    `php_value[upload_max_filesize] = ${DEFAULT_PHP_UPLOAD_MAX_FILESIZE_MB}M`,
    `php_value[post_max_size] = ${DEFAULT_PHP_POST_MAX_SIZE_MB}M`,
    'php_value[max_execution_time] = 120',
    'php_value[opcache.enable] = 1',
    'php_value[opcache.memory_consumption] = 64',
  ];
  const content = `${baseLines.map((line) => {
    const key = directiveKey(line);
    return key && overriddenKeys.has(key) ? `; [overridden by UI] ${line}` : line;
  }).join('\n')}\n${renderCustomBlock(params.customConfig)}`;

  return {
    content,
    homeDir,
    tempDir,
    sessionDir,
    poolFile,
    poolName,
    phpVersion,
    runtime,
    user,
  };
}
