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
const { encryptJson } = require('../src/common/crypto/credentials-cipher');
const { DatabasesService } = require('../src/databases/databases.service');
const { DatabaseOperationsService } = require('../src/databases/database-operations.service');
const { OperationAdmissionService } = require('../src/operations/operation-admission.service');
const { OperationsService } = require('../src/operations/operations.service');
const { OperationsWorkerService } = require('../src/operations/operations-worker.service');

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-database-delete-'));
  const exportsDir = path.join(root, 'exports');
  fs.mkdirSync(exportsDir, { recursive: true });
  const databaseUrl = `file:${path.join(root, 'fixture.db')}`;
  execFileSync(path.resolve(__dirname, '../node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'ignore',
  });

  const previousMasterKey = process.env.MEOWBOX_MASTER_KEY;
  const previousExportsDir = process.env.DB_EXPORTS_DIR;
  process.env.MEOWBOX_MASTER_KEY = crypto.randomBytes(32).toString('base64');
  process.env.DB_EXPORTS_DIR = exportsDir;
  masterKey._resetMasterKeyCacheForTests();

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = crypto.randomBytes(5).toString('hex');
  const password = `database-secret-${suffix}`;
  const user = await prisma.user.create({
    data: {
      username: `database-${suffix}`,
      email: `database-${suffix}@example.test`,
      passwordHash: 'not-used',
      identityKind: 'LOCAL',
      role: 'ADMIN',
    },
  });
  const site = await prisma.site.create({
    data: {
      name: `db_${suffix}`,
      status: 'RUNNING',
      rootPath: `/fixture/${suffix}`,
      nginxConfigPath: `/fixture/${suffix}.conf`,
      userId: user.id,
    },
  });
  const domain = await prisma.siteDomain.create({
    data: {
      siteId: site.id,
      domain: `${suffix}.example.test`,
      isPrimary: true,
      filesRelPath: 'www',
      preset: 'CUSTOM',
      appStatus: 'RUNNING',
      runtimeKey: `runtime_${suffix}`,
    },
  });
  const database = await prisma.database.create({
    data: {
      name: `fixture_${suffix}`,
      type: 'MARIADB',
      dbUser: `user_${suffix}`,
      dbPasswordHash: 'not-used',
      dbPasswordEnc: encryptJson({ password }),
      siteId: site.id,
      siteDomainId: domain.id,
      purpose: 'AUXILIARY',
    },
  });
  const snapshotPath = path.join(exportsDir, `${database.name}.sql`);
  fs.writeFileSync(snapshotPath, 'fixture snapshot');

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
      const jobId = crypto
        .createHash('sha256')
        .update(`${input.operationId}:${input.step}`)
        .digest('hex');
      const requestHash = crypto
        .createHash('sha256')
        .update(`${input.actionId}:${input.step}`)
        .digest('hex');
      await prisma.agentJob.upsert({
        where: { id: jobId },
        create: {
          id: jobId,
          operationId: input.operationId,
          step: input.step,
          actionId: input.actionId,
          requestHash,
          state: 'RUNNING',
          cancelSafe: input.cancelSafe,
          deadlineAt: input.deadlineAt,
        },
        update: { state: 'RUNNING' },
      });
      if (options.failStep === input.step) {
        await prisma.agentJob.update({
          where: { id: jobId },
          data: {
            state: 'FAILED',
            errorMessage: `${input.step} failed`,
            completedAt: new Date(),
          },
        });
        throw new Error(`${input.step} failed`);
      }
      const result = input.step === 'snapshot' ? { filePath: snapshotPath } : null;
      await prisma.agentJob.update({
        where: { id: jobId },
        data: {
          state: 'SUCCEEDED',
          result: JSON.stringify(result),
          completedAt: new Date(),
        },
      });
      return result;
    },
  };
  const databases = new DatabasesService(
    prisma,
    relay,
    {},
    operations,
    {},
  );
  const operationPrisma = options.metadataDeleteFails
    ? {
        database: {
          findUnique: (args) => prisma.database.findUnique(args),
          delete: async () => {
            throw new Error('metadata commit failed');
          },
        },
        agentJob: {
          findUnique: (args) => prisma.agentJob.findUnique(args),
        },
      }
    : prisma;
  const service = new DatabaseOperationsService(
    operationPrisma,
    relay,
    databases,
    admission,
    worker,
  );
  service.onModuleInit();

  t.after(async () => {
    service.onModuleDestroy();
    worker.onModuleDestroy();
    databases.onModuleDestroy();
    await prisma.$disconnect();
    if (previousMasterKey === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previousMasterKey;
    if (previousExportsDir === undefined) delete process.env.DB_EXPORTS_DIR;
    else process.env.DB_EXPORTS_DIR = previousExportsDir;
    masterKey._resetMasterKeyCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });

  return {
    calls,
    database,
    domain,
    password,
    prisma,
    service,
    site,
    user,
    worker,
  };
}

