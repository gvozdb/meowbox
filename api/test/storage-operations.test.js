'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PrismaClient } = require('@prisma/client');
const masterKey = require('../src/common/crypto/master-key');
const {
  OperationAdmissionService,
} = require('../src/operations/operation-admission.service');
const { OperationsService } = require('../src/operations/operations.service');
const {
  OperationsWorkerService,
} = require('../src/operations/operations-worker.service');
const {
  StorageLocationsService,
} = require('../src/storage-locations/storage-locations.service');
const { StorageService } = require('../src/storage/storage.service');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-storage-operation-'));
  const databaseUrl = `file:${path.join(root, 'fixture.db')}`;
  execFileSync(path.resolve(__dirname, '../node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'ignore',
  });
  const previousMasterKey = process.env.MEOWBOX_MASTER_KEY;
  process.env.MEOWBOX_MASTER_KEY = crypto.randomBytes(32).toString('base64');
  masterKey._resetMasterKeyCacheForTests();
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = crypto.randomBytes(5).toString('hex');
  const user = await prisma.user.create({
    data: {
      username: `storage-${suffix}`,
      email: `storage-${suffix}@example.test`,
      passwordHash: 'not-used',
      identityKind: 'LOCAL',
      role: 'ADMIN',
    },
  });
  const site = await prisma.site.create({
    data: {
      name: `storage${suffix}`,
      rootPath: `/var/www/storage${suffix}`,
      nginxConfigPath: `/etc/nginx/sites/storage${suffix}.conf`,
      systemUser: `st${suffix}`,
      userId: user.id,
    },
  });
  await prisma.siteDomain.create({
    data: {
      siteId: site.id,
      domain: `${suffix}.example.test`,
      isPrimary: true,
      filesRelPath: 'www',
      preset: 'CUSTOM',
      runtimeKey: `storage_${suffix}`,
    },
  });
  const location = await prisma.storageLocation.create({
    data: {
      name: `storage-${suffix}`,
      type: 'LOCAL',
      config: JSON.stringify({ basePath: '/srv/backups' }),
      resticEnabled: true,
      resticPassword: 'fixture-restic-secret',
    },
  });
  const operations = new OperationsService(prisma);
  const worker = new OperationsWorkerService(operations);
  const admission = new OperationAdmissionService(operations, {
    getLocalIdentity: async () => ({
      installationId: '11111111-2222-4333-8444-555555555555',
    }),
  });
  const calls = [];
  const agent = {
    isAgentConnected: () => true,
    runAgentJob: async (input) => {
      calls.push(input);
      if (input.actionId === 'agent.storage.top_files') {
        return [{ path: `${site.rootPath}/www/index.php`, size: 4096 }];
      }
      return null;
    },
  };
  const locations = new StorageLocationsService(prisma, agent, admission, worker);
  const storage = new StorageService(prisma, agent, admission, worker);
  locations.onModuleInit();
  storage.onModuleInit();
  t.after(async () => {
    locations.onModuleDestroy();
    storage.onModuleDestroy();
    worker.onModuleDestroy();
    await prisma.$disconnect();
    if (previousMasterKey === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previousMasterKey;
    masterKey._resetMasterKeyCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { calls, location, locations, prisma, site, storage, user, worker };
}

async function waitForStatus(prisma, operationId, expected) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const row = await prisma.operation.findUnique({ where: { id: operationId } });
    if (row?.status === expected) return row;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`operation ${operationId} did not reach ${expected}`);
}

test('T-OPS-004 storage connection test keeps credentials out of durable metadata', async (t) => {
  const state = await fixture(t);
  const key = `storage-test-${crypto.randomUUID()}`;
  const accepted = await state.locations.enqueueTest(
    state.location.id,
    '_connection-test_',
    { userId: state.user.id, role: 'ADMIN' },
    key,
  );
  const replay = await state.locations.enqueueTest(
    state.location.id,
    '_connection-test_',
    { userId: state.user.id, role: 'ADMIN' },
    key,
  );
  assert.equal(replay.operationId, accepted.operationId);
  assert.equal(replay.replayed, true);
  const admitted = await state.prisma.operation.findUnique({ where: { id: accepted.operationId } });
  assert.equal(JSON.stringify(admitted).includes('fixture-restic-secret'), false);

  await state.worker.pollOnce();
  await waitForStatus(state.prisma, accepted.operationId, 'SUCCEEDED');
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].actionId, 'agent.storage.restic_test');
  assert.equal(state.calls[0].payload.storage.password, 'fixture-restic-secret');
  const job = await state.prisma.agentJob.findFirst({ where: { operationId: accepted.operationId } });
  assert.equal(JSON.stringify(job).includes('fixture-restic-secret'), false);
});

test('T-OPS-004 top-files scan is owner-scoped and returns bounded durable results', async (t) => {
  const state = await fixture(t);
  await assert.rejects(
    () => state.storage.enqueueSiteTopFilesScan(
      state.site.id,
      { userId: crypto.randomUUID(), role: 'MANAGER' },
      `storage-denied-${crypto.randomUUID()}`,
    ),
    /Forbidden/,
  );
  const accepted = await state.storage.enqueueSiteTopFilesScan(
    state.site.id,
    { userId: state.user.id, role: 'MANAGER' },
    `storage-scan-${crypto.randomUUID()}`,
  );
  await state.worker.pollOnce();
  const row = await waitForStatus(state.prisma, accepted.operationId, 'SUCCEEDED');
  assert.deepEqual(JSON.parse(row.result), [{
    path: `${state.site.rootPath}/www/index.php`,
    size: 4096,
  }]);
  assert.equal(state.calls[0].actionId, 'agent.storage.top_files');
  assert.deepEqual(state.calls[0].payload.filesRelPaths, ['www']);
  assert.equal(state.calls[0].cancelSafe, false);
});
