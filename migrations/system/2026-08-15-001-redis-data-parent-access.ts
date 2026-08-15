import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

import type { MigrationPlan, SystemMigration } from './_types';

const MIGRATION_ID = '2026-08-15-001-redis-data-parent-access';
const DATA_BASE = '/var/lib/redis';

type DataBaseState =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'directory'; mode: number };

async function inspectDataBase(dataBase: string): Promise<DataBaseState> {
  try {
    const stat = await fs.lstat(dataBase);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { kind: 'invalid' };
    return { kind: 'directory', mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
}

function planFor(dataBase: string, state: DataBaseState): MigrationPlan {
  const mode = state.kind === 'directory' ? state.mode : null;
  const needsTraversal = mode !== null && (mode & 0o001) === 0;
  return {
    summary: state.kind === 'missing'
      ? 'Redis data root is absent; no permission change is needed'
      : needsTraversal
        ? `Grant site services traversal of ${dataBase}`
        : 'Redis data root already permits site-service traversal',
    fingerprint: createHash('sha256')
      .update(JSON.stringify({ dataBase, kind: state.kind, mode, needsTraversal }))
      .digest('hex'),
    details: { dataBase, mode, needsTraversal },
  };
}

export function createRedisDataParentAccessMigration(
  dataBase = DATA_BASE,
): SystemMigration {
  return {
    id: MIGRATION_ID,
    description: 'Allow per-site Redis services to traverse their data parent',

    async preflight() {
      const state = await inspectDataBase(dataBase);
      if (state.kind === 'invalid') {
        return { ok: false, reason: `Redis data root is not a real directory: ${dataBase}` };
      }
      return { ok: true };
    },

    async plan() {
      return planFor(dataBase, await inspectDataBase(dataBase));
    },

    async up(ctx) {
      const state = await inspectDataBase(dataBase);
      if (state.kind === 'missing') {
        ctx.log(`SKIP: Redis data root is absent: ${dataBase}`);
        return;
      }
      if (state.kind === 'invalid') {
        throw new Error(`Redis data root is not a real directory: ${dataBase}`);
      }
      if ((state.mode & 0o001) !== 0) {
        ctx.log(`OK: Redis data root already permits traversal: ${dataBase}`);
        return;
      }
      if (ctx.dryRun) {
        ctx.log(`[dry-run] would add other-execute to ${dataBase}`);
        return;
      }

      await fs.chmod(dataBase, state.mode | 0o001);
      const updated = await inspectDataBase(dataBase);
      if (updated.kind !== 'directory' || (updated.mode & 0o001) === 0) {
        throw new Error(`Could not grant traversal of Redis data root: ${dataBase}`);
      }
      ctx.log(`OK: granted per-site Redis traversal of ${dataBase}`);
    },
  };
}

const migration = createRedisDataParentAccessMigration();

export default migration;
