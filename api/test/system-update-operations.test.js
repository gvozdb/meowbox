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
const { SystemService } = require('../src/system/system.service');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-system-update-'));
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
      username: `system-update-${crypto.randomUUID()}`,
      email: `system-update-${crypto.randomUUID()}@example.test`,
      passwordHash: 'not-used',
      identityKind: 'LOCAL',
      role: 'ADMIN',
    },
  });
  const operations = new OperationsService(prisma);
  const worker = new OperationsWorkerService(operations);
  const admission = new OperationAdmissionService(operations, {
    getLocalIdentity: async () => ({
      installationId: '11111111-2222-4333-8444-555555555555',
    }),
  });
  t.after(async () => {
    worker.onModuleDestroy();
    await prisma.$disconnect();
    if (previousMasterKey === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previousMasterKey;
    masterKey._resetMasterKeyCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { prisma, user, operations, worker, admission };
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

test('T-OPS-004 update check/install/upgrade use durable AgentJobs under one apt lock', async (t) => {
  const { prisma, user, worker, admission } = await fixture(t);
  const calls = [];
  const agentRelay = {
    runAgentJob: async (input) => {
      calls.push(input);
      if (input.actionId.endsWith('.check')) {
        return { available: [], lastChecked: '2026-08-24T00:00:00.000Z' };
      }
      return { upgraded: input.payload.packages || ['all'], failed: [], output: 'done' };
    },
  };
  const system = new SystemService(prisma, agentRelay, admission, worker);
  system.onModuleInit();
  t.after(() => system.onModuleDestroy());
  const actor = { userId: user.id, role: 'ADMIN' };

  const acceptedCheck = await system.enqueueCheckUpdates(
    actor,
    `updates-check-${crypto.randomUUID()}`,
  );
  await worker.pollOnce();
  await waitForStatus(prisma, acceptedCheck.operationId, 'SUCCEEDED');

  const installKey = `updates-install-${crypto.randomUUID()}`;
  const acceptedInstall = await system.enqueueInstallUpdates(['nginx'], actor, installKey);
  const replay = await system.enqueueInstallUpdates(['nginx'], actor, installKey);
  assert.equal(replay.operationId, acceptedInstall.operationId);
  assert.equal(replay.replayed, true);
  await worker.pollOnce();
  const installRow = await waitForStatus(prisma, acceptedInstall.operationId, 'SUCCEEDED');
  assert.equal(installRow.globalLockKey, 'system:apt');

  const acceptedUpgrade = await system.enqueueUpgradeAll(
    actor,
    `updates-upgrade-${crypto.randomUUID()}`,
  );
  await worker.pollOnce();
  await waitForStatus(prisma, acceptedUpgrade.operationId, 'SUCCEEDED');

  assert.deepEqual(calls.map((call) => call.actionId), [
    'agent.system.updates.check',
    'agent.system.updates.install',
    'agent.system.updates.upgrade_all',
  ]);
  assert.ok(calls.every((call) => call.cancelSafe === false));
  assert.deepEqual(calls[1].payload, { packages: ['nginx'] });
});

test('T-OPS-006 ambiguous apt failure remains NEEDS_ATTENTION and retains lock', async (t) => {
  const { prisma, user, worker, admission } = await fixture(t);
  const system = new SystemService(
    prisma,
    { runAgentJob: async () => { throw new Error('agent disconnected'); } },
    admission,
    worker,
  );
  system.onModuleInit();
  t.after(() => system.onModuleDestroy());
  const accepted = await system.enqueueUpgradeAll(
    { userId: user.id, role: 'ADMIN' },
    `updates-ambiguous-${crypto.randomUUID()}`,
  );
  await worker.pollOnce();
  const row = await waitForStatus(prisma, accepted.operationId, 'NEEDS_ATTENTION');
  assert.equal(row.globalLockKey, 'system:apt');
  assert.match(row.errorMessage, /agent disconnected/);
});

test('T-OPS-004 system update operations require explicit idempotency', async (t) => {
  const { prisma, user, worker, admission } = await fixture(t);
  const system = new SystemService(
    prisma,
    { runAgentJob: async () => null },
    admission,
    worker,
  );
  system.onModuleInit();
  t.after(() => system.onModuleDestroy());
  await assert.rejects(
    () => system.enqueueCheckUpdates({ userId: user.id, role: 'ADMIN' }),
    /Idempotency-Key/,
  );
});
