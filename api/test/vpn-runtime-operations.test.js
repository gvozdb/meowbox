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
const { VpnProtocol } = require('@meowbox/shared');
const masterKey = require('../src/common/crypto/master-key');
const { OperationAdmissionService } = require('../src/operations/operation-admission.service');
const { OperationsService } = require('../src/operations/operations.service');
const { OperationsWorkerService } = require('../src/operations/operations-worker.service');
const { VpnService } = require('../src/vpn/vpn.service');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-vpn-runtime-'));
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
      username: `vpn-${crypto.randomUUID()}`,
      email: `vpn-${crypto.randomUUID()}@example.test`,
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
  const calls = [];
  const relay = {
    isAgentConnected: () => true,
    runAgentJob: async (input) => {
      calls.push(input);
      if (input.actionId.includes('.install_')) {
        return { installed: true, version: '1.2.3' };
      }
      if (input.actionId.includes('.uninstall_')) {
        return { uninstalled: true };
      }
      throw new Error(`unexpected action ${input.actionId}`);
    },
  };
  const service = new VpnService(
    prisma,
    relay,
    {},
    {},
    {},
    {},
    admission,
    worker,
  );
  await service.onModuleInit();
  t.after(async () => {
    service.onModuleDestroy();
    worker.onModuleDestroy();
    await prisma.$disconnect();
    if (previousMasterKey === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previousMasterKey;
    masterKey._resetMasterKeyCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { calls, prisma, service, user, worker };
}

async function complete(worker, prisma, operationId) {
  await worker.pollOnce();
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const row = await prisma.operation.findUnique({ where: { id: operationId } });
    if (row?.status === 'SUCCEEDED') return JSON.parse(row.result);
    if (['FAILED', 'NEEDS_ATTENTION'].includes(row?.status)) {
      assert.fail(`operation ${operationId} ended in ${row.status}: ${row.errorMessage}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`operation ${operationId} did not complete`);
}

test('T-OPS-004 VPN runtime install and uninstall use durable AgentJobs', async (t) => {
  const state = await fixture(t);
  const installKey = `vpn-runtime-install-${crypto.randomUUID()}`;
  const install = await state.service.installRuntime(
    VpnProtocol.VLESS_REALITY,
    state.user.id,
    'ADMIN',
    installKey,
  );
  const replay = await state.service.installRuntime(
    VpnProtocol.VLESS_REALITY,
    state.user.id,
    'ADMIN',
    installKey,
  );
  assert.equal(replay.operationId, install.operationId);
  assert.equal(replay.replayed, true);
  assert.deepEqual(
    await complete(state.worker, state.prisma, install.operationId),
    { installed: true, version: '1.2.3' },
  );

  const uninstall = await state.service.uninstallRuntime(
    VpnProtocol.AMNEZIA_WG,
    state.user.id,
    'ADMIN',
    `vpn-runtime-uninstall-${crypto.randomUUID()}`,
  );
  assert.deepEqual(
    await complete(state.worker, state.prisma, uninstall.operationId),
    { uninstalled: true },
  );
  assert.deepEqual(state.calls.map((call) => call.actionId), [
    'agent.vpn.runtime.install_xray',
    'agent.vpn.runtime.uninstall_amnezia',
  ]);
  assert.equal(state.calls.every((call) => call.cancelSafe === false), true);
});

test('T-OPS-004 VPN SNI health check uses retry-safe durable admission', async (t) => {
  const state = await fixture(t);
  const key = `vpn-sni-health-${crypto.randomUUID()}`;
  const accepted = await state.service.enqueueSniHealthCheck(
    state.user.id,
    'ADMIN',
    key,
  );
  const replay = await state.service.enqueueSniHealthCheck(
    state.user.id,
    'ADMIN',
    key,
  );
  assert.equal(replay.operationId, accepted.operationId);
  assert.equal(replay.replayed, true);
  const queued = await state.prisma.operation.findUnique({
    where: { id: accepted.operationId },
  });
  assert.equal(queued.actionId, 'vpn.sni_health_check');
  assert.equal(queued.recoveryPolicy, 'RETRY_SAFE');
  assert.equal(queued.retryable, true);
  assert.equal(queued.maxAttempts, 3);
  assert.equal(queued.globalLockKey, 'vpn:sni-health-check');
  assert.deepEqual(
    await complete(state.worker, state.prisma, accepted.operationId),
    { checked: 0, failed: 0 },
  );
});
