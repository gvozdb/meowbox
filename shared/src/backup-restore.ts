export const RESTORE_INCLUDE_PATH_LIMIT = 200;
export const RESTORE_INCLUDE_PATH_MAX_LENGTH = 4096;

/**
 * Normalizes selective restore paths without ever turning invalid input into
 * an empty list (which means "restore everything").
 */
export function normalizeRestoreIncludePaths(
  input: readonly unknown[] | undefined,
): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > RESTORE_INCLUDE_PATH_LIMIT) {
    throw new Error('Invalid restore include paths');
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const value = input[index];
    if (typeof value !== 'string') {
      throw new Error(`Invalid restore include path at index ${index}`);
    }
    const normalized = value
      .trim()
      .replace(/^\.\/+/, '')
      .replace(/\/+$/, '');
    const segments = normalized.split('/');
    if (
      normalized.length === 0 ||
      normalized.length > RESTORE_INCLUDE_PATH_MAX_LENGTH ||
      normalized === '.' ||
      normalized.startsWith('/') ||
      /^[A-Za-z]:/.test(normalized) ||
      /[\u0000-\u001f\u007f\\]/.test(normalized) ||
      segments.some(
        (segment) =>
          segment.length === 0 || segment === '.' || segment === '..',
      )
    ) {
      throw new Error(`Invalid restore include path at index ${index}`);
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}
