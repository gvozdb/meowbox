import { createHash } from 'node:crypto';
import * as path from 'node:path';

import type {
  MigrationContext,
  MigrationPlan,
  SystemMigration,
} from './_types';

const DEFAULTS = [
  ['FEDERATION_API_ORIGIN', ''],
  ['FEDERATION_WS_ORIGIN', ''],
  ['FEDERATION_BROWSER_PUBLIC_ORIGIN', ''],
  ['FEDERATION_DIRECT_TRANSFER_ORIGIN', ''],
  ['FEDERATION_WS_PATH', '/socket.io'],
] as const;

interface EnvState {
  envFile: string | null;
  content: string;
  missing: ReadonlyArray<(typeof DEFAULTS)[number]>;
}

function hasAssignment(content: string, key: string): boolean {
  return new RegExp(`^[ \\t]*${key}[ \\t]*=`, 'm').test(content);
}

async function inspectEnv(ctx: MigrationContext): Promise<EnvState> {
  const candidates = [
    path.join(ctx.config.stateDir, '.env'),
    path.join(ctx.config.panelDir, '.env'),
  ];
  const envFile = (
    await Promise.all(candidates.map(async (candidate) => ({
      candidate,
      exists: await ctx.exists(candidate),
    })))
  ).find(({ exists }) => exists)?.candidate ?? null;
  const content = envFile ? await ctx.readFile(envFile) : '';
  return {
    envFile,
    content,
    missing: DEFAULTS.filter(([key]) => !hasAssignment(content, key)),
  };
}

function buildPlan(state: EnvState): MigrationPlan {
  const missingKeys = state.missing.map(([key]) => key);
  return {
    summary: state.envFile
      ? missingKeys.length === 0
        ? 'Federation endpoint defaults are already configured'
        : 'Append disabled federation endpoint defaults to panel .env'
      : 'Panel .env is absent; installer owns federation endpoint defaults',
    fingerprint: createHash('sha256')
      .update(JSON.stringify({
        envFile: state.envFile ? path.basename(state.envFile) : null,
        missingKeys,
      }))
      .digest('hex'),
    details: { envFile: state.envFile, missingKeys },
  };
}

const migration: SystemMigration = {
  id: '2026-08-24-002-federation-endpoint-defaults',
  description: 'Add fail-closed federation public endpoint defaults',

  async plan(ctx) {
    return buildPlan(await inspectEnv(ctx));
  },

  async up(ctx) {
    const state = await inspectEnv(ctx);
    if (!state.envFile) {
      ctx.log('SKIP: panel .env not found; install.sh owns federation endpoint defaults');
      return;
    }
    if (state.missing.length === 0) {
      ctx.log('OK: federation endpoint defaults are already configured');
      return;
    }
    const separator =
      state.content.length === 0 || state.content.endsWith('\n') ? '' : '\n';
    const block = [
      '',
      '# --- Federation public endpoints (disabled until explicitly configured) ---',
      ...state.missing.map(([key, value]) => `${key}=${value}`),
      '',
    ].join('\n');
    await ctx.writeFile(state.envFile, `${state.content}${separator}${block}`);
    ctx.log(`OK: added ${state.missing.map(([key]) => key).join(', ')} to ${state.envFile}`);
  },
};

export default migration;
