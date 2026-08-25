import { createHash } from 'node:crypto';
import { chmod, chown, mkdir, stat } from 'node:fs/promises';
import * as path from 'node:path';

import type { MigrationContext, MigrationPlan, SystemMigration } from './_types';

const MIGRATION_ID = '2026-08-25-001-transfer-runtime';
const NGINX_CONFIG = '/etc/nginx/sites-available/meowbox-panel';
const ENV_DEFAULTS = [
  ['TRANSFER_FIRST_BYTE_TTL_MS', '900000'],
  ['TRANSFER_GENERATED_STREAM_IDLE_MS', '60000'],
  ['TRANSFER_STAGED_LEASE_TTL_MS', '14400000'],
  ['TRANSFER_MAX_ARTIFACT_BYTES', '53687091200'],
  ['TRANSFER_DISK_RESERVE_BYTES', '10737418240'],
  ['TRANSFER_DISK_RESERVE_PERCENT', '10'],
  ['TRANSFER_RATE_LIMIT', '20m'],
  ['TRANSFER_NEW_PER_MINUTE_PER_ACTOR', '5'],
  ['TRANSFER_ACTIVE_PER_ACTOR', '2'],
  ['TRANSFER_ACTIVE_PER_TARGET', '4'],
  ['BACKUP_EXPORT_PRESIGNED_TTL_SEC', '3600'],
  ['BACKUP_EXPORT_STAGED_MAX_BYTES', '53687091200'],
] as const;

const TRANSFER_LOCATION = `    # Direct generated/staged transfer delivery. Timeouts are inactivity
    # budgets; a progressing stream has no total Nginx deadline.
    location ^~ /api/public/v1/transfers/ {
        client_max_body_size 50g;
        client_body_timeout 60s;
        proxy_pass http://meowbox_api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_max_temp_file_size 0;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
        send_timeout 60s;
        limit_rate 20m;
        add_header Cache-Control "no-store" always;
        add_header Referrer-Policy "no-referrer" always;
        access_log off;
        error_log /dev/null crit;
    }
`;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function patchEnv(content: string): string {
  const missing = ENV_DEFAULTS.filter(([key]) => !new RegExp(`^${key}=`, 'm').test(content));
  if (missing.length === 0) return content;
  return [
    content.replace(/\s*$/, ''),
    '',
    '# Direct transfer budgets (managed by system migration)',
    ...missing.map(([key, value]) => `${key}=${value}`),
    '',
  ].join('\n');
}

function transferBlockBounds(content: string): { start: number; end: number } | null {
  const location = '    location ^~ /api/public/v1/transfers/ {';
  const locationStart = content.indexOf(location);
  if (locationStart < 0) return null;
  const commentStart = content.lastIndexOf('    # Direct generated/staged transfer delivery.', locationStart);
  const start = commentStart >= 0 && content.slice(commentStart, locationStart).split('\n').length <= 3
    ? commentStart
    : locationStart;
  const blockEnd = content.indexOf('\n    }', locationStart);
  if (blockEnd < 0) throw new Error('Nginx transfer location is truncated');
  return { start, end: blockEnd + '\n    }'.length };
}

function patchPanelNginx(content: string): string {
  const existing = transferBlockBounds(content);
  if (existing) {
    return `${content.slice(0, existing.start)}${TRANSFER_LOCATION.trimEnd()}${content.slice(existing.end)}`;
  }
  const anchor = '    # API proxy\n    location /api/ {';
  const index = content.indexOf(anchor);
  if (index < 0) throw new Error('Nginx generic API location anchor is missing');
  return `${content.slice(0, index)}${TRANSFER_LOCATION}\n${content.slice(index)}`;
}

function spoolDirectories(stateDir: string): string[] {
  const root = path.join(stateDir, 'data', 'transfers');
  return [root, path.join(root, 'artifacts'), path.join(root, 'tmp')];
}

interface Inspection {
  envFile: string;
  nginxNeedsPatch: boolean;
  missingEnvKeys: string[];
  missingDirectories: string[];
}

async function inspect(ctx: MigrationContext): Promise<Inspection> {
  const envFile = path.join(ctx.config.stateDir, '.env');
  const dataDir = path.join(ctx.config.stateDir, 'data');
  if (!(await ctx.exists(envFile))) throw new Error(`Panel env is missing: ${envFile}`);
  if (!(await ctx.exists(dataDir))) throw new Error(`Panel data directory is missing: ${dataDir}`);
  if (!(await ctx.exists(NGINX_CONFIG))) throw new Error(`Nginx panel config is missing: ${NGINX_CONFIG}`);
  const env = await ctx.readFile(envFile);
  const nginx = await ctx.readFile(NGINX_CONFIG);
  const missingDirectories: string[] = [];
  for (const directory of spoolDirectories(ctx.config.stateDir)) {
    if (!(await ctx.exists(directory))) missingDirectories.push(directory);
  }
  return {
    envFile,
    nginxNeedsPatch: patchPanelNginx(nginx) !== nginx,
    missingEnvKeys: ENV_DEFAULTS.filter(([key]) => !new RegExp(`^${key}=`, 'm').test(env)).map(([key]) => key),
    missingDirectories,
  };
}

function buildPlan(state: Inspection): MigrationPlan {
  return {
    summary: 'Install direct-transfer spool, budgets, and Nginx streaming route',
    fingerprint: sha256(JSON.stringify({
      nginxNeedsPatch: state.nginxNeedsPatch,
      missingEnvKeys: state.missingEnvKeys,
      missingDirectoryNames: state.missingDirectories.map((value) => path.basename(value)),
    })),
    details: {
      nginxNeedsPatch: state.nginxNeedsPatch,
      missingEnvKeys: state.missingEnvKeys,
      missingDirectoryCount: state.missingDirectories.length,
    },
  };
}

async function ensureSpool(ctx: MigrationContext): Promise<void> {
  const reference = await stat(path.join(ctx.config.stateDir, 'data'));
  for (const directory of spoolDirectories(ctx.config.stateDir)) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const current = await stat(directory);
    if (current.uid !== reference.uid || current.gid !== reference.gid) {
      await chown(directory, reference.uid, reference.gid);
    }
    await chmod(directory, 0o700);
  }
}

async function syncNginx(ctx: MigrationContext): Promise<boolean> {
  const current = await ctx.readFile(NGINX_CONFIG);
  const next = patchPanelNginx(current);
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
  description: 'Install secure transfer spool, env budgets, and idle-timeout Nginx route',

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
    await ensureSpool(ctx);
    const env = await ctx.readFile(state.envFile);
    const nextEnv = patchEnv(env);
    if (nextEnv !== env) await ctx.writeFile(state.envFile, nextEnv);
    await chmod(state.envFile, 0o600);
    const nginxChanged = await syncNginx(ctx);
    if (nginxChanged) await ctx.exec.run('systemctl', ['reload', 'nginx']);

    const final = await inspect(ctx);
    if (final.nginxNeedsPatch || final.missingEnvKeys.length || final.missingDirectories.length) {
      throw new Error('Transfer runtime final verification failed');
    }
    ctx.log('OK: direct transfer runtime installed with no-store/no-log streaming route');
  },
};

export const __transferRuntimeTest = {
  patchEnv,
  patchPanelNginx,
  spoolDirectories,
};

export default migration;
