import { createHash } from 'node:crypto';

import {
  MINIO_CLIENT_BINARY,
  MINIO_ROOT_CREDENTIALS_PATH,
  MINIO_SERVER_BINARY,
  MINIO_SYSTEMD_UNIT,
  MINIO_SYSTEMD_UNIT_PATH,
  minioSystemdUnitContent,
} from '@meowbox/shared';

import type { MigrationContext, MigrationPlan, SystemMigration } from './_types';

const MIGRATION_ID = '2026-08-17-001-minio-shared-tenant-unit';

interface MinioRuntimeState {
  installed: boolean;
  serverBinary: boolean;
  clientBinary: boolean;
  rootCredentials: boolean;
  unit: 'missing' | 'current' | 'drifted';
}

async function inspect(ctx: MigrationContext): Promise<MinioRuntimeState> {
  const [record, serverBinary, clientBinary, rootCredentials, unitExists] = await Promise.all([
    ctx.prisma.serverService.findUnique({
      where: { serviceKey: 'minio' },
      select: { installed: true },
    }),
    ctx.exists(MINIO_SERVER_BINARY),
    ctx.exists(MINIO_CLIENT_BINARY),
    ctx.exists(MINIO_ROOT_CREDENTIALS_PATH),
    ctx.exists(MINIO_SYSTEMD_UNIT_PATH),
  ]);
  const expected = minioSystemdUnitContent();
  const unit = !unitExists
    ? 'missing'
    : (await ctx.readFile(MINIO_SYSTEMD_UNIT_PATH)) === expected
      ? 'current'
      : 'drifted';

  return {
    installed: record?.installed === true,
    serverBinary,
    clientBinary,
    rootCredentials,
    unit,
  };
}

function planFor(state: MinioRuntimeState): MigrationPlan {
  const ready = state.serverBinary && state.clientBinary && state.rootCredentials;
  const summary = !state.installed
    ? 'MinIO is not installed; no managed unit change is needed'
    : !ready
      ? 'MinIO installation is incomplete; leave its unit unchanged'
      : state.unit === 'current'
        ? 'MinIO shared tenant unit already matches the managed runtime'
        : 'Install the managed MinIO shared tenant systemd unit';
  return {
    summary,
    fingerprint: createHash('sha256')
      .update(JSON.stringify({ ...state, ready }))
      .digest('hex'),
    details: { ...state, ready },
  };
}

async function isActive(ctx: MigrationContext): Promise<boolean> {
  try {
    await ctx.exec.run('systemctl', ['is-active', '--quiet', MINIO_SYSTEMD_UNIT]);
    return true;
  } catch {
    return false;
  }
}

export function createMinioSharedTenantUnitMigration(): SystemMigration {
  return {
    id: MIGRATION_ID,
    description: 'Install the canonical shared MinIO tenant systemd unit',

    async plan(ctx) {
      return planFor(await inspect(ctx));
    },

    async up(ctx) {
      const state = await inspect(ctx);
      if (!state.installed) {
        ctx.log('SKIP: MinIO is not installed');
        return;
      }
      if (!state.serverBinary || !state.clientBinary || !state.rootCredentials) {
        ctx.log('WARN: MinIO installation is incomplete; managed unit was left unchanged');
        return;
      }
      if (state.unit === 'current') {
        ctx.log('OK: MinIO shared tenant unit already matches managed runtime');
        return;
      }
      if (ctx.dryRun) {
        ctx.log(`[dry-run] would write ${MINIO_SYSTEMD_UNIT_PATH} and reload systemd`);
        return;
      }

      const wasActive = await isActive(ctx);
      await ctx.writeFile(MINIO_SYSTEMD_UNIT_PATH, minioSystemdUnitContent(), 0o644);
      await ctx.exec.run('systemctl', ['daemon-reload']);
      if (wasActive) {
        await ctx.exec.run('systemctl', ['restart', MINIO_SYSTEMD_UNIT]);
      }
      ctx.log(`OK: installed canonical ${MINIO_SYSTEMD_UNIT}`);
    },
  };
}

const migration = createMinioSharedTenantUnitMigration();

export default migration;
