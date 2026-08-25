import { createHash } from 'node:crypto';
import * as path from 'node:path';

import type {
  MigrationContext,
  MigrationPlan,
  SystemMigration,
} from './_types';

const ENV_KEY = 'PRISMA_LOG_QUERIES';
const ENV_VALUE = 'false';

interface EnvState {
  envFile: string | null;
  content: string;
  configured: boolean;
}

function hasAssignment(content: string): boolean {
  return new RegExp(`^[ \\t]*${ENV_KEY}[ \\t]*=`, 'm').test(content);
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
  return { envFile, content, configured: hasAssignment(content) };
}

function planFor(state: EnvState): MigrationPlan {
  return {
    summary: state.envFile
      ? state.configured
        ? 'Prisma query logging default is already configured'
        : 'Append Prisma query logging default to panel .env'
      : 'Panel .env is absent; installation will provide Prisma query logging default',
    fingerprint: createHash('sha256')
      .update(
        JSON.stringify({
          envFile: state.envFile ? path.basename(state.envFile) : null,
          configured: state.configured,
        }),
      )
      .digest('hex'),
    details: {
      envFile: state.envFile,
      missingKeys: state.configured ? [] : [ENV_KEY],
    },
  };
}

const migration: SystemMigration = {
  id: '2026-08-20-001-prisma-query-logging-default',
  description: 'Disable Prisma SQL query stdout logging by default',

  async plan(ctx) {
    return planFor(await inspectEnv(ctx));
  },

  async up(ctx) {
    const state = await inspectEnv(ctx);
    if (!state.envFile) {
      ctx.log('SKIP: panel .env not found; install.sh owns PRISMA_LOG_QUERIES default');
      return;
    }
    if (state.configured) {
      ctx.log('OK: PRISMA_LOG_QUERIES is already configured');
      return;
    }

    const separator =
      state.content.length === 0 || state.content.endsWith('\n') ? '' : '\n';
    const block = [
      '',
      '# --- Prisma logging (added by system migration) ---',
      '# SQL query logging is disabled by default because it writes every query to PM2 stdout.',
      `${ENV_KEY}=${ENV_VALUE}`,
      '',
    ].join('\n');
    await ctx.writeFile(state.envFile, `${state.content}${separator}${block}`);
    ctx.log(`OK: added ${ENV_KEY}=${ENV_VALUE} to ${state.envFile}`);
  },
};

export default migration;
