const MAX_CUSTOM_POOL_CONFIG_BYTES = 64 * 1024;

const FORBIDDEN_POOL_DIRECTIVES = new Set([
  'user',
  'group',
  'listen',
  'socket',
  'chdir',
]);

const OWNED_PHP_VALUES = new Set([
  'error_log',
  'sys_temp_dir',
  'upload_tmp_dir',
  'session.save_path',
  'open_basedir',
]);

function directiveKey(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) return null;
  if (/^\[[^\]]+\]$/.test(trimmed)) return '__section__';
  const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_.]*(?:\[[^\]]+\])?)(?:\s*=|\s+)/);
  return match?.[1]?.trim().toLowerCase() || null;
}

function isForbiddenDirective(key: string): boolean {
  if (FORBIDDEN_POOL_DIRECTIVES.has(key)) return true;
  if (key.startsWith('listen.') || key.startsWith('socket.')) return true;

  const valueMatch = key.match(/^php_(?:admin_)?(?:value|flag)\[([^\]]+)\]$/);
  return valueMatch ? OWNED_PHP_VALUES.has(valueMatch[1].trim().toLowerCase()) : false;
}

/**
 * Validates a user-provided pool fragment before it is appended to the
 * generated pool. Pool identity, socket ownership and generated log/temp paths
 * must remain agent-owned; ordinary resource directives remain configurable.
 */
export function validateCustomPhpPoolConfig(customConfig: string | null | undefined): void {
  const value = (customConfig || '').trim();
  if (!value) return;
  if (Buffer.byteLength(value, 'utf8') > MAX_CUSTOM_POOL_CONFIG_BYTES) {
    throw new Error(`PHP-FPM custom pool config exceeds ${MAX_CUSTOM_POOL_CONFIG_BYTES} bytes`);
  }
  if (/[\x00\r]/.test(value)) {
    throw new Error('PHP-FPM custom pool config contains control characters');
  }

  const lines = value.split('\n');
  for (const [index, line] of lines.entries()) {
    const key = directiveKey(line);
    if (key === '__section__') {
      throw new Error(`PHP-FPM custom pool config must not declare a section (line ${index + 1})`);
    }
    if (key && isForbiddenDirective(key)) {
      throw new Error(
        `PHP-FPM custom pool config cannot override ${key} (line ${index + 1})`,
      );
    }
  }
}

export function isForbiddenPhpPoolDirective(key: string): boolean {
  return isForbiddenDirective(key.trim().toLowerCase());
}
