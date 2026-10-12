import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import {
  decideRedisDataParentAccess,
  DPKG_STATOVERRIDE_FILE,
  REDIS_DATA_PARENT,
  type RedisDataParentDecision,
  type RedisDataParentState,
} from '@meowbox/shared';
import type { SystemMigration } from './_types';

async function inspect(dataBase: string, overrideFile: string): Promise<RedisDataParentDecision> {
  let state: RedisDataParentState;
  try {
    const stat = await fs.lstat(dataBase);
    state = stat.isSymbolicLink() || !stat.isDirectory()
      ? { kind: 'invalid' }
      : { kind: 'directory', mode: stat.mode, uid: stat.uid, gid: stat.gid };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    state = { kind: 'missing' };
  }

  if (state.kind !== 'directory') return decideRedisDataParentAccess(dataBase, state, null);
  let overrideText: string | null;
  try {
    overrideText = await fs.readFile(overrideFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    overrideText = null;
  }
  return decideRedisDataParentAccess(dataBase, state, overrideText);
}

export function createRedisDataStatoverrideMigration(
  dataBase = REDIS_DATA_PARENT,
  overrideFile = DPKG_STATOVERRIDE_FILE,
): SystemMigration {
  return {
    id: '2026-10-12-001-redis-data-statoverride',
    description: 'Persist per-site Redis parent traversal through package upgrades',

    async preflight() {
      try {
        await inspect(dataBase, overrideFile);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: (error as Error).message };
      }
    },

    async plan() {
      const decision = await inspect(dataBase, overrideFile);
      const details = {
        dataBase,
        mode: decision.mode,
        targetMode: decision.targetMode,
        needsOverride: decision.needsOverride,
        needsChmod: decision.needsChmod,
        addOverrideArgs: decision.addOverrideArgs,
      };
      return {
        summary: decision.kind === 'missing'
          ? `Redis data root is absent; skip ${dataBase}`
          : decision.needsOverride || decision.needsChmod
            ? `Persist Redis parent traversal for ${dataBase}`
            : `Redis parent traversal is already durable for ${dataBase}`,
        fingerprint: createHash('sha256').update(JSON.stringify(details)).digest('hex'),
        details,
      };
    },

    async up(ctx) {
      const decision = await inspect(dataBase, overrideFile);
      if (decision.kind === 'missing') {
        ctx.log(`SKIP: Redis data root is absent: ${dataBase}`);
        return;
      }
      if (ctx.dryRun) {
        ctx.log(`[dry-run] ${decision.needsOverride ? 'add dpkg-statoverride; ' : ''}${decision.needsChmod ? 'add other-execute' : 'no chmod needed'}: ${dataBase}`);
        return;
      }

      // Record package-upgrade behavior first. If dpkg rejects an existing or
      // concurrent conflicting entry, leave the live directory untouched.
      if (decision.addOverrideArgs) {
        await ctx.exec.run('dpkg-statoverride', decision.addOverrideArgs);
      }
      if (decision.needsChmod) {
        await fs.chmod(dataBase, decision.targetMode!);
      }
      ctx.log(`OK: Redis data parent traversal is durable: ${dataBase}`);
    },
  };
}

export default createRedisDataStatoverrideMigration();
