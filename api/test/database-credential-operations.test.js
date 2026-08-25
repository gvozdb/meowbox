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
const { DatabaseOperationsService } = require('../src/databases/database-operations.service');
const { DatabasesService } = require('../src/databases/databases.service');
const { OperationAdmissionService } = require('../src/operations/operation-admission.service');
const {
  OperationSensitiveResultService,
} = require('../src/operations/operation-sensitive-result.service');
const { OperationsService } = require('../src/operations/operations.service');
const {
  OperationsWorkerService,
} = require('../src/operations/operations-worker.service');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-database-credentials-'));
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
      username: `database-${suffix}`,
      email: `database-${suffix}@example.test`,
      passwordHash: 'not-used',
      identityKind: 'LOCAL',
      role: 'ADMIN',
    },
  });
  const site = await prisma.site.create({
    data: {
      name: `database${suffix}`,
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
  await prisma.serverService.create({
    data: { serviceKey: 'mariadb', installed: true },
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
      return null;
    },
  };
  const databases = new DatabasesService(
    prisma,
    relay,
    { requireOwnedSiteDomain: async () => ({ site, domain }) },
    operations,
    {},
  );
  const sensitiveResults = new OperationSensitiveResultService(prisma);
  const service = new DatabaseOperationsService(
    prisma,
    relay,
    databases,
    admission,
    worker,
    {},
    {},
    sensitiveResults,
  );
  service.onModuleInit();
  t.after(async () => {
    service.onModuleDestroy();
    worker.onModuleDestroy();
    databases.onModuleDestroy();
    await prisma.$disconnect();
    if (previousMasterKey === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previousMasterKey;
    masterKey._resetMasterKeyCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { calls, domain, prisma, sensitiveResults, service, site, user, worker };
}

async function terminal(state, operationId) {
  await state.worker.pollOnce();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const operation = await state.prisma.operation.findUnique({ where: { id: operationId } });
    if (['SUCCEEDED', 'FAILED', 'NEEDS_ATTENTION'].includes(operation?.status)) return operation;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`operation ${operationId} did not complete`);
}

test('T-OPS-004 database create is replay-safe and exposes credentials once', async (t) => {
  const state = await fixture(t);
  const key = `database-create-${crypto.randomUUID()}`;
  const input = { name: `app_${crypto.randomBytes(4).toString('hex')}`, type: 'MARIADB' };
  const actor = { userId: state.user.id, role: 'ADMIN' };
  const accepted = await state.service.enqueueCreate(
    state.site.id, state.domain.id, input, actor, key,
  );
  const replay = await state.service.enqueueCreate(
    state.site.id, state.domain.id, input, actor, key,
  );
  assert.equal(replay.operationId, accepted.operationId);
  assert.equal(replay.replayed, true);

  const operation = await terminal(state, accepted.operationId);
  assert.equal(operation.status, 'SUCCEEDED');
  assert.equal(JSON.stringify(operation).includes('DATABASE-PASSWORD'), false);
  assert.deepEqual(state.calls.map((call) => call.actionId), ['agent.database.create']);

  const sensitive = await state.sensitiveResults.consume(accepted.operationId, state.user.id);
  assert.equal(sensitive.kind, 'DATABASE_CREDENTIALS');
  assert.equal(sensitive.value.name, input.name);
  assert.match(sensitive.value.password, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(JSON.stringify(operation).includes(sensitive.value.password), false);
  const database = await state.prisma.database.findUnique({
    where: { id: sensitive.value.databaseId },
  });
  assert.ok(database);
  assert.equal(state.service['databases'].getPlainPassword(database), sensitive.value.password);
  await assert.rejects(
    () => state.sensitiveResults.consume(accepted.operationId, state.user.id),
    /unavailable/,
  );
});

test('T-OPS-004 database password reset commits only after confirmed AgentJob', async (t) => {
  const state = await fixture(t);
  const actor = { userId: state.user.id, role: 'ADMIN' };
  const created = await state.service.enqueueCreate(
    state.site.id,
    state.domain.id,
    { name: `reset_${crypto.randomBytes(4).toString('hex')}`, type: 'MARIADB' },
    actor,
    `database-create-${crypto.randomUUID()}`,
  );
  await terminal(state, created.operationId);
  const credentials = await state.sensitiveResults.consume(created.operationId, state.user.id);
  const previousPassword = credentials.value.password;

  const reset = await state.service.enqueueResetPassword(
    state.site.id,
    state.domain.id,
    credentials.value.databaseId,
    actor,
    `database-reset-${crypto.randomUUID()}`,
  );
  const operation = await terminal(state, reset.operationId);
  assert.equal(operation.status, 'SUCCEEDED');
  const updated = await state.sensitiveResults.consume(reset.operationId, state.user.id);
  assert.notEqual(updated.value.password, previousPassword);
  const database = await state.prisma.database.findUnique({
    where: { id: credentials.value.databaseId },
  });
  assert.equal(state.service['databases'].getPlainPassword(database), updated.value.password);
  assert.deepEqual(
    state.calls.map((call) => call.actionId),
    ['agent.database.create', 'agent.database.reset_password'],
  );
});
