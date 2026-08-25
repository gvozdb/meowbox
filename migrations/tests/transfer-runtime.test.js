'use strict';

const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const {
  __transferRuntimeTest: helpers,
} = require('../dist/system/2026-08-25-001-transfer-runtime');

test('SYS-04 transfer env defaults are additive and idempotent', () => {
  const initial = 'PANEL_DOMAIN=panel.example\nTRANSFER_ACTIVE_PER_ACTOR=7\n';
  const first = helpers.patchEnv(initial);
  const second = helpers.patchEnv(first);
  assert.equal(second, first);
  assert.match(first, /^TRANSFER_ACTIVE_PER_ACTOR=7$/m);
  assert.equal((first.match(/^TRANSFER_ACTIVE_PER_ACTOR=/gm) || []).length, 1);
  assert.match(first, /^TRANSFER_FIRST_BYTE_TTL_MS=900000$/m);
  assert.match(first, /^TRANSFER_GENERATED_STREAM_IDLE_MS=60000$/m);
  assert.match(first, /^TRANSFER_STAGED_LEASE_TTL_MS=14400000$/m);
  assert.match(first, /^TRANSFER_MAX_ARTIFACT_BYTES=53687091200$/m);
  assert.match(first, /^TRANSFER_DISK_RESERVE_BYTES=10737418240$/m);
  assert.match(first, /^TRANSFER_DISK_RESERVE_PERCENT=10$/m);
  assert.match(first, /^TRANSFER_RATE_LIMIT=20m$/m);
  assert.match(first, /^BACKUP_EXPORT_PRESIGNED_TTL_SEC=3600$/m);
  assert.match(first, /^BACKUP_EXPORT_STAGED_MAX_BYTES=53687091200$/m);
});

test('SYS-03 transfer Nginx patch is no-log, unbuffered, idle-based, and idempotent', () => {
  const initial = [
    'server {',
    '    # API proxy',
    '    location /api/ {',
    '        proxy_pass http://meowbox_api;',
    '    }',
    '}',
    '',
  ].join('\n');
  const first = helpers.patchPanelNginx(initial);
  const second = helpers.patchPanelNginx(first);
  assert.equal(second, first);
  assert.match(first, /location \^~ \/api\/public\/v1\/transfers\//);
  assert.match(first, /client_max_body_size 50g;/);
  assert.match(first, /client_body_timeout 60s;/);
  assert.match(first, /proxy_buffering off;/);
  assert.match(first, /proxy_request_buffering off;/);
  assert.match(first, /proxy_read_timeout 60s;/);
  assert.match(first, /send_timeout 60s;/);
  assert.match(first, /limit_rate 20m;/);
  assert.match(first, /access_log off;/);
  assert.match(first, /error_log \/dev\/null crit;/);
  assert.doesNotMatch(first, /proxy_read_timeout 600s/);
  assert.throws(() => helpers.patchPanelNginx('server {}\n'), /anchor is missing/);
});

test('SYS-03/04 installer, Panel Access, schema migration, and managed spool agree', async () => {
  const root = path.resolve(__dirname, '..', '..');
  const [installer, panelAccess, schemaMigration, stagedMigration] = await Promise.all([
    readFile(path.join(root, 'install.sh'), 'utf8'),
    readFile(path.join(root, 'agent/src/panel-access/panel-access.manager.ts'), 'utf8'),
    readFile(path.join(root, 'api/prisma/migrations/20260825065346_transfer_sessions/migration.sql'), 'utf8'),
    readFile(path.join(root, 'api/prisma/migrations/20260825073308_staged_backup_exports/migration.sql'), 'utf8'),
  ]);
  for (const template of [installer, panelAccess]) {
    assert.match(template, /location \^~ \/api\/public\/v1\/transfers\//);
    assert.match(template, /client_max_body_size 50g;/);
    assert.match(template, /client_body_timeout 60s;/);
    assert.match(template, /proxy_buffering off;/);
    assert.match(template, /access_log off;/);
    assert.match(template, /error_log \/dev\/null crit;/);
    assert.match(template, /proxy_read_timeout 60s;/);
  }
  assert.match(installer, /^TRANSFER_FIRST_BYTE_TTL_MS=900000$/m);
  assert.match(installer, /^TRANSFER_GENERATED_STREAM_IDLE_MS=60000$/m);
  assert.match(installer, /^TRANSFER_STAGED_LEASE_TTL_MS=14400000$/m);
  assert.match(schemaMigration, /CREATE TABLE "transfer_artifacts"/);
  assert.match(schemaMigration, /CREATE TABLE "transfer_sessions"/);
  assert.match(stagedMigration, /ALTER TABLE "backup_exports" ADD COLUMN "operation_id"/);
  assert.match(stagedMigration, /ALTER TABLE "backup_exports" ADD COLUMN "artifact_id"/);
  assert.doesNotMatch(stagedMigration, /DROP TABLE|new_backup_exports/);
  assert.deepEqual(
    helpers.spoolDirectories('/state'),
    ['/state/data/transfers', '/state/data/transfers/artifacts', '/state/data/transfers/tmp'],
  );
});
