import { createHash } from 'node:crypto';
import * as path from 'node:path';

import type {
  MigrationContext,
  MigrationPlan,
  SystemMigration,
} from './_types';

const MIGRATION_ID = '2026-09-09-002-adminer-http-handoff-runtime';
const SOURCE_RELATIVE_PATH = 'tools/adminer-src/lib/sso.php';
const RUNTIME_RELATIVE_PATH = 'adminer/lib/sso.php';
const ADMINER_SOCKET = '/run/php/meowbox-adminer.sock';
const PHP_VERSIONS = ['8.4', '8.3', '8.2', '8.1', '8.0', '7.4'] as const;

interface RuntimeInspection {
  sourcePath: string;
  runtimePath: string;
  sourceContent: string;
  sourceDigest: string;
  runtimeDigest: string | null;
  poolPaths: string[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertDualCookieRuntime(source: string): void {
  if (
    !source.includes("const MEOWBOX_SECURE_COOKIE_NAME = '__Secure-meowbox_adminer_session';") ||
    !source.includes("const MEOWBOX_HTTP_COOKIE_NAME = 'meowbox_adminer_session';")
  ) {
    throw new Error('Adminer HTTP handoff source lacks the dual-cookie contract');
  }
}

async function inspect(ctx: MigrationContext): Promise<RuntimeInspection> {
  const sourcePath = path.join(ctx.config.currentDir, SOURCE_RELATIVE_PATH);
  const runtimePath = path.join(ctx.config.stateDir, RUNTIME_RELATIVE_PATH);
  if (!(await ctx.exists(sourcePath))) {
    throw new Error(`Adminer HTTP handoff source is missing: ${sourcePath}`);
  }
  if (!(await ctx.exists(path.join(ctx.config.stateDir, 'adminer', 'adminer.php')))) {
    throw new Error('Adminer runtime binary is missing');
  }
  const sourceContent = await ctx.readFile(sourcePath);
  assertDualCookieRuntime(sourceContent);

  const poolPaths: string[] = [];
  for (const version of PHP_VERSIONS) {
    const candidate = `/etc/php/${version}/fpm/pool.d/meowbox-adminer.conf`;
    if (await ctx.exists(candidate)) poolPaths.push(candidate);
  }
  if (poolPaths.length === 0) {
    throw new Error('No meowbox-adminer PHP-FPM pool is installed');
  }

  return {
    sourcePath,
    runtimePath,
    sourceContent,
    sourceDigest: sha256(sourceContent),
    runtimeDigest: await ctx.exists(runtimePath)
      ? sha256(await ctx.readFile(runtimePath))
      : null,
    poolPaths,
  };
}

function buildPlan(state: RuntimeInspection): MigrationPlan {
  return {
    summary: state.runtimeDigest === state.sourceDigest
      ? 'Verify the Adminer HTTP/HTTPS handoff runtime and restart its PHP-FPM pool'
      : 'Synchronize the Adminer HTTP/HTTPS handoff runtime and restart its PHP-FPM pool',
    fingerprint: sha256(JSON.stringify({
      sourceDigest: state.sourceDigest,
      runtimeDigest: state.runtimeDigest,
      phpVersions: state.poolPaths.map((pool) => pool.split('/')[3]),
    })),
    details: {
      runtimeNeedsSync: state.runtimeDigest !== state.sourceDigest,
      phpVersions: state.poolPaths.map((pool) => pool.split('/')[3]),
    },
  };
}

const migration: SystemMigration = {
  id: MIGRATION_ID,
  description: 'Enable encrypted Adminer handoff sessions on HTTP and HTTPS panel origins',

  async preflight(ctx) {
    try {
      await inspect(ctx);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
  },

  async plan(ctx) {
    return buildPlan(await inspect(ctx));
  },

  async up(ctx) {
    const state = await inspect(ctx);
    const syntax = await ctx.exec.run('php', ['-l', state.sourcePath]);
    if (!syntax.stdout.includes('No syntax errors detected')) {
      throw new Error('Adminer HTTP handoff PHP syntax validation failed');
    }

    await ctx.exec.run('mkdir', ['-p', path.dirname(state.runtimePath)]);
    if (state.runtimeDigest !== state.sourceDigest) {
      await ctx.writeFile(state.runtimePath, state.sourceContent, 0o640);
    }
    await ctx.exec.run('chown', ['root:www-data', state.runtimePath]);
    await ctx.exec.run('chmod', ['640', state.runtimePath]);

    if (
      !(await ctx.exists(state.runtimePath)) ||
      sha256(await ctx.readFile(state.runtimePath)) !== state.sourceDigest
    ) {
      throw new Error('Adminer HTTP handoff runtime verification failed');
    }

    for (const poolPath of state.poolPaths) {
      const version = poolPath.split('/')[3];
      await ctx.exec.run('systemctl', ['restart', `php${version}-fpm.service`]);
    }
    if (!(await ctx.exists(ADMINER_SOCKET))) {
      throw new Error(`Adminer PHP-FPM socket is missing after restart: ${ADMINER_SOCKET}`);
    }
    ctx.log('OK: Adminer HTTP/HTTPS handoff runtime synchronized');
  },
};

export default migration;
