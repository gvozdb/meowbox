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
const { ServicesService } = require('../src/services/services.service');

async function fixture(t, runAgentJob) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-service-operation-'));
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
  const user = await prisma.user.create({
    data: {
      username: `service-operation-${crypto.randomUUID()}`,
      email: `service-operation-${crypto.randomUUID()}@example.test`,
      passwordHash: 'not-used',
      identityKind: 'LOCAL',
      role: 'ADMIN',
    },
  });
  const site = await prisma.site.create({
    data: {
      name: `svc${crypto.randomBytes(4).toString('hex')}`,
      rootPath: '/var/www/service-fixture',
      nginxConfigPath: '/etc/nginx/sites/service-fixture.conf',
      systemUser: 'svc_fixture',
      userId: user.id,
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
    isAgentConnected: () => false,
    runAgentJob: async (input) => {
      calls.push(input);
      return runAgentJob(input);
    },
  };
  const services = new ServicesService(prisma, agent, admission, worker);
  services.onModuleInit();
  t.after(async () => {
    services.onModuleDestroy();
    worker.onModuleDestroy();
    await prisma.$disconnect();
    if (previousMasterKey === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previousMasterKey;
    masterKey._resetMasterKeyCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { prisma, user, site, worker, services, calls };
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

test('T-OPS-004 service install and site lifecycle persist only after durable job result', async (t) => {
  const fixtureData = await fixture(t, async (input) => {
    if (input.actionId === 'agent.services.server.install') return { version: '7.2.4' };
    return null;
  });
  const { prisma, user, site, worker, services, calls } = fixtureData;
  const actor = { userId: user.id, role: 'ADMIN' };

  const install = await services.enqueueInstallServerService(
    'redis',
    actor,
    `service-install-${crypto.randomUUID()}`,
  );
  await worker.pollOnce();
  await waitForStatus(prisma, install.operationId, 'SUCCEEDED');
  const server = await prisma.serverService.findUnique({ where: { serviceKey: 'redis' } });
  assert.equal(server.installed, true);
  assert.equal(server.version, '7.2.4');

  const enableKey = `service-enable-${crypto.randomUUID()}`;
  const enable = await services.enqueueEnableSiteService(
    site.id,
    'redis',
    { memoryMaxMb: 128 },
    actor,
    enableKey,
  );
  const replay = await services.enqueueEnableSiteService(
    site.id,
    'redis',
    { memoryMaxMb: 128 },
    actor,
    enableKey,
  );
  assert.equal(replay.operationId, enable.operationId);
  assert.equal(replay.replayed, true);
  await worker.pollOnce();
  await waitForStatus(prisma, enable.operationId, 'SUCCEEDED');
  const enabled = await prisma.siteService.findUnique({
    where: { siteId_serviceKey: { siteId: site.id, serviceKey: 'redis' } },
  });
  assert.equal(enabled.status, 'RUNNING');
  assert.deepEqual(JSON.parse(enabled.config), { memoryMaxMb: 128 });

  const stop = await services.enqueueStopSiteService(
    site.id,
    'redis',
    actor,
    `service-stop-${crypto.randomUUID()}`,
  );
  await worker.pollOnce();
  await waitForStatus(prisma, stop.operationId, 'SUCCEEDED');
  assert.equal((await prisma.siteService.findUnique({ where: { id: enabled.id } })).status, 'STOPPED');

  assert.deepEqual(calls.map((call) => call.actionId), [
    'agent.services.server.install',
    'agent.services.site.enable',
    'agent.services.site.stop',
  ]);
  assert.ok(calls.every((call) => call.cancelSafe === false));
  assert.equal(calls[1].payload.site.id, site.id);
});

test('T-OPS-006 ambiguous service disable keeps target record and operation lock', async (t) => {
  const { prisma, user, site, worker, services } = await fixture(t, async () => {
    throw new Error('agent disconnected after command');
  });
  await prisma.serverService.create({
    data: { serviceKey: 'minio', installed: true, version: '1.0' },
  });
  const record = await prisma.siteService.create({
    data: { siteId: site.id, serviceKey: 'minio', status: 'RUNNING' },
  });
  const accepted = await services.enqueueDisableSiteService(
    site.id,
    'minio',
    { userId: user.id, role: 'ADMIN' },
    `service-disable-${crypto.randomUUID()}`,
  );
  await worker.pollOnce();
  const operation = await waitForStatus(prisma, accepted.operationId, 'NEEDS_ATTENTION');
  assert.equal(operation.siteId, site.id);
  assert.equal((await prisma.siteService.findUnique({ where: { id: record.id } })).status, 'ERROR');
  assert.equal(await prisma.operationLock.count({ where: { operationId: operation.id } }), 1);
});

test('T-OPS-005 service action rejects unsupported config before queue admission', async (t) => {
  const { prisma, user, site, services } = await fixture(t, async () => null);
  await prisma.serverService.create({
    data: { serviceKey: 'minio', installed: true, version: '1.0' },
  });
  await assert.rejects(
    () => services.enqueueEnableSiteService(
      site.id,
      'minio',
      { arbitrary: true },
      { userId: user.id, role: 'ADMIN' },
      `service-invalid-${crypto.randomUUID()}`,
    ),
    /invalid fields/,
  );
  assert.equal(await prisma.operation.count(), 0);
});
