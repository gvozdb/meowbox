import { createHash } from 'node:crypto';
import * as path from 'node:path';

import type {
  MigrationContext,
  MigrationPlan,
  SystemMigration,
} from './_types';

const MIGRATION_ID = '2026-07-31-002-release-env-defaults';
const DEFAULTS = [
  {
    key: 'MEOWBOX_QUIESCE_TIMEOUT',
    value: '120',
    comment: 'Maximum release quiesce wait in seconds.',
  },
  {
    key: 'MEOWBOX_RELEASE_MIN_FREE_KB',
    value: '524288',
    comment: 'Free space reserved for candidate, clone and snapshot (KiB).',
  },
] as const;

interface EnvState {
  envFile: string | null;
  content: string;
  missing: (typeof DEFAULTS)[number][];
}

function hasAssignment(content: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^[ \\t]*${escaped}[ \\t]*=`, 'm').test(content);
}

async function inspectEnv(ctx: MigrationContext): Promise<EnvState> {
  const candidates = [
    path.join(ctx.config.stateDir, '.env'),
    path.join(ctx.config.panelDir, '.env'),
  ];
  const envFile =
    (await Promise.all(
      candidates.map(async (candidate) => ({
        candidate,
        exists: await ctx.exists(candidate),
      })),
    )).find(({ exists }) => exists)?.candidate || null;
  const content = envFile ? await ctx.readFile(envFile) : '';
  return {
    envFile,
    content,
    missing: DEFAULTS.filter(
      ({ key }) => !hasAssignment(content, key),
    ),
  };
}

function planFor(state: EnvState): MigrationPlan {
  const keys = state.missing.map(({ key }) => key);
  return {
    summary: state.envFile
      ? keys.length > 0
        ? `Append ${keys.join(', ')} defaults to panel .env`
        : 'Release transaction defaults are already configured'
      : 'Panel .env is absent; installation will provide release defaults',
    fingerprint: createHash('sha256')
      .update(
        JSON.stringify({
          envFile: state.envFile ? path.basename(state.envFile) : null,
          keys,
        }),
      )
      .digest('hex'),
    details: {
      envFile: state.envFile,
      missingKeys: keys,
    },
  };
}

const migration: SystemMigration = {
  id: MIGRATION_ID,
  description:
    'Add persistent defaults for transactional release resource limits',

  async plan(ctx) {
    return planFor(await inspectEnv(ctx));
  },

  async up(ctx) {
    const state = await inspectEnv(ctx);
    if (!state.envFile) {
      ctx.log('SKIP: panel .env not found; install.sh owns fresh defaults');
      return;
    }
    if (state.missing.length === 0) {
      ctx.log('OK: release transaction defaults already exist');
      return;
    }

    const separator =
      state.content.length === 0 || state.content.endsWith('\n') ? '' : '\n';
    const block = [
      '',
      '# --- Release transaction (added by system migration) ---',
      ...state.missing.flatMap(({ key, value, comment }) => [
        `# ${comment}`,
        `${key}=${value}`,
      ]),
      '',
    ].join('\n');
    await ctx.writeFile(state.envFile, `${state.content}${separator}${block}`);
    ctx.log(
      `OK: added ${state.missing.map(({ key }) => key).join(', ')} to ${state.envFile}`,
    );
  },
};

export default migration;