async function terminal(state, operationId) {
  await state.worker.pollOnce();
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const operation = await state.prisma.operation.findUnique({
      where: { id: operationId },
    });
    if (['SUCCEEDED', 'FAILED', 'NEEDS_ATTENTION', 'CANCELLED'].includes(operation?.status)) {
      return operation;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`operation ${operationId} did not complete`);
}

async function enqueue(state, key) {
  return state.service.enqueueDelete(
    state.site.id,
    state.domain.id,
    state.database.id,
    { userId: state.user.id, role: 'ADMIN' },
    key,
  );
}

test('T-OPS-004 database deletion snapshots, drops, commits metadata, and replays admission', async (t) => {
  const state = await fixture(t);
  const key = `database-delete-${crypto.randomUUID()}`;
  const accepted = await enqueue(state, key);
  const replay = await enqueue(state, key);
  assert.equal(replay.operationId, accepted.operationId);
  assert.equal(replay.replayed, true);

  const operation = await terminal(state, accepted.operationId);
  assert.equal(operation.status, 'SUCCEEDED');
  assert.deepEqual(JSON.parse(operation.result), { databaseId: state.database.id });
  assert.equal(
    await state.prisma.database.findUnique({ where: { id: state.database.id } }),
    null,
  );
  assert.deepEqual(
    state.calls.map((call) => call.actionId),
    ['agent.database.export', 'agent.database.drop'],
  );
  const jobs = await state.prisma.agentJob.findMany({
    where: { operationId: accepted.operationId },
  });
  assert.equal(JSON.stringify(operation).includes(state.password), false);
  assert.equal(JSON.stringify(jobs).includes(state.password), false);
});

test('T-OPS-006 ambiguous physical drop fails closed and retains the database lock', async (t) => {
  const state = await fixture(t, { failStep: 'drop' });
  const accepted = await enqueue(state, `database-drop-unknown-${crypto.randomUUID()}`);
  const operation = await terminal(state, accepted.operationId);
  assert.equal(operation.status, 'NEEDS_ATTENTION');
  assert.match(operation.errorMessage, /reconcile the physical database/);
  assert.ok(await state.prisma.database.findUnique({ where: { id: state.database.id } }));
  assert.deepEqual(
    state.calls.map((call) => call.step),
    ['snapshot', 'drop'],
  );
  assert.ok(
    await state.prisma.operationLock.findFirst({
      where: { operationId: accepted.operationId },
    }),
  );
});

test('T-OPS-005 metadata failure recreates and restores the confirmed dropped database', async (t) => {
  const state = await fixture(t, { metadataDeleteFails: true });
  const accepted = await enqueue(state, `database-delete-rollback-${crypto.randomUUID()}`);
  const operation = await terminal(state, accepted.operationId);
  assert.equal(operation.status, 'FAILED');
  assert.match(operation.errorMessage, /metadata commit failed/);
  assert.deepEqual(
    state.calls.map((call) => call.step),
    ['snapshot', 'drop', 'rollback-create', 'rollback-import'],
  );
  assert.ok(await state.prisma.database.findUnique({ where: { id: state.database.id } }));
  assert.equal(
    await state.prisma.operationLock.count({ where: { operationId: accepted.operationId } }),
    0,
  );
});

test('T-OPS-006 failed rollback requires attention and retains conflicting locks', async (t) => {
  const state = await fixture(t, {
    metadataDeleteFails: true,
    failStep: 'rollback-create',
  });
  const accepted = await enqueue(state, `database-delete-attention-${crypto.randomUUID()}`);
  const operation = await terminal(state, accepted.operationId);
  assert.equal(operation.status, 'NEEDS_ATTENTION');
  assert.match(operation.errorMessage, /rollback failed/);
  assert.deepEqual(
    state.calls.map((call) => call.step),
    ['snapshot', 'drop', 'rollback-create'],
  );
  assert.ok(
    await state.prisma.operationLock.findFirst({
      where: { operationId: accepted.operationId },
    }),
  );
});
