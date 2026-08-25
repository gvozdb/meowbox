'use strict';

const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const {
  __webhookRuntimeTest: helpers,
} = require('../dist/system/2026-08-25-002-webhook-runtime');

test('SYS-04 webhook env defaults are additive and idempotent', () => {
  const initial = 'PANEL_DOMAIN=panel.example\nWEBHOOK_QUEUE_LIMIT=250\n';
  const first = helpers.patchEnv(initial);
  const second = helpers.patchEnv(first);
  assert.equal(second, first);
  assert.match(first, /^WEBHOOK_QUEUE_LIMIT=250$/m);
  assert.equal((first.match(/^WEBHOOK_QUEUE_LIMIT=/gm) || []).length, 1);
  assert.match(first, /^WEBHOOK_WORKER_CONCURRENCY=4$/m);
  assert.match(first, /^WEBHOOK_SPOOL_RESERVE_BYTES=1073741824$/m);
  assert.match(first, /^WEBHOOK_SPOOL_RESERVE_PERCENT=10$/m);
  assert.match(first, /^WEBHOOK_DLQ_RETENTION_MS=604800000$/m);
});

test('SYS-03 webhook Nginx patch is bounded, no-log, and idempotent', () => {
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
  assert.match(first, /location \^~ \/api\/public\/v1\/webhooks\//);
  assert.match(first, /client_max_body_size 64k;/);
  assert.match(first, /client_body_buffer_size 64k;/);
  assert.match(first, /proxy_request_buffering on;/);
  assert.match(first, /proxy_connect_timeout 5s;/);
  assert.match(first, /proxy_read_timeout 15s;/);
  assert.match(first, /access_log off;/);
  assert.match(first, /error_log \/dev\/null crit;/);
  assert.doesNotMatch(first, /proxy_read_timeout 600s/);
  assert.throws(() => helpers.patchPanelNginx('server {}\n'), /anchor is missing/);
});

test('SYS-03/04 installer, Panel Access, schema, and spool layout agree', async () => {
  const root = path.resolve(__dirname, '..', '..');
  const [installer, panelAccess, schemaMigration] = await Promise.all([
    readFile(path.join(root, 'install.sh'), 'utf8'),
    readFile(path.join(root, 'agent/src/panel-access/panel-access.manager.ts'), 'utf8'),
    readFile(path.join(root, 'api/prisma/migrations/20260825083243_webhook_delivery/migration.sql'), 'utf8'),
  ]);
  for (const template of [installer, panelAccess]) {
    assert.match(template, /location \^~ \/api\/public\/v1\/webhooks\//);
    assert.match(template, /client_max_body_size 64k;/);
    assert.match(template, /proxy_request_buffering on;/);
    assert.match(template, /access_log off;/);
    assert.match(template, /error_log \/dev\/null crit;/);
  }
  assert.match(installer, /^WEBHOOK_QUEUE_LIMIT=1000$/m);
  assert.match(installer, /^WEBHOOK_WORKER_CONCURRENCY=4$/m);
  assert.match(installer, /^WEBHOOK_SPOOL_RESERVE_BYTES=1073741824$/m);
  assert.match(schemaMigration, /CREATE TABLE "webhook_routes"/);
  assert.match(schemaMigration, /CREATE TABLE "webhook_deliveries"/);
  assert.match(schemaMigration, /CREATE TABLE "webhook_delivery_receipts"/);
  assert.doesNotMatch(schemaMigration, /DROP TABLE|ALTER TABLE/);
  assert.deepEqual(
    helpers.spoolDirectories('/state'),
    [
      '/state/data/webhooks',
      '/state/data/webhooks/queue',
      '/state/data/webhooks/dlq',
      '/state/data/webhooks/tmp',
    ],
  );
});
