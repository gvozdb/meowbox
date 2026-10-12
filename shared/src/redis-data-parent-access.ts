/** Decisions for the package-owned parent of per-site Redis data directories. */
export const REDIS_DATA_PARENT = '/var/lib/redis';
export const DPKG_STATOVERRIDE_FILE = '/var/lib/dpkg/statoverride';

export type RedisDataParentState =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'directory'; mode: number; uid: number; gid: number };

export interface RedisDataParentDecision {
  kind: 'missing' | 'directory';
  needsOverride: boolean;
  needsChmod: boolean;
  mode: number | null;
  targetMode: number | null;
  addOverrideArgs: string[] | null;
}

/** Pure: callers supply lstat data and the text of dpkg's override database. */
export function decideRedisDataParentAccess(
  dataBase: string,
  state: RedisDataParentState,
  overrideText: string | null,
): RedisDataParentDecision {
  if (state.kind === 'invalid') {
    throw new Error(`Redis data root is not a real directory: ${dataBase}`);
  }
  if (state.kind === 'missing') {
    return { kind: 'missing', needsOverride: false, needsChmod: false, mode: null, targetMode: null, addOverrideArgs: null };
  }

  let existingMode: number | null = null;
  for (const line of (overrideText ?? '').split('\n')) {
    if (!line.trim()) continue;
    const fields = /^\s*(\S+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!fields || fields[4] !== dataBase) continue;
    if (existingMode !== null || !/^[0-7]{3,4}$/.test(fields[3])) {
      throw new Error(`Invalid or duplicate dpkg-statoverride entry for ${dataBase}`);
    }
    existingMode = parseInt(fields[3], 8);
  }
  if (existingMode !== null && (existingMode & 0o001) === 0) {
    throw new Error(`Conflicting dpkg-statoverride for ${dataBase}: mode ${existingMode.toString(8)} lacks other-execute; resolve the existing override before changing permissions`);
  }

  const mode = state.mode & 0o7777;
  const targetMode = mode | 0o001;
  return {
    kind: 'directory',
    needsOverride: existingMode === null,
    needsChmod: mode !== targetMode,
    mode,
    targetMode,
    addOverrideArgs: existingMode === null
      ? ['--add', `#${state.uid}`, `#${state.gid}`, targetMode.toString(8), dataBase]
      : null,
  };
}
