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
const { OperationsService } = require('../src/operations/operations.service');
const {
  OperationsWorkerService,
} = require('../src/operations/operations-worker.service');
const { OperationFailedError } = require('../src/operations/operation-errors');
const {
  RemoteOperationLinkService,
} = require('../src/operations/remote-operation-link.service');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-operations-'));
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
      username: `operations-${crypto.randomUUID()}`,
      email: `operations-${crypto.randomUUID()}@example.test`,
      passwordHash: 'not-used',
      identityKind: 'LOCAL',
      role: 'ADMIN',
    },
  });
  t.after(async () => {
    await prisma.$disconnect();
    if (previousMasterKey === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previousMasterKey;
    masterKey._resetMasterKeyCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { prisma, service: new OperationsService(prisma), user };
}

function queuedInput(userId, overrides = {}) {
  const idempotencyKey = overrides.idempotencyKey || `operation-${crypto.randomUUID()}`;
  const actionId = overrides.actionId || 'operations.test.execute';
  const retryable = overrides.retryable ?? false;
  const recoveryPolicy = overrides.recoveryPolicy || (retryable ? 'RETRY_SAFE' : 'RECONCILE_ONLY');
  return {
    idempotencyKey,
    type: 'WORKER_TEST',
    globalLockKey: overrides.globalLockKey || 'worker-test',
    userId,
    request: overrides.request || { value: 42 },
    queued: {
      actionId,
      policySnapshot: {
        actionId,
        schemaVersion: 1,
        actorKind: 'OPERATOR',
        issuerId: '11111111-2222-4333-8444-555555555555',
        subject: userId,
        role: 'ADMIN',
        permissions: ['operations.test'],
        idempotencyId: idempotencyKey,
        requestId: crypto.randomUUID(),
        recoveryPolicy,
        retryable,
      },
      recoveryPolicy,
      retryable,
      deadlineAt: new Date(Date.now() + 60_000),
      maxAttempts: retryable ? 3 : 1,
    },
  };
}

async function waitForStatus(prisma, id, expected, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await prisma.operation.findUnique({ where: { id } });
    if (row?.status === expected) return row;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const row = await prisma.operation.findUnique({ where: { id } });
  assert.fail(`operation ${id} stayed ${row?.status}, expected ${expected}`);
}

test('T-OPS-001 competing SQLite claims execute one operation once', async (t) => {
  const { prisma, service, user } = await fixture(t);
  const ticket = await service.begin(queuedInput(user.id));
  assert.equal(ticket.status, 'QUEUED');

  const claims = await Promise.all([
    service.claimNext('worker:first-instance'),
    service.claimNext('worker:second-instance'),
  ]);
  const claimed = claims.filter(Boolean);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].id, ticket.id);
  assert.deepEqual(claimed[0].request, { value: 42 });

  const owner = claims[0] ? 'worker:first-instance' : 'worker:second-instance';
  await service.startClaimed(ticket.id, owner, 'execute');
  assert.equal(await service.heartbeatClaim(ticket.id, owner, 'half', 50), true);
  await service.succeedClaimed(ticket.id, owner, { ok: true });
  const row = await prisma.operation.findUnique({ where: { id: ticket.id } });
  assert.equal(row.status, 'SUCCEEDED');
  assert.equal(row.attempt, 1);
  assert.equal(await prisma.operationLock.count(), 0);
});

test('T-OPS-002 worker runs registered handler with durable progress', async (t) => {
  const { prisma, service, user } = await fixture(t);
  const ticket = await service.begin(queuedInput(user.id, { globalLockKey: 'handler-test' }));
  const worker = new OperationsWorkerService(service);
  t.after(() => worker.onModuleDestroy());
  worker.registerHandler('operations.test.execute', async (request, context) => {
    assert.deepEqual(request, { value: 42 });
    await context.heartbeat('work', 60);
    await context.throwIfCancellationRequested();
    return { value: 84 };
  });

  await worker.pollOnce();
  const row = await waitForStatus(prisma, ticket.id, 'SUCCEEDED');
  assert.equal(row.progress, 100);
  assert.deepEqual(JSON.parse(row.result), { value: 84 });
  assert.equal(row.leaseOwner, null);
});

test('T-OPS-002 worker records a reconciled terminal failure and releases locks', async (t) => {
  const { prisma, service, user } = await fixture(t);
  const ticket = await service.begin(queuedInput(user.id, {
    globalLockKey: 'handler-safe-failure',
  }));
  const worker = new OperationsWorkerService(service);
  t.after(() => worker.onModuleDestroy());
  worker.registerHandler('operations.test.execute', async () => {
    throw new OperationFailedError('change failed and rollback was verified');
  });

  await worker.pollOnce();
  const row = await waitForStatus(prisma, ticket.id, 'FAILED');
  assert.match(row.errorMessage, /rollback was verified/);
  assert.equal(row.leaseOwner, null);
  assert.equal(await prisma.operationLock.count(), 0);
});

