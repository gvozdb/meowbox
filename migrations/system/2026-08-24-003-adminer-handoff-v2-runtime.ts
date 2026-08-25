import { createHash } from 'node:crypto';
import * as path from 'node:path';

import type {
  MigrationContext,
  MigrationPlan,
  SystemMigration,
} from './_types';

const MIGRATION_ID = '2026-08-24-003-adminer-handoff-v2-runtime';
const NGINX_CONFIG = '/etc/nginx/sites-available/meowbox-panel';
const ADMINER_SOCKET = '/run/php/meowbox-adminer.sock';
const PHP_VERSIONS = ['8.4', '8.3', '8.2', '8.1', '8.0', '7.4'] as const;
const MANAGED_FILES = [
  'index.php',
  'sso.php',
  'lib/sso.php',
  'lib/meowbox-plugin.php',
] as const;
const REQUIRED_NGINX_HEADERS = [
  '        add_header Referrer-Policy "no-referrer" always;',
  '        add_header Cache-Control "no-store" always;',
] as const;

interface RuntimeInspection {
  sourceDir: string;
  runtimeDir: string;
  envFile: string;
  sourceDigest: string;
  runtimeDigest: string | null;
  poolPaths: string[];
  nginxNeedsPatch: boolean;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function digestFiles(
  ctx: MigrationContext,
  root: string,
): Promise<string | null> {
  const parts: string[] = [];
  for (const relative of MANAGED_FILES) {
    const file = path.join(root, relative);
    if (!(await ctx.exists(file))) return null;
    parts.push(relative, await ctx.readFile(file));
  }
  return sha256(parts.join('\0'));
}

async function resolveSourceDir(ctx: MigrationContext): Promise<string> {
  const direct = path.join(ctx.config.currentDir, 'tools', 'adminer-src');
  if (await ctx.exists(direct)) return direct;
  throw new Error(`Adminer v2 source is missing: ${direct}`);
}

function decodeAdminerKey(content: string): Buffer {
  const match = content.match(/^\s*ADMINER_SSO_KEY\s*=\s*"?([A-Za-z0-9+/=]+)"?\s*$/m);
  if (!match) throw new Error('ADMINER_SSO_KEY is missing from state/.env');
  const key = Buffer.from(match[1], 'base64');
  if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== match[1].replace(/=+$/, '')) {
    throw new Error('ADMINER_SSO_KEY in state/.env is invalid');
  }
  return key;
}

function patchNginxAdminerHeaders(content: string): string {
  const adminerStart = content.indexOf('location ^~ /adminer/ {');
  if (adminerStart < 0) throw new Error('Nginx Adminer location is missing');
  const locationEnd = content.indexOf('\n    # Web UI', adminerStart);
  if (locationEnd < 0) throw new Error('Nginx Adminer location boundary is unknown');
  const block = content.slice(adminerStart, locationEnd);
  let nextBlock = block;
  const anchor = '        add_header X-Frame-Options "SAMEORIGIN" always;';
  if (!nextBlock.includes(anchor)) throw new Error('Nginx Adminer security header anchor is missing');
  for (const required of REQUIRED_NGINX_HEADERS) {
    if (!nextBlock.includes(required)) nextBlock = nextBlock.replace(anchor, `${anchor}\n${required}`);
  }
  nextBlock = nextBlock.replace(
    'location ~ ^/adminer/(index|sso|adminer)\\.php$',
    'location ~ ^/adminer/(index|sso)\\.php$',
  );
  if (!nextBlock.includes('location = /adminer/adminer.php')) {
    const phpWrapperLocation = '        location ~ ^/adminer/(index|sso)\\.php$ {';
    if (!nextBlock.includes(phpWrapperLocation)) {
      throw new Error('Nginx Adminer PHP wrapper location is unknown');
    }
    nextBlock = nextBlock.replace(
      phpWrapperLocation,
      [
        '        location = /adminer/adminer.php {',
        '            return 404;',
        '        }',
        '',
        phpWrapperLocation,
      ].join('\n'),
    );
  }
  return `${content.slice(0, adminerStart)}${nextBlock}${content.slice(locationEnd)}`;
}

