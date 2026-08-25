'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('RPP-420 PHP mutations submit idempotent operations and wait for terminal state', () => {
  const source = read('pages/php.vue');
  assert.match(source, /useRemoteApi\(\)/);
  assert.equal((source.match(/operationIdempotencyKey\('php-/g) || []).length, 3);
  assert.equal((source.match(/waitForOperation\(accepted\.operationId/g) || []).length, 3);
});

test('RPP-420 system package actions are POST operations with explicit idempotency', () => {
  const source = read('pages/updates.vue');
  assert.match(source, /useRemoteApi\(\)/);
  assert.doesNotMatch(source, /api\.get<[^>]+>\('\/system\/updates\/check'/);
  for (const route of [
    '/system/updates/check',
    '/system/updates/install',
    '/system/updates/upgrade-all',
  ]) {
    assert.match(source, new RegExp(`api\\.post<AcceptedOperation>\\(\\s*['\"]${route.replaceAll('/', '\\/')}['\"]`));
  }
  assert.equal((source.match(/Idempotency-Key/g) || []).length, 3);
  assert.equal((source.match(/waitForOperation\(accepted\.operationId/g) || []).length, 3);
});

test('RPP-420 server and site service lifecycle waits for durable completion', () => {
  const server = read('pages/services.vue');
  const site = read('components/SiteServicesTab.vue');
  assert.match(server, /useRemoteApi\(\)/);
  assert.equal((server.match(/operationIdempotencyKey\('service-/g) || []).length, 3);
  assert.equal((server.match(/waitForOperation\(accepted\.operationId/g) || []).length, 3);
  assert.match(site, /useRemoteApi\(\)/);
  assert.equal((site.match(/operationIdempotencyKey\('site-service-/g) || []).length, 5);
  assert.equal((site.match(/waitForOperation\(accepted\.operationId/g) || []).length, 5);
});

test('RPP-420 SSL issue and revoke submit domain-scoped durable operations', () => {
  const source = read('components/SiteSslTab.vue');
  assert.match(source, /useRemoteApi\(\)/);
  assert.equal((source.match(/operationIdempotencyKey\('ssl-(?:issue|revoke)'\)/g) || []).length, 2);
  assert.equal((source.match(/waitForOperation\(accepted\.operationId/g) || []).length, 2);
  assert.match(source, /\/ssl\/issue/);
  assert.match(source, /\/revoke/);
});

test('RPP-420 country database refresh waits for one idempotent durable operation', () => {
  const source = read('pages/settings.vue');
  assert.match(source, /api\.post<AcceptedOperation>\(\s*['"]\/country-block\/refresh-db['"]/);
  assert.match(source, /operationIdempotencyKey\('country-block-refresh'\)/);
  assert.match(source, /waitForOperation\(accepted\.operationId/);
});

test('RPP-420 storage tests and scans use durable operations without synchronous GET scans', () => {
  const storage = read('pages/storage.vue');
  const locations = read('pages/backup-storages.vue');
  assert.doesNotMatch(storage, /api\.get<TopFile\[\]>\(`\/storage\/\$\{siteId\}\/top-files`/);
  assert.match(storage, /api\.post<AcceptedOperation>\([\s\S]*\/top-files\/scan/);
  assert.match(storage, /operationIdempotencyKey\('storage-top-files'\)/);
  assert.match(storage, /waitForOperation\(accepted\.operationId/);
  assert.match(locations, /api\.post<AcceptedOperation>\([\s\S]*\/storage-locations\/\$\{loc\.id\}\/test/);
  assert.match(locations, /operationIdempotencyKey\('storage-location-test'\)/);
  assert.match(locations, /waitForOperation\(accepted\.operationId/);
});

test('RPP-420 Node quick commands use a bounded durable operation result', () => {
  const source = read('components/SiteQuickAccess.vue');
  assert.match(source, /useRemoteApi\(\)/);
  assert.match(source, /api\.post<AcceptedOperation>\([\s\S]*quick-commands\/\$\{cmd\.id\}\/run/);
  assert.match(source, /operationIdempotencyKey\('node-quick-command'\)/);
  assert.match(source, /waitForOperation\(accepted\.operationId/);
  assert.match(source, /requireQuickCommandResult\(operation\.result\)/);
  assert.match(source, /Вывод обрезан по безопасному лимиту/);
});

test('RPP-420 MODX doctor and maintenance wait for durable AgentJobs', () => {
  const source = read('pages/sites/[id].vue');
  assert.match(source, /modx\/doctor\/scan/);
  assert.doesNotMatch(source, /api\.get<DoctorResult>\(`\$\{selectedDomainApi\.value\}\/modx\/doctor`\)/);
  assert.match(source, /operationIdempotencyKey|domainMutationKey\('modx-doctor'\)/);
  assert.equal((source.match(/waitForOperation\(accepted\.operationId/g) || []).length >= 4, true);
  assert.match(source, /domainMutationKey\('permissions'\)/);
  assert.match(source, /domainMutationKey\('modx-cleanup'\)/);
  assert.match(source, /requireDoctorResult\(operation\.result\)/);
});

test('RPP-420 MODX update waits for verified durable completion', () => {
  const source = read('pages/sites/[id].vue');
  assert.match(source, /api\.post<AcceptedOperation>\([\s\S]*modx\/update/);
  assert.match(source, /domainMutationKey\('modx-update'\)/);
  assert.match(source, /timeoutMs: 46 \* 60_000/);
  assert.match(source, /requireModxUpdateResult\(operation\.result\)/);
});

test('RPP-420 VPN runtime install and uninstall wait for durable completion', () => {
  const source = read('pages/vpn.vue');
  assert.match(source, /api\.post<AcceptedOperation>\([\s\S]*\/vpn\/install\/\$\{protocol\}/);
  assert.match(source, /api\.del<AcceptedOperation>\([\s\S]*\/vpn\/install\/\$\{protocol\}/);
  assert.equal((source.match(/operationIdempotencyKey\('vpn-runtime-/g) || []).length, 2);
  assert.equal((source.match(/waitForOperation\(accepted\.operationId/g) || []).length >= 2, true);
});

test('RPP-420 Restic list, tree, and diff wait for durable query operations', () => {
  const source = read('pages/sites/[id].vue');
  assert.doesNotMatch(source, /restic-snapshots\?locationId=/);
  assert.doesNotMatch(source, /api\.get<\{ items: RestoreTreeItem\[\] \}>/);
  assert.match(source, /\/restic-snapshots\/query/);
  assert.match(source, /\/tree\/query/);
  for (const prefix of [
    'restic-snapshots',
    'restic-backup-tree',
    'restic-diff-live',
    'restic-diff-snapshots',
    'restic-diff-file-live',
    'restic-diff-file',
  ]) {
    assert.match(source, new RegExp(`['"]${prefix}['"]`));
  }
  assert.match(source, /api\.post<AcceptedOperation>/);
  assert.match(source, /waitForOperation\(accepted\.operationId/);
});

test('RPP-420 hostpanel force cleanup completes durably before retry starts', () => {
  const source = read('pages/admin/migrate-hostpanel/index.vue');
  assert.match(source, /api\.post<AcceptedOperation>\([\s\S]*\/force-retry/);
  assert.match(source, /operationIdempotencyKey\('hostpanel-force-cleanup'\)/);
  assert.match(source, /waitForOperation\(accepted\.operationId, \{ timeoutMs: 6 \* 60_000 \}\)/);
  assert.match(source, /await startRetryItem\(item\)/);
});

test('RPP-420 database deletion waits for durable snapshot and rollback-aware completion', () => {
  for (const file of ['components/SiteDatabasesTab.vue', 'pages/databases.vue']) {
    const source = read(file);
    assert.match(source, /useRemoteApi\(\)/);
    assert.match(source, /api\.del<AcceptedOperation>/);
    assert.match(source, /operationIdempotencyKey\('database-delete'\)/);
    assert.match(source, /waitForOperation\(accepted\.operationId, \{ timeoutMs: 46 \* 60_000 \}\)/);
  }
});

test('RPP-420 database export and import use durable operations around direct transfer sessions', () => {
  const source = read('composables/useDatabaseTransfer.ts');
  assert.match(source, /operationIdempotencyKey\('database-export'\)/);
  assert.match(source, /operationIdempotencyKey\('database-import-upload'\)/);
  assert.match(source, /operationIdempotencyKey\('database-import'\)/);
  assert.equal((source.match(/waitForOperation\(accepted\.operationId/g) || []).length, 2);
  assert.equal((source.match(/timeoutMs: DATABASE_OPERATION_TIMEOUT_MS/g) || []).length, 2);
  assert.match(source, /captureSelectedTargetContext\(\)/);
  assert.match(source, /assertSelectedTargetContextCurrent\(context\)/);
  assert.match(source, /\.sql\.gz/);
});
