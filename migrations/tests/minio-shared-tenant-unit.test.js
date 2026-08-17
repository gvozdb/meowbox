'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MINIO_CLIENT_BINARY,
  MINIO_ROOT_CREDENTIALS_PATH,
  MINIO_SERVER_BINARY,
  MINIO_SYSTEMD_UNIT,
  MINIO_SYSTEMD_UNIT_PATH,
  minioSystemdUnitContent,
} = require('@meowbox/shared');
const {
  createMinioSharedTenantUnitMigration,
} = require('../dist/system/2026-08-17-001-minio-shared-tenant-unit');

function inactiveError() {
  const error = new Error('inactive');
  error.code = 3;
  return error;
}

function fixture({ installed = true, active = false, unit = 'old unit\n', rootCredentials = true } = {}) {
  const files = new Map([
    [MINIO_SERVER_BINARY, 'binary'],
    [MINIO_CLIENT_BINARY, 'binary'],
  ]);
  if (rootCredentials) files.set(MINIO_ROOT_CREDENTIALS_PATH, 'secret omitted');
  if (unit !== null) files.set(MINIO_SYSTEMD_UNIT_PATH, unit);
  const calls = [];
  const writes = [];
  const logs = [];
  return {
    calls,
    writes,
    logs,
    ctx: {
      dryRun: false,
      log: (message) => logs.push(message),
      prisma: {
        serverService: {
          findUnique: async () => (installed ? { installed: true } : null),
        },
      },
      exists: async (file) => files.has(file),
      readFile: async (file) => files.get(file),
      writeFile: async (file, content, mode) => {
        writes.push({ file, content, mode });
        files.set(file, content);
      },
      exec: {
        run: async (command, args) => {
          calls.push([command, args]);
          if (command === 'systemctl' && args[0] === 'is-active' && !active) {
            throw inactiveError();
          }
          return { stdout: '', stderr: '' };
        },
      },
    },
  };
}

test('migration replaces a drifted active MinIO unit then reloads and restarts it', async () => {
  const data = fixture({ active: true });
  const migration = createMinioSharedTenantUnitMigration();

  const plan = await migration.plan(data.ctx);
  assert.equal(plan.details.unit, 'drifted');
  assert.equal(plan.details.ready, true);

  await migration.up(data.ctx);

  assert.deepEqual(data.writes, [{
    file: MINIO_SYSTEMD_UNIT_PATH,
    content: minioSystemdUnitContent(),
    mode: 0o644,
  }]);
  assert.deepEqual(data.calls, [
    ['systemctl', ['is-active', '--quiet', MINIO_SYSTEMD_UNIT]],
    ['systemctl', ['daemon-reload']],
    ['systemctl', ['restart', MINIO_SYSTEMD_UNIT]],
  ]);

  await migration.up(data.ctx);
  assert.equal(data.writes.length, 1);
});

test('migration skips an uninstalled or incomplete MinIO runtime', async () => {
  const absent = fixture({ installed: false });
  const incomplete = fixture({ rootCredentials: false });
  const migration = createMinioSharedTenantUnitMigration();

  await migration.up(absent.ctx);
  await migration.up(incomplete.ctx);

  assert.deepEqual(absent.writes, []);
  assert.deepEqual(absent.calls, []);
  assert.deepEqual(incomplete.writes, []);
  assert.deepEqual(incomplete.calls, []);
});
