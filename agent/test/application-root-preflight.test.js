'use strict';

const assert = require('node:assert/strict');
const {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const fixtureBase = mkdtempSync(
  path.join(tmpdir(), 'meowbox-root-preflight-'),
);
process.env.ALLOWED_SITE_ROOT_PREFIXES = fixtureBase;
process.env.BACKUP_LOCAL_PATH = path.join(fixtureBase, 'backups');

const {
  ApplicationSnapshotManager,
} = require('../src/runtime/application-snapshot.manager');
const { AgentService } = require('../src/agent.service');

test('non-empty roots require an explicit shared-root allowance', async (t) => {
  t.after(() => rmSync(fixtureBase, { recursive: true, force: true }));
  const siteRoot = path.join(fixtureBase, 'site');
  const applicationRoot = path.join(siteRoot, 'apps', 'monorepo');
  mkdirSync(applicationRoot, { recursive: true });
  writeFileSync(path.join(applicationRoot, 'package.json'), '{}', 'utf8');

  const manager = new ApplicationSnapshotManager();
  const blocked = await manager.preflightCreateRoot({
    rootPath: siteRoot,
    filesRelPath: 'apps/monorepo',
  });
  assert.equal(blocked.success, false);
  assert.match(blocked.error, /already exists and is not empty/);

  const shared = await manager.preflightCreateRoot({
    rootPath: siteRoot,
    filesRelPath: 'apps/monorepo',
    allowExistingRoot: true,
  });
  assert.equal(shared.success, true);
  assert.equal(shared.exists, true);
  assert.equal(shared.isNonEmpty, true);
  assert.equal(shared.applicationRoot, applicationRoot);
});

test('site install reuses a non-empty shared root without invoking an installer', async () => {
  const handlers = new Map();
  const preflightCalls = [];
  const service = Object.create(AgentService.prototype);
  service.socket = { connected: true };
  service.applicationSnapshots = {
    preflightCreateRoot: async (params) => {
      preflightCalls.push(params);
      return { success: true, exists: true, isNonEmpty: true };
    },
  };
  service.installer = {
    scaffoldCustomSite: async () => {
      throw new Error('shared application root must not be scaffolded');
    },
  };
  service.safeOn = (_socket, event, handler) => {
    if (event === 'site:install') handlers.set(event, handler);
  };
  service.registerHandlers();

  const replies = [];
  await handlers.get('site:install')(
    {
      siteId: '10000000-0000-4000-8000-000000000001',
      siteDomainId: '20000000-0000-4000-8000-000000000001',
      preset: 'CUSTOM',
      rootPath: '/var/www/site',
      filesRelPath: 'apps/monorepo',
      reuseExistingRoot: true,
      domain: 'admin.example.test',
      runtimeKey: 'd1234567890abcdef1234',
    },
    (reply) => replies.push(reply),
  );

  assert.deepEqual(preflightCalls, [
    {
      rootPath: '/var/www/site',
      filesRelPath: 'apps/monorepo',
      allowExistingRoot: true,
    },
  ]);
  assert.deepEqual(replies, [
    {
      success: true,
      data: { mutationStarted: false },
      siteDomainId: '20000000-0000-4000-8000-000000000001',
      operationId: undefined,
    },
  ]);
});

test('operation snapshot cleanup removes only directories owned by the exact operation UUID', async (t) => {
  const snapshotsRoot = path.join(fixtureBase, 'backups', 'operation-snapshots');
  mkdirSync(snapshotsRoot, { recursive: true });
  const operationId = '10000000-0000-4000-8000-000000000001';
  const domainId = '20000000-0000-4000-8000-000000000002';
  const owned = [
    operationId,
    `${operationId}-${domainId}`,
    `${operationId}-${domainId}.partial-123-456`,
    `${operationId}-${domainId}.partial-123-457.failed`,
    `${operationId}-${domainId}.failed`,
  ];
  const preserved = [
    '30000000-0000-4000-8000-000000000003',
    `${operationId}-not-a-domain-id`,
  ];
  for (const entry of [...owned, ...preserved]) {
    mkdirSync(path.join(snapshotsRoot, entry), { recursive: true });
    writeFileSync(path.join(snapshotsRoot, entry, 'payload'), 'x', 'utf8');
  }
  t.after(() => rmSync(fixtureBase, { recursive: true, force: true }));

  const manager = new ApplicationSnapshotManager();
  assert.deepEqual(
    await manager.cleanupOperationSnapshots(operationId),
    { success: true, removed: owned.length },
  );
  for (const entry of owned) {
    assert.equal(existsSync(path.join(snapshotsRoot, entry)), false);
  }
  for (const entry of preserved) {
    assert.equal(existsSync(path.join(snapshotsRoot, entry)), true);
  }
  assert.equal(
    (await manager.cleanupOperationSnapshots('../operation')).success,
    false,
  );
});

test('failed application snapshots remove their partial archive immediately', async (t) => {
  const siteRoot = path.join(fixtureBase, 'snapshot-site');
  const applicationRoot = path.join(siteRoot, 'www');
  mkdirSync(applicationRoot, { recursive: true });
  writeFileSync(path.join(applicationRoot, 'large.bin'), 'payload', 'utf8');
  t.after(() => rmSync(fixtureBase, { recursive: true, force: true }));

  const manager = new ApplicationSnapshotManager();
  manager.executor = {
    execute: async () => ({ stdout: '', stderr: 'forced failure', exitCode: 1 }),
  };
  const operationId =
    '40000000-0000-4000-8000-000000000004-50000000-0000-4000-8000-000000000005';
  const result = await manager.snapshot({
    operationId,
    siteName: 'snapshot-site',
    siteDomainId: '50000000-0000-4000-8000-000000000005',
    runtimeKey: 'd1234567890abcdef1234',
    rootPath: siteRoot,
    filesRelPath: 'www',
    databases: [],
  });

  assert.equal(result.success, false);
  assert.match(result.error, /forced failure/);
  const snapshotsRoot = path.join(fixtureBase, 'backups', 'operation-snapshots');
  assert.deepEqual(
    readdirSync(snapshotsRoot).filter((entry) => entry.startsWith(operationId)),
    [],
  );
});
