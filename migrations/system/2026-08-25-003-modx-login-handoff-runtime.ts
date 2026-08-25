import { createHash } from 'node:crypto';

import type { MigrationContext, MigrationPlan, SystemMigration } from './_types';

const MIGRATION_ID = '2026-08-25-003-modx-login-handoff-runtime';
const NGINX_CONFIG = '/etc/nginx/sites-available/meowbox-panel';
const MODX_LOCATION = `    # MODX login handoff keeps its one-time secret in the URL fragment and
    # submits it in a bounded same-origin POST. Never log the consume route.
    location ^~ /api/public/v1/modx/login {
        client_max_body_size 4k;
        client_body_buffer_size 4k;
        proxy_pass http://meowbox_api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering on;
        proxy_connect_timeout 5s;
        proxy_read_timeout 15s;
        proxy_send_timeout 15s;
        add_header Cache-Control "no-store" always;
        add_header Referrer-Policy "no-referrer" always;
        access_log off;
        error_log /dev/null crit;
    }
`;

function blockBounds(content: string): { start: number; end: number } | null {
  const location = '    location ^~ /api/public/v1/modx/login {';
  const locationStart = content.indexOf(location);
  if (locationStart < 0) return null;
  const commentStart = content.lastIndexOf('    # MODX login handoff', locationStart);
  const start = commentStart >= 0 && content.slice(commentStart, locationStart).split('\n').length <= 3
    ? commentStart
    : locationStart;
  const blockEnd = content.indexOf('\n    }', locationStart);
  if (blockEnd < 0) throw new Error('Nginx MODX handoff location is truncated');
  return { start, end: blockEnd + '\n    }'.length };
}

function patchPanelNginx(content: string): string {
  const existing = blockBounds(content);
  if (existing) {
    return `${content.slice(0, existing.start)}${MODX_LOCATION.trimEnd()}${content.slice(existing.end)}`;
  }
  const anchor = '    # API proxy\n    location /api/ {';
  const index = content.indexOf(anchor);
  if (index < 0) throw new Error('Nginx generic API location anchor is missing');
  return `${content.slice(0, index)}${MODX_LOCATION}\n${content.slice(index)}`;
}

async function inspect(ctx: MigrationContext): Promise<{ needsPatch: boolean }> {
  if (!(await ctx.exists(NGINX_CONFIG))) {
    throw new Error(`Nginx panel config is missing: ${NGINX_CONFIG}`);
  }
  const current = await ctx.readFile(NGINX_CONFIG);
  return { needsPatch: patchPanelNginx(current) !== current };
}

function plan(state: { needsPatch: boolean }): MigrationPlan {
  return {
    summary: 'Install bounded no-log target-origin MODX handoff route',
    fingerprint: createHash('sha256').update(JSON.stringify(state)).digest('hex'),
    details: state,
  };
}

const migration: SystemMigration = {
  id: MIGRATION_ID,
  description: 'Install bounded no-log Nginx route for target-origin MODX handoff',

  async preflight(ctx) {
    try {
      await inspect(ctx);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
  },

  async plan(ctx) {
    return plan(await inspect(ctx));
  },

  async up(ctx) {
    const current = await ctx.readFile(NGINX_CONFIG);
    const next = patchPanelNginx(current);
    if (next === current) {
      ctx.log('OK: MODX handoff Nginx route already installed');
      return;
    }
    await ctx.writeFile(NGINX_CONFIG, next);
    try {
      await ctx.exec.run('nginx', ['-t']);
    } catch (error) {
      await ctx.writeFile(NGINX_CONFIG, current);
      throw new Error(`Nginx validation failed; previous config restored: ${(error as Error).message}`);
    }
    await ctx.exec.run('systemctl', ['reload', 'nginx']);
    if ((await inspect(ctx)).needsPatch) throw new Error('MODX handoff runtime verification failed');
    ctx.log('OK: bounded no-log MODX handoff route installed');
  },
};

export const __modxHandoffRuntimeTest = { patchPanelNginx };

export default migration;
