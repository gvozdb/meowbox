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
const { PhpService } = require('../src/php/php.service');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-php-operation-'));
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
      username: `php-operation-${crypto.randomUUID()}`,
      email: `php-operation-${crypto.randomUUID()}@example.test`,
      passwordHash: 'not-used',
      identityKind: 'LOCAL',
      role: 'ADMIN',
    },
  });
  const operations = new OperationsService(prisma);
  const worker = new OperationsWorkerService(operations);
  const panelIdentity = {
    getLocalIdentity: async () => ({
      installationId: '11111111-2222-4333-8444-555555555555',
    }),
  };
  const admission = new OperationAdmissionService(operations, panelIdentity);
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

test('T-OPS-004 PHP install is accepted once and executed through durable AgentJob', async (t) => {
  const { prisma, user, worker, admission } = await fixture(t);
  const calls = [];
  const agentRelay = {
    runAgentJob: async (input) => {
      calls.push(input);
      return { installed: true };
    },
  };
  const php = new PhpService(agentRelay, admission, worker);
  php.onModuleInit();
  t.after(() => php.onModuleDestroy());
  const key = `php-install-${crypto.randomUUID()}`;
  const accepted = await php.enqueueInstallVersion(
    '8.4',
    { userId: user.id, role: 'ADMIN' },
    key,
  );
  const replay = await php.enqueueInstallVersion(
    '8.4',
    { userId: user.id, role: 'ADMIN' },
    key,
  );
  assert.equal(replay.operationId, accepted.operationId);
  assert.equal(replay.requestId, accepted.requestId);
  assert.equal(replay.replayed, true);

  await worker.pollOnce();
  const row = await waitForStatus(prisma, accepted.operationId, 'SUCCEEDED');
  assert.deepEqual(JSON.parse(row.result), { installed: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].actionId, 'agent.php.install');
  assert.equal(calls[0].cancelSafe, false);
  assert.deepEqual(calls[0].payload, { version: '8.4' });
});

test('T-OPS-004 PHP durable mutation requires explicit idempotency key', async (t) => {
  const { user, worker, admission } = await fixture(t);
  const php = new PhpService({ runAgentJob: async () => null }, admission, worker);
  php.onModuleInit();
  t.after(() => php.onModuleDestroy());
  await assert.rejects(
    () => php.enqueueInstallVersion('8.4', { userId: user.id, role: 'ADMIN' }),
    /Idempotency-Key/,
  );
});