async function inspect(ctx: MigrationContext): Promise<RuntimeInspection> {
  const sourceDir = await resolveSourceDir(ctx);
  const runtimeDir = path.join(ctx.config.stateDir, 'adminer');
  const envFile = path.join(ctx.config.stateDir, '.env');
  const sourceDigest = await digestFiles(ctx, sourceDir);
  if (!sourceDigest) throw new Error('Adminer v2 source set is incomplete');
  if (!(await ctx.exists(path.join(runtimeDir, 'adminer.php')))) {
    throw new Error(`Adminer runtime binary is missing: ${path.join(runtimeDir, 'adminer.php')}`);
  }
  if (!(await ctx.exists(envFile))) throw new Error(`Panel env is missing: ${envFile}`);
  decodeAdminerKey(await ctx.readFile(envFile));
  const poolPaths: string[] = [];
  for (const version of PHP_VERSIONS) {
    const candidate = `/etc/php/${version}/fpm/pool.d/meowbox-adminer.conf`;
    if (await ctx.exists(candidate)) poolPaths.push(candidate);
  }
  if (poolPaths.length === 0) throw new Error('No meowbox-adminer PHP-FPM pool is installed');
  if (!(await ctx.exists(NGINX_CONFIG))) throw new Error(`Nginx panel config is missing: ${NGINX_CONFIG}`);
  const nginx = await ctx.readFile(NGINX_CONFIG);
  const patchedNginx = patchNginxAdminerHeaders(nginx);
  return {
    sourceDir,
    runtimeDir,
    envFile,
    sourceDigest,
    runtimeDigest: await digestFiles(ctx, runtimeDir),
    poolPaths,
    nginxNeedsPatch: patchedNginx !== nginx,
  };
}

function buildPlan(state: RuntimeInspection): MigrationPlan {
  return {
    summary:
      state.runtimeDigest === state.sourceDigest && !state.nginxNeedsPatch
        ? 'Adminer v2 runtime is synchronized; verify PHP-FPM key state'
        : 'Synchronize Adminer v2 runtime, PHP-FPM key state, and Nginx headers',
    fingerprint: sha256(JSON.stringify({
      sourceDigest: state.sourceDigest,
      runtimeDigest: state.runtimeDigest,
      pools: state.poolPaths.map((pool) => pool.split('/')[3]),
      nginxNeedsPatch: state.nginxNeedsPatch,
    })),
    details: {
      managedFiles: [...MANAGED_FILES],
      runtimeNeedsSync: state.runtimeDigest !== state.sourceDigest,
      poolCount: state.poolPaths.length,
      nginxNeedsPatch: state.nginxNeedsPatch,
    },
  };
}