test('T-OPS-003 queued and running cancellation keep deterministic outcomes', async (t) => {
  const { prisma, service, user } = await fixture(t);
  const queued = await service.begin(queuedInput(user.id, { globalLockKey: 'cancel-queued' }));
  await service.requestCancellation(queued.id, user.id, 'ADMIN');
  let row = await prisma.operation.findUnique({ where: { id: queued.id } });
  assert.equal(row.status, 'CANCELLED');
  assert.equal(row.cancelOutcome, 'CANCELLED');

  const running = await service.begin(queuedInput(user.id, { globalLockKey: 'cancel-running' }));
  const claimed = await service.claimNext('worker:cancel-instance');
  assert.equal(claimed.id, running.id);
  await service.startClaimed(running.id, 'worker:cancel-instance', 'execute');
  await service.requestCancellation(running.id, user.id, 'ADMIN');
  row = await prisma.operation.findUnique({ where: { id: running.id } });
  assert.equal(row.status, 'CANCEL_REQUESTED');
  assert.equal(await service.isCancellationRequested(running.id, 'worker:cancel-instance'), true);
  await service.cancelClaimed(running.id, 'worker:cancel-instance');
  row = await prisma.operation.findUnique({ where: { id: running.id } });
  assert.equal(row.status, 'CANCELLED');
  assert.equal(await prisma.operationLock.count(), 0);
});

test('T-OPS-003 restart recovers queued work but keeps inline ambiguity locked', async (t) => {
  const { prisma, service, user } = await fixture(t);
  const queued = await service.begin(queuedInput(user.id, { globalLockKey: 'restart-queued' }));
  await service.claimNext('worker:restart-instance');
  await service.startClaimed(queued.id, 'worker:restart-instance', 'execute');

  const inline = await service.begin({
    idempotencyKey: `inline-${crypto.randomUUID()}`,
    type: 'INLINE_TEST',
    globalLockKey: 'restart-inline',
    userId: user.id,
    request: { value: 1 },
  });
  await service.start(inline.id, 'execute');

  await new OperationsService(prisma).onModuleInit();
  const recovered = await prisma.operation.findUnique({ where: { id: queued.id } });
  const attention = await prisma.operation.findUnique({ where: { id: inline.id } });
  assert.equal(recovered.status, 'RECOVERING');
  assert.equal(recovered.leaseOwner, null);
  assert.equal(attention.status, 'NEEDS_ATTENTION');
  assert.match(attention.errorMessage, /reconciliation/);
  assert.equal(await prisma.operationLock.count(), 2);
});

test('T-OPS-002 expired lease is atomically reclaimed through RECOVERING', async (t) => {
  const { prisma, service, user } = await fixture(t);
  const ticket = await service.begin(queuedInput(user.id, {
    globalLockKey: 'lease-reclaim',
    retryable: true,
  }));
  const first = await service.claimNext('worker:lease-first');
  assert.equal(first.id, ticket.id);
  assert.equal(first.attempt, 1);
  await service.startClaimed(ticket.id, 'worker:lease-first', 'execute');
  await prisma.operation.update({
    where: { id: ticket.id },
    data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
  });

  const reclaimed = await service.claimNext('worker:lease-second', new Date());
  assert.equal(reclaimed.id, ticket.id);
  assert.equal(reclaimed.recovering, true);
  assert.equal(reclaimed.attempt, 1);
  await service.startClaimed(ticket.id, 'worker:lease-second', 'reconcile');
  await service.succeedClaimed(ticket.id, 'worker:lease-second', { reconciled: true });
  assert.equal((await prisma.operation.findUnique({ where: { id: ticket.id } })).status, 'SUCCEEDED');
});

test('T-OPS-001 master link stores linkage only and rejects identity conflict', async (t) => {
  const { prisma, user } = await fixture(t);
  await prisma.remoteServer.create({
    data: {
      id: 'remote-link-target',
      installationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      displayName: 'Remote operation target',
    },
  });
  const links = new RemoteOperationLinkService(prisma);
  const input = {
    remoteServerId: 'remote-link-target',
    targetOperationId: crypto.randomUUID(),
    masterUserId: user.id,
    actionId: 'operations.test.execute',
    requestId: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
  };
  const first = await links.record(input);
  const replay = await links.record(input);
  assert.equal(replay.id, first.id);
  assert.deepEqual(
    Object.keys(first).sort(),
    [
      'actionId', 'correlationId', 'createdAt', 'id', 'lastPolledAt',
      'masterUserId', 'remoteServerId', 'requestId', 'targetOperationId',
      'updatedAt',
    ].sort(),
  );
  await assert.rejects(
    () => links.record({ ...input, requestId: crypto.randomUUID() }),
    /identity conflict/,
  );
  await links.touch(input.remoteServerId, input.targetOperationId);
  assert.equal(
    (await prisma.remoteOperationLink.findUnique({ where: { id: first.id } })).lastPolledAt instanceof Date,
    true,
  );
});
