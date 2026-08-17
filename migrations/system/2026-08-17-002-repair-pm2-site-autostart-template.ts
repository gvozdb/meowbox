import { createHash } from 'node:crypto';

import {
  PM2_SITE_AUTOSTART_PM2_CANDIDATES,
  PM2_SITE_AUTOSTART_UNIT_PATH,
  pm2SiteAutostartUnitContent,
} from '@meowbox/shared';

import type { MigrationContext, MigrationPlan, SystemMigration } from './_types';

const MIGRATION_ID = '2026-08-17-002-repair-pm2-site-autostart-template';
const SYSTEMCTL_CANDIDATES = ['/usr/bin/systemctl', '/bin/systemctl'];

type UnitState = 'missing' | 'current' | 'drifted' | 'unavailable';

interface Pm2SiteAutostartState {
  systemctl: boolean;
  pm2Bin: string | null;
  unit: UnitState;
}

function safeExecutablePath(value: string): string | null {
  const trimmed = value.trim().split('\n')[0] || '';
  if (!trimmed || !trimmed.startsWith('/') || /[\0\r\n\t ]/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

async function hasCommand(ctx: MigrationContext, command: string): Promise<boolean> {
  try {
    await ctx.exec.run('which', [command]);
    return true;
  } catch {
    return false;
  }
}

async function findPm2Candidate(ctx: MigrationContext): Promise<string | null> {
  for (const candidate of PM2_SITE_AUTOSTART_PM2_CANDIDATES) {
    if (await ctx.exists(candidate)) return candidate;
  }
  return null;
}

async function findPm2(ctx: MigrationContext): Promise<string | null> {
  const candidate = await findPm2Candidate(ctx);
  if (candidate) return candidate;
  try {
    const result = await ctx.exec.run('which', ['pm2']);
    return safeExecutablePath(result.stdout);
  } catch {
    return null;
  }
}

async function hasSystemctlFile(ctx: MigrationContext): Promise<boolean> {
  for (const candidate of SYSTEMCTL_CANDIDATES) {
    if (await ctx.exists(candidate)) return true;
  }
  return false;
}

async function inspectUnit(
  ctx: MigrationContext,
  systemctl: boolean,
  pm2Bin: string | null,
): Promise<Pm2SiteAutostartState> {
  if (!pm2Bin) {
    return { systemctl, pm2Bin: null, unit: 'unavailable' };
  }

  const desired = pm2SiteAutostartUnitContent(pm2Bin, ctx.config.sitesBasePath);
  const unit = !(await ctx.exists(PM2_SITE_AUTOSTART_UNIT_PATH))
    ? 'missing'
    : (await ctx.readFile(PM2_SITE_AUTOSTART_UNIT_PATH)) === desired
      ? 'current'
      : 'drifted';
  return { systemctl, pm2Bin, unit };
}

/** Only filesystem reads: valid in runner's zero-write release plan. */
async function inspectPlan(ctx: MigrationContext): Promise<Pm2SiteAutostartState> {
  const [systemctl, pm2Bin] = await Promise.all([
    hasSystemctlFile(ctx),
    findPm2Candidate(ctx),
  ]);
  return inspectUnit(ctx, systemctl, pm2Bin);
}

async function inspectRuntime(ctx: MigrationContext): Promise<Pm2SiteAutostartState> {
  const [systemctl, pm2Bin] = await Promise.all([
    hasCommand(ctx, 'systemctl'),
    findPm2(ctx),
  ]);
  return inspectUnit(ctx, systemctl, pm2Bin);
}

function planFor(state: Pm2SiteAutostartState): MigrationPlan {
  const summary = !state.systemctl
    ? 'systemd is unavailable; leave PM2 site autostart template unchanged'
    : !state.pm2Bin
      ? 'PM2 is unavailable; leave PM2 site autostart template unchanged'
      : state.unit === 'current'
        ? 'PM2 site autostart template already matches managed runtime'
        : 'Install the canonical PM2 site autostart systemd template';
  return {
    summary,
    fingerprint: createHash('sha256').update(JSON.stringify(state)).digest('hex'),
    details: { ...state },
  };
}

export function createPm2SiteAutostartTemplateMigration(): SystemMigration {
  return {
    id: MIGRATION_ID,
    description: 'Install the canonical PM2 site autostart systemd template',

    async plan(ctx) {
      return planFor(await inspectPlan(ctx));
    },

    async up(ctx) {
      const state = await inspectRuntime(ctx);
      if (!state.systemctl) {
        ctx.log('WARN: systemctl is unavailable; PM2 site autostart is not configured');
        return;
      }
      if (!state.pm2Bin) {
        ctx.log('WARN: PM2 binary is unavailable; PM2 site autostart is not configured');
        return;
      }
      if (state.unit === 'current') {
        ctx.log(`OK: ${PM2_SITE_AUTOSTART_UNIT_PATH} already matches managed runtime`);
        return;
      }
      if (ctx.dryRun) {
        ctx.log(`[dry-run] would write ${PM2_SITE_AUTOSTART_UNIT_PATH} and reload systemd`);
        return;
      }

      await ctx.writeFile(
        PM2_SITE_AUTOSTART_UNIT_PATH,
        pm2SiteAutostartUnitContent(state.pm2Bin, ctx.config.sitesBasePath),
        0o644,
      );
      await ctx.exec.run('systemctl', ['daemon-reload']);
      ctx.log(`OK: installed canonical ${PM2_SITE_AUTOSTART_UNIT_PATH}`);
    },
  };
}

const migration = createPm2SiteAutostartTemplateMigration();

export default migration;
