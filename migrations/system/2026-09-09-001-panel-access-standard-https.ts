import { createHash } from 'node:crypto';
import * as path from 'node:path';

import type { MigrationContext, MigrationPlan, SystemMigration } from './_types';

const MIGRATION_ID = '2026-09-09-001-panel-access-standard-https';
const NGINX_CONFIG = '/etc/nginx/sites-available/meowbox-panel';
const CANDIDATE_CONFIG = '/etc/nginx/sites-available/meowbox-panel-candidate';
const CANDIDATE_LINK = '/etc/nginx/sites-enabled/meowbox-panel-candidate';
const ACME_CONFIG = '/etc/nginx/sites-available/meowbox-panel-acme';
const ACME_LINK = '/etc/nginx/sites-enabled/meowbox-panel-acme';
const DOMAIN = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
const LE_LOCATION = `    # Certificate issuance can legitimately outlive the generic API timeout.
    # The current TLS listener remains active for the whole request.
    location = /api/panel-access/cert/le {
        proxy_pass http://meowbox_api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 360s;
        proxy_send_timeout 360s;
    }
`;

interface PanelAccessState {
  domain: string | null;
  certMode: 'NONE' | 'SELFSIGNED' | 'LE';
  denyIpAccess: boolean;
}

interface Inspection {
  panelPort: number;
  settings: PanelAccessState;
  needsPatch: boolean;
}

function parsePanelPort(env: string): number {
  const match = /^PANEL_PORT=(?:"([^"]+)"|'([^']+)'|([^\s#]+))/m.exec(env);
  const value = Number(match?.[1] ?? match?.[2] ?? match?.[3] ?? '11862');
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new Error('PANEL_PORT is invalid');
  }
  return value;
}

function parsePanelAccess(raw: string | null): PanelAccessState {
  if (!raw) return { domain: null, certMode: 'NONE', denyIpAccess: false };
  const value = JSON.parse(raw) as Partial<PanelAccessState>;
  const domain = typeof value.domain === 'string' && value.domain ? value.domain : null;
  if (domain && !DOMAIN.test(domain)) throw new Error('Panel Access domain is invalid');
  if (!(['NONE', 'SELFSIGNED', 'LE'] as const).includes(value.certMode as PanelAccessState['certMode'])) {
    throw new Error('Panel Access certMode is invalid');
  }
  if (typeof value.denyIpAccess !== 'boolean') throw new Error('Panel Access denyIpAccess is invalid');
  return {
    domain,
    certMode: value.certMode as PanelAccessState['certMode'],
    denyIpAccess: value.denyIpAccess,
  };
}

function patchPanelNginx(
  content: string,
  settings: PanelAccessState,
  panelPort: number,
): string {
  if (!settings.domain || settings.certMode === 'NONE') return content;

  const securityMarker = '    # Security headers';
  const markerIndex = content.indexOf(securityMarker);
  if (markerIndex < 0 || content.indexOf(securityMarker, markerIndex + 1) >= 0) {
    throw new Error('Managed Panel Access Nginx server is missing or ambiguous');
  }
  const serverStart = content.lastIndexOf('\nserver {', markerIndex);
  if (serverStart < 0) throw new Error('Managed Panel Access Nginx server start is missing');
  const blockStart = serverStart + 1;
  let header = content.slice(blockStart, markerIndex);
  if (!header.includes(`server_name ${settings.domain}`) || !header.includes('    ssl_certificate ')) {
    throw new Error('Managed Panel Access Nginx state does not match the database');
  }

  const standardListeners = '    listen 443 ssl;\n    listen [::]:443 ssl;\n';
  if (!header.includes('    listen 443 ssl;')) {
    header = header.replace('server {\n', `server {\n${standardListeners}`);
  }
  if (settings.denyIpAccess && panelPort !== 443) {
    header = header
      .replace(`    listen ${panelPort} ssl;\n`, '')
      .replace(`    listen [::]:${panelPort} ssl;\n`, '');
  }

  let next = `${content.slice(0, blockStart)}${header}${content.slice(markerIndex)}`;
  next = next.replace(
    new RegExp(`return 301 https:\\/\\/\\$host:${panelPort}\\$request_uri;`, 'g'),
    'return 301 https://$host$request_uri;',
  );
  if (!next.includes('    location = /api/panel-access/cert/le {')) {
    const anchor = '    # API proxy\n    location /api/ {';
    const index = next.indexOf(anchor);
    if (index < 0) throw new Error('Managed Panel Access generic API location is missing');
    next = `${next.slice(0, index)}${LE_LOCATION}\n${next.slice(index)}`;
  }
  return next;
}

async function inspect(ctx: MigrationContext): Promise<Inspection> {
  const envFile = path.join(ctx.config.stateDir, '.env');
  if (!(await ctx.exists(envFile))) throw new Error(`Panel env is missing: ${envFile}`);
  if (!(await ctx.exists(NGINX_CONFIG))) throw new Error(`Nginx panel config is missing: ${NGINX_CONFIG}`);
  if (
    await ctx.exists(CANDIDATE_CONFIG) ||
    await ctx.exists(CANDIDATE_LINK) ||
    await ctx.exists(ACME_CONFIG) ||
    await ctx.exists(ACME_LINK)
  ) {
    throw new Error('Panel Access cutover is active; finish or roll it back before updating');
  }
  const row = await ctx.prisma.panelSetting.findUnique({
    where: { key: 'panel-access' },
    select: { value: true },
  });
  const settings = parsePanelAccess(row?.value ?? null);
  const panelPort = parsePanelPort(await ctx.readFile(envFile));
  const nginx = await ctx.readFile(NGINX_CONFIG);
  return {
    panelPort,
    settings,
    needsPatch: patchPanelNginx(nginx, settings, panelPort) !== nginx,
  };
}

function plan(state: Inspection): MigrationPlan {
  const details = {
    hasTlsDomain: !!state.settings.domain && state.settings.certMode !== 'NONE',
    denyIpAccess: state.settings.denyIpAccess,
    panelPort: state.panelPort,
    needsPatch: state.needsPatch,
  };
  return {
    summary: 'Expose the Panel Access TLS domain on standard HTTPS port 443',
    fingerprint: createHash('sha256').update(JSON.stringify(details)).digest('hex'),
    details,
  };
}

const migration: SystemMigration = {
  id: MIGRATION_ID,
  description: 'Expose Panel Access domains on HTTPS 443 and keep PANEL_PORT as optional recovery access',

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
    const state = await inspect(ctx);
    if (!state.needsPatch) {
      ctx.log('OK: Panel Access standard HTTPS listener already configured');
      return;
    }
    const current = await ctx.readFile(NGINX_CONFIG);
    const next = patchPanelNginx(current, state.settings, state.panelPort);
    await ctx.writeFile(NGINX_CONFIG, next, 0o644);
    try {
      await ctx.exec.run('nginx', ['-t']);
      await ctx.exec.run('systemctl', ['reload', 'nginx']);
    } catch (error) {
      await ctx.writeFile(NGINX_CONFIG, current, 0o644);
      await ctx.exec.run('nginx', ['-t']);
      await ctx.exec.run('systemctl', ['reload', 'nginx']);
      throw new Error(`Panel Access HTTPS migration failed; previous config restored: ${(error as Error).message}`);
    }
    if ((await inspect(ctx)).needsPatch) throw new Error('Panel Access HTTPS migration verification failed');
    ctx.log('OK: Panel Access domain now listens on HTTPS 443');
  },
};

export const __panelAccessStandardHttpsTest = {
  parsePanelAccess,
  parsePanelPort,
  patchPanelNginx,
};

export default migration;
