const MEOWBOX_MANAGED_PHP_FPM_VALUES = new Set([
  'error_log',
  'sys_temp_dir',
  'upload_tmp_dir',
  'session.save_path',
  'open_basedir',
]);

function phpFpmDirectiveKey(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) return null;
  const match = trimmed.match(
    /^([A-Za-z_][A-Za-z0-9_.]*(?:\[[^\]]+\])?)(?:\s*=|\s+)/,
  );
  return match?.[1]?.trim().toLowerCase() || null;
}

/** True when a PHP-FPM value is rendered from Meowbox-owned runtime paths. */
export function isMeowboxManagedPhpFpmDirective(key: string): boolean {
  const match = key
    .trim()
    .toLowerCase()
    .match(/^php_(?:admin_)?(?:value|flag)\[([^\]]+)\]$/);
  return match
    ? MEOWBOX_MANAGED_PHP_FPM_VALUES.has(match[1].trim())
    : false;
}

/**
 * Legacy hostPanel pools contain absolute paths tied to the source site/user.
 * Drop only values that the target renderer recreates from its own runtime;
 * all ordinary overrides stay intact and the normal pool validator remains
 * responsible for rejecting unsafe identity/socket directives.
 */
export function sanitizeMigratedPhpFpmCustomConfig(
  customConfig: string | null | undefined,
): string {
  return (customConfig || '')
    .split(/\r?\n/)
    .filter((line) => {
      const key = phpFpmDirectiveKey(line);
      return !key || !isMeowboxManagedPhpFpmDirective(key);
    })
    .join('\n')
    .trim();
}
