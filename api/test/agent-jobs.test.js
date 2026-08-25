'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PrismaClient } = require('@prisma/client');
const { AGENT_JOB_EVENTS } = require('@meowbox/shared');
const masterKey = require('../src/common/crypto/master-key');
const { AgentRelayService } = require('../src/gateway/agent-relay.service');
const { AgentJobService } = require('../src/operations/agent-job.service');
const { OperationsService } = require('../src/operations/operations.service');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-agent-job-'));
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
      username: `agent-job-${crypto.randomUUID()}`,
      email: `agent-job-${crypto.randomUUID()}@example.test`,
      passwordHash: 'not-used',
      identityKind: 'LOCAL',
      role: 'ADMIN',
    },
  });
  const operations = new OperationsService(prisma);
  const jobs = new AgentJobService(prisma);
  t.after(async () => {
    await prisma.$disconnect();
    if (previousMasterKey === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previousMasterKey;
    masterKey._resetMasterKeyCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { prisma, user, operations, jobs };
}

async function runningOperation(operations, userId, suffix = crypto.randomUUID()) {
  const idempotencyKey = `agent-job-${suffix}`;
  const ticket = await operations.begin({
    idempotencyKey,
    type: 'AGENT_JOB_TEST',
    globalLockKey: `agent-job:${suffix}`,
    userId,
    request: { value: 42 },
    queued: {
      actionId: 'operations.agent_job.test',
      policySnapshot: {
        actionId: 'operations.agent_job.test',
        schemaVersion: 1,
        actorKind: 'OPERATOR',
        issuerId: crypto.randomUUID(),
        subject: userId,
        role: 'ADMIN',
        permissions: ['operations.test'],
        idempotencyId: idempotencyKey,
        requestId: crypto.randomUUID(),
        recoveryPolicy: 'RECONCILE_ONLY',
        retryable: false,
      },
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      deadlineAt: new Date(Date.now() + 60_000),
      maxAttempts: 1,
    },
  });
  const workerId = `worker:${suffix}`;
  const claimed = await operations.claimNext(workerId);
  assert.equal(claimed.id, ticket.id);
  await operations.startClaimed(ticket.id, workerId, 'agent');
  return { id: ticket.id, workerId };
}

function prepareInput(operationId, overrides = {}) {
  return {
    operationId,
    actionId: 'agent.test.execute',
    step: 'execute',
    payload: { value: 42 },
    deadlineAt: new Date(Date.now() + 30_000),
    cancelSafe: true,
    ...overrides,
  };
}

test('T-OPS-004 durable AgentJob deduplicates identity and consumes monotonic events', async (t) => {
  const { prisma, user, operations, jobs } = await fixture(t);
  const operation = await runningOperation(operations, user.id);
  const input = prepareInput(operation.id);
  const first = await jobs.prepare(input);
  const replay = await jobs.prepare(input);
  assert.equal(replay.id, first.id);
  await assert.rejects(
    () => jobs.prepare({ ...input, payload: { value: 43 } }),
    /idempotency conflict/,
  );

  const bootId = crypto.randomUUID();
  await jobs.bindToBoot(first.id, bootId);
  await jobs.recordStarted({
    success: true,
    jobId: first.id,
    operationId: operation.id,
    bootId,
    state: 'RUNNING',
    replayed: false,
    error: null,
  });
  assert.equal(await jobs.recordHeartbeat({
    jobId: first.id,
    operationId: operation.id,
    bootId,
    sequence: 1,
    progress: 50,
    step: 'work',
    timestamp: new Date().toISOString(),
  }), true);
  assert.equal(await jobs.recordHeartbeat({
    jobId: first.id,
    operationId: operation.id,
    bootId,
    sequence: 1,
    progress: 60,
    step: 'stale',
    timestamp: new Date().toISOString(),
  }), false);
  assert.equal(await jobs.recordResult({
    jobId: first.id,
    operationId: operation.id,
    bootId,
    sequence: 2,
    success: true,
    cancelled: false,
    result: { ok: true },
    error: null,
    timestamp: new Date().toISOString(),
  }), true);
  const row = await prisma.agentJob.findUnique({ where: { id: first.id } });
  assert.equal(row.state, 'SUCCEEDED');
  assert.equal(row.progress, 100);
  assert.deepEqual((await jobs.get(first.id)).result, { ok: true });
});

test('T-OPS-006 new agent boot marks unknown running outcome for attention', async (t) => {
  const { user, operations, jobs } = await fixture(t);
  const operation = await runningOperation(operations, user.id);
  const job = await jobs.prepare(prepareInput(operation.id));
  const oldBoot = crypto.randomUUID();
  await jobs.bindToBoot(job.id, oldBoot);
  await jobs.recordStarted({
    success: true,
    jobId: job.id,
    operationId: operation.id,
    bootId: oldBoot,
    state: 'RUNNING',
    replayed: false,
    error: null,
  });
  assert.equal(await jobs.markInterruptedByNewBoot(crypto.randomUUID()), 1);
  assert.equal((await jobs.get(job.id)).state, 'NEEDS_ATTENTION');
});

test('T-OPS-004 relay executes one durable job and persists result', async (t) => {
  const { user, operations, jobs } = await fixture(t);
  const operation = await runningOperation(operations, user.id);
  const relay = new AgentRelayService(jobs);
  const socket = new EventEmitter();
  socket.connected = true;
  const bootId = crypto.randomUUID();
  socket.on(AGENT_JOB_EVENTS.START, (request, callback) => {
    callback({
      success: true,
      jobId: request.jobId,
      operationId: request.operationId,
      bootId,
      state: 'RUNNING',
      replayed: false,
      error: null,
    });
    setImmediate(() => socket.emit(AGENT_JOB_EVENTS.RESULT, {
      jobId: request.jobId,
      operationId: request.operationId,
      bootId,
      sequence: 1,
      success: true,
      cancelled: false,
      result: { relayed: true },
      error: null,
      timestamp: new Date().toISOString(),
    }));
  });
  relay.setAgentSocket(socket, bootId);
  assert.deepEqual(
    await relay.runAgentJob(prepareInput(operation.id)),
    { relayed: true },
  );
  relay.clearAgentSocket(socket);
});