function escapePoolValue(value: string): string {
  return value.replace(/[\\"$`]/g, '\\$&');
}

function syncPoolContent(content: string, envFile: string, key: string): string {
  const expectedKey = `env[ADMINER_SSO_KEY] = "${escapePoolValue(key)}"`;
  let next = content;
  if (/^env\[ADMINER_SSO_KEY\]\s*=.*$/m.test(next)) {
    next = next.replace(/^env\[ADMINER_SSO_KEY\]\s*=.*$/m, expectedKey);
  } else if (/^clear_env\s*=.*$/m.test(next)) {
    next = next.replace(/^clear_env\s*=.*$/m, `${expectedKey}\nclear_env = no`);
  } else {
    next = `${next.replace(/\n*$/, '')}\n${expectedKey}\nclear_env = no\n`;
  }
  next = next.replace(/^clear_env\s*=.*$/m, 'clear_env = no');
  const openBaseDir = /^php_admin_value\[open_basedir\]\s*=\s*(.+)$/m;
  const match = next.match(openBaseDir);
  if (!match) throw new Error('Adminer PHP-FPM pool lacks open_basedir');
  const paths = match[1].split(':').map((value) => value.trim()).filter(Boolean);
  if (!paths.includes(envFile)) paths.push(envFile);
  return next.replace(openBaseDir, `php_admin_value[open_basedir] = ${paths.join(':')}`);
}

async function validatePhpSources(ctx: MigrationContext, sourceDir: string): Promise<void> {
  for (const relative of MANAGED_FILES) {
    const result = await ctx.exec.run('php', ['-l', path.join(sourceDir, relative)]);
    if (!result.stdout.includes('No syntax errors detected')) {
      throw new Error(`PHP syntax validation failed for ${relative}`);
    }
  }
}

async function syncRuntime(
  ctx: MigrationContext,
  state: RuntimeInspection,
): Promise<boolean> {
  if (state.runtimeDigest === state.sourceDigest) return false;
  await ctx.exec.run('mkdir', ['-p', path.join(state.runtimeDir, 'lib')]);
  for (const relative of MANAGED_FILES) {
    await ctx.writeFile(
      path.join(state.runtimeDir, relative),
      await ctx.readFile(path.join(state.sourceDir, relative)),
    );
  }
  await ctx.exec.run('chown', ['-R', 'root:www-data', state.runtimeDir]);
  await ctx.exec.run('chmod', ['750', state.runtimeDir, path.join(state.runtimeDir, 'lib')]);
  for (const relative of MANAGED_FILES) {
    await ctx.exec.run('chmod', ['640', path.join(state.runtimeDir, relative)]);
  }
  if (await digestFiles(ctx, state.runtimeDir) !== state.sourceDigest) {
    throw new Error('Adminer runtime verification failed after synchronization');
  }
  return true;
}

async function syncPools(
  ctx: MigrationContext,
  state: RuntimeInspection,
): Promise<string[]> {
  const env = await ctx.readFile(state.envFile);
  decodeAdminerKey(env);
  const key = env.match(/^\s*ADMINER_SSO_KEY\s*=\s*"?([A-Za-z0-9+/=]+)"?\s*$/m)![1];
  const changedVersions: string[] = [];
  for (const poolPath of state.poolPaths) {
    const current = await ctx.readFile(poolPath);
    const next = syncPoolContent(current, state.envFile, key);
    if (next === current) continue;
    await ctx.writeFile(poolPath, next);
    changedVersions.push(poolPath.split('/')[3]);
  }
  return changedVersions;
}

async function syncNginx(ctx: MigrationContext): Promise<boolean> {
  const current = await ctx.readFile(NGINX_CONFIG);
  const next = patchNginxAdminerHeaders(current);
  if (next === current) return false;
  await ctx.writeFile(NGINX_CONFIG, next);
  try {
    await ctx.exec.run('nginx', ['-t']);
  } catch (error) {
    await ctx.writeFile(NGINX_CONFIG, current);
    throw new Error(`Nginx validation failed; previous config restored: ${(error as Error).message}`);
  }
  return true;
}

const migration: SystemMigration = {
  id: MIGRATION_ID,
  description: 'Synchronize Adminer v2 one-use handoff runtime, PHP-FPM key, and Nginx policy',

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
    await validatePhpSources(ctx, state.sourceDir);
    const runtimeChanged = await syncRuntime(ctx, state);
    const changedPhpVersions = await syncPools(ctx, state);
    const nginxChanged = await syncNginx(ctx);

    for (const version of new Set([
      ...changedPhpVersions,
      ...(runtimeChanged ? state.poolPaths.map((pool) => pool.split('/')[3]) : []),
    ])) {
      await ctx.exec.run('systemctl', ['restart', `php${version}-fpm.service`]);
    }
    if (nginxChanged) await ctx.exec.run('systemctl', ['reload', 'nginx']);
    if (!(await ctx.exists(ADMINER_SOCKET))) {
      throw new Error(`Adminer PHP-FPM socket is missing after synchronization: ${ADMINER_SOCKET}`);
    }
    const final = await inspect(ctx);
    if (
      final.runtimeDigest !== final.sourceDigest ||
      final.nginxNeedsPatch
    ) throw new Error('Adminer v2 runtime final verification failed');
    ctx.log('OK: Adminer v2 handoff runtime synchronized and legacy ticket endpoint disabled');
  },
};

export const __adminerHandoffRuntimeTest = {
  patchNginxAdminerHeaders,
  syncPoolContent,
};

export default migration;
