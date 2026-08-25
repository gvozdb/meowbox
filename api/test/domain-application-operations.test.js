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
const { DomainContextService } = require('../src/sites/domain-context.service');
const { DomainApplicationsService } = require('../src/sites/domain-applications.service');
const {
  OperationAdmissionService,
} = require('../src/operations/operation-admission.service');
const { OperationsService } = require('../src/operations/operations.service');
const {
  OperationsWorkerService,
} = require('../src/operations/operations-worker.service');
const {
  AgentJobTerminalError,
} = require('../src/gateway/agent-relay.service');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-domain-operation-'));
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
      username: `modx-${suffix}`,
      email: `modx-${suffix}@example.test`,
      passwordHash: 'not-used',
      identityKind: 'LOCAL',
      role: 'ADMIN',
    },
  });
  const siteRoot = path.join(root, `site-${suffix}`);
  fs.mkdirSync(path.join(siteRoot, 'www'), { recursive: true });
  const site = await prisma.site.create({
    data: {
      name: `modx${suffix}`,
      rootPath: siteRoot,
      nginxConfigPath: `/etc/nginx/sites/modx${suffix}.conf`,
      systemUser: `mx${suffix}`,
      userId: user.id,
    },
  });
  const domain = await prisma.siteDomain.create({
    data: {
      siteId: site.id,
      domain: `${suffix}.example.test`,
      isPrimary: true,
      filesRelPath: 'www',
      preset: 'MODX_REVO',
      phpVersion: '8.2',
      runtimeKey: `modx_${suffix}`,
      managerPath: 'manager',
      connectorsPath: 'connectors',
      appStatus: 'RUNNING',
      modxVersion: '2.8.7-pl',
    },
  });
  await prisma.database.create({
    data: {
      name: `modx_${suffix}`,
      type: 'MARIADB',
      dbUser: `mx${suffix}`,
      dbPasswordHash: 'not-used',
      siteId: site.id,
      siteDomainId: domain.id,
      purpose: 'APP_PRIMARY',
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
  const behavior = { updateFailure: false };
  const agent = {
    runAgentJob: async (input) => {
      calls.push(input);
      if (input.actionId === 'agent.application.snapshot') {
        return { snapshotPath: path.join(root, 'snapshot') };
      }
      if (input.actionId === 'agent.modx.update') {
        if (behavior.updateFailure) {
          throw new AgentJobTerminalError('update command failed');
        }
        return { version: input.payload.targetVersion };
      }
      if (input.actionId === 'agent.site.health_check') {
        return { reachable: true, statusCode: 200, responseTimeMs: 10 };
      }
      if (input.actionId === 'agent.application.restore_snapshot') {
        return { restored: true };
      }
      if (input.actionId === 'agent.modx.doctor') {
        return {
          success: true,
          modxCorePath: path.join(siteRoot, 'www/core'),
          modxVersion: '2.8.8-pl',
          modxConfigOk: true,
          issues: [{
            id: 'setup-dir-exposed',
            level: 'warning',
            title: 'Setup exists',
            description: 'Remove setup directory',
            fix: 'cleanup-setup-dir',
          }],
        };
      }
      if (input.actionId === 'agent.domain.permissions_normalize') {
        return { stepCount: 4, modxCorePath: path.join(siteRoot, 'www/core') };
      }
      if (input.actionId === 'agent.modx.cleanup_setup') {
        return { removed: true };
      }
      throw new Error(`unexpected action ${input.actionId}`);
    },
  };
  const service = new DomainApplicationsService(
    prisma,
    agent,
    new DomainContextService(prisma),
    {},
    operations,
    {},
    {},
    admission,
    worker,
  );
  service.onModuleInit();
  t.after(async () => {
    service.onModuleDestroy();
    worker.onModuleDestroy();
    await prisma.$disconnect();
    if (previousMasterKey === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previousMasterKey;
    masterKey._resetMasterKeyCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { behavior, calls, domain, prisma, service, site, user, worker };
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

test('T-OPS-004 MODX doctor, cleanup, and permission normalization use bounded AgentJobs', async (t) => {
  const state = await fixture(t);
  const doctorKey = `modx-doctor-${crypto.randomUUID()}`;
  const doctor = await state.service.enqueueModxDoctor(
    state.site.id,
    state.domain.id,
    state.user.id,
    'ADMIN',
    doctorKey,
  );
  const doctorReplay = await state.service.enqueueModxDoctor(
    state.site.id,
    state.domain.id,
    state.user.id,
    'ADMIN',
    doctorKey,
  );
  assert.equal(doctorReplay.operationId, doctor.operationId);
  assert.equal(doctorReplay.replayed, true);
  const doctorResult = await complete(state.worker, state.prisma, doctor.operationId);
  assert.equal(doctorResult.modxConfigOk, true);
  assert.equal(doctorResult.issues.length, 1);
  assert.equal(Object.hasOwn(doctorResult, 'success'), false);

  const normalized = await state.service.normalizePermissions(
    state.site.id,
    state.domain.id,
    state.user.id,
    'ADMIN',
    `modx-normalize-${crypto.randomUUID()}`,
  );
  assert.deepEqual(
    await complete(state.worker, state.prisma, normalized.operationId),
    { stepCount: 4, modxCorePath: path.join(state.site.rootPath, 'www/core') },
  );

  const cleanup = await state.service.cleanupSetup(
    state.site.id,
    state.domain.id,
    state.user.id,
    'ADMIN',
    `modx-cleanup-${crypto.randomUUID()}`,
  );
  assert.deepEqual(
    await complete(state.worker, state.prisma, cleanup.operationId),
    { removed: true },
  );

  assert.deepEqual(state.calls.map((call) => call.actionId), [
    'agent.modx.doctor',
    'agent.domain.permissions_normalize',
    'agent.modx.cleanup_setup',
  ]);
  assert.equal(state.calls.every((call) => call.cancelSafe === false), true);
});

test('T-OPS-004 MODX update commits only after snapshot and health confirmation', async (t) => {
  const state = await fixture(t);
  const accepted = await state.service.updateModx(
    state.site.id,
    state.domain.id,
    state.user.id,
    'ADMIN',
    { targetVersion: '2.8.8-pl' },
    `modx-update-${crypto.randomUUID()}`,
  );
  assert.equal(accepted.state, 'QUEUED');
  assert.deepEqual(
    await complete(state.worker, state.prisma, accepted.operationId),
    { version: '2.8.8-pl', previousVersion: '2.8.7-pl' },
  );
  assert.deepEqual(state.calls.map((call) => call.actionId), [
    'agent.application.snapshot',
    'agent.modx.update',
    'agent.site.health_check',
  ]);
  const domain = await state.prisma.siteDomain.findUnique({
    where: { id: state.domain.id },
  });
  assert.equal(domain.appStatus, 'RUNNING');
  assert.equal(domain.modxVersion, '2.8.8-pl');
});

test('T-OPS-005 MODX terminal update failure restores snapshot before releasing lock', async (t) => {
  const state = await fixture(t);
  state.behavior.updateFailure = true;
  const accepted = await state.service.updateModx(
    state.site.id,
    state.domain.id,
    state.user.id,
    'ADMIN',
    { targetVersion: '2.8.8-pl' },
    `modx-update-rollback-${crypto.randomUUID()}`,
  );
  await state.worker.pollOnce();
  const deadline = Date.now() + 2_000;
  let operation;
  while (Date.now() < deadline) {
    operation = await state.prisma.operation.findUnique({
      where: { id: accepted.operationId },
    });
    if (operation?.status === 'FAILED') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(operation?.status, 'FAILED');
  assert.match(operation.errorMessage, /rollback was verified/);
  assert.equal(await state.prisma.operationLock.count(), 0);
  assert.deepEqual(state.calls.map((call) => call.actionId), [
    'agent.application.snapshot',
    'agent.modx.update',
    'agent.application.restore_snapshot',
    'agent.site.health_check',
  ]);
  const domain = await state.prisma.siteDomain.findUnique({
    where: { id: state.domain.id },
  });
  assert.equal(domain.appStatus, 'RUNNING');
  assert.equal(domain.modxVersion, '2.8.7-pl');
});
