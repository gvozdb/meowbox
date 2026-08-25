'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { PrismaClient } = require('@prisma/client');
const masterKey = require('../src/common/crypto/master-key');
const { encryptJson } = require('../src/common/crypto/credentials-cipher');
const { DatabasesService } = require('../src/databases/databases.service');
const { DatabaseOperationsService } = require('../src/databases/database-operations.service');
const { OperationAdmissionService } = require('../src/operations/operation-admission.service');
const { OperationsService } = require('../src/operations/operations.service');
const { OperationsWorkerService } = require('../src/operations/operations-worker.service');
const { TransferArtifactService } = require('../src/transfers/transfer-artifact.service');
const { TransferSessionService } = require('../src/transfers/transfer-session.service');

const INSTALLATION_ID = '11111111-2222-4333-8444-555555555555';

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-database-transfer-'));
  const exportsDir = path.join(root, 'exports');
  const stateDir = path.join(root, 'state');
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

  const configValues = {
    MEOWBOX_STATE_DIR: stateDir,
    TRANSFER_DISK_RESERVE_BYTES: 1,
    TRANSFER_DISK_RESERVE_PERCENT: 0,
    TRANSFER_MAX_ARTIFACT_BYTES: 1024 * 1024,
  };
  const config = { get: (key, fallback) => key in configValues ? configValues[key] : fallback };
  const identity = {
    getLocalIdentity: async () => ({
      installationId: INSTALLATION_ID,
      installationRole: 'TARGET',
    }),
  };
  const transferSessions = new TransferSessionService(
    prisma,
    config,
    identity,
    { directTransferOrigin: () => 'https://transfer.target.test' },
  );
  const artifacts = new TransferArtifactService(
    prisma,
    config,
    identity,
    transferSessions,
  );
  await artifacts.onModuleInit();

  const operations = new OperationsService(prisma);
  const worker = new OperationsWorkerService(operations);
  const admission = new OperationAdmissionService(operations, identity);
  const calls = [];
  const relay = {
    isAgentConnected: () => true,
    runAgentJob: async (input) => {
      calls.push(input);
      const jobId = crypto.createHash('sha256')
        .update(`${input.operationId}:${input.step}`)
        .digest('hex');
      const requestHash = crypto.createHash('sha256')
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
      if (options.importFailure === 'confirmed' && input.step === 'import') {
        await prisma.agentJob.update({
          where: { id: jobId },
          data: { state: 'FAILED', errorMessage: 'import failed', completedAt: new Date() },
        });
        throw new Error('import failed');
      }
      if (options.importFailure === 'unknown' && input.step === 'import') {
        throw new Error('agent disconnected during import');
      }
      let result = null;
      if (input.step === 'export' || input.step === 'snapshot') {
        const filePath = path.join(exportsDir, `${input.operationId}-${input.step}.sql`);
        fs.writeFileSync(filePath, `${input.step} database dump`);
        result = { filePath };
      }
      await prisma.agentJob.update({
        where: { id: jobId },
        data: { state: 'SUCCEEDED', result: JSON.stringify(result), completedAt: new Date() },
      });
      return result;
    },
  };
  const databases = new DatabasesService(prisma, relay, {}, operations, {});
  const service = new DatabaseOperationsService(
    prisma,
    relay,
    databases,
    admission,
    worker,
    artifacts,
    transferSessions,
  );
  service.onModuleInit();

  t.after(async () => {
    service.onModuleDestroy();
    worker.onModuleDestroy();
    artifacts.onModuleDestroy();
    transferSessions.onModuleDestroy();
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
    artifacts,
    calls,
    database,
    domain,
    prisma,
    service,
    site,
    stateDir,
    transferSessions,
    user,
    worker,
  };
}

async function terminal(state, operationId) {
  await state.worker.pollOnce();
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const operation = await state.prisma.operation.findUnique({ where: { id: operationId } });
    if (['SUCCEEDED', 'FAILED', 'NEEDS_ATTENTION', 'CANCELLED'].includes(operation?.status)) {
      return operation;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`operation ${operationId} did not complete`);
}

async function uploadDatabase(state, payload = Buffer.from('SELECT 1;')) {
  const delivery = await state.service.createImportSession(
    state.site.id,
    state.domain.id,
    state.database.id,
    { userId: state.user.id, role: 'ADMIN' },
    { filename: 'database.sql', contentLength: payload.length },
    `database-upload-${crypto.randomUUID()}`,
  );
  const secret = new URL(delivery.url).searchParams.get('secret');
  await state.transferSessions.upload(
    delivery.leaseId,
    secret,
    String(payload.length),
    'application/octet-stream',
    Readable.from(payload),
  );
  return delivery.leaseId;
}

test('T-XFER-001 database export stages immutable artifact and issues bound Range delivery', async (t) => {
  const state = await fixture(t);
  const accepted = await state.service.enqueueExport(
    state.site.id,
    state.domain.id,
    state.database.id,
    { userId: state.user.id, role: 'ADMIN' },
    `database-export-${crypto.randomUUID()}`,
  );
  const operation = await terminal(state, accepted.operationId);
  assert.equal(operation.status, 'SUCCEEDED');
  const result = JSON.parse(operation.result);
  assert.equal(result.databaseId, state.database.id);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(result, 'filePath'), false);
  const artifact = await state.prisma.transferArtifact.findUnique({
    where: { id: result.artifactId },
  });
  assert.equal(artifact.state, 'READY');
  assert.equal(artifact.resourceId, accepted.operationId);
  const delivery = await state.service.issueExportDelivery(
    state.site.id,
    state.domain.id,
    state.database.id,
    accepted.operationId,
    { userId: state.user.id, role: 'ADMIN' },
  );
  assert.equal(delivery.purpose, 'DOWNLOAD');
  assert.equal(delivery.transferMode, 'STAGED_ARTIFACT');
  assert.equal(delivery.rangeSupported, true);
  assert.equal(delivery.sha256, result.sha256);
  assert.equal(state.calls.filter((call) => call.step === 'export').length, 1);
});

test('T-XFER-002 database import uses direct uploaded artifact and revokes it after success', async (t) => {
  const state = await fixture(t);
  const uploadSessionId = await uploadDatabase(state);
  const accepted = await state.service.enqueueImport(
    state.site.id,
    state.domain.id,
    state.database.id,
    uploadSessionId,
    { userId: state.user.id, role: 'ADMIN' },
    `database-import-${crypto.randomUUID()}`,
  );
  const operation = await terminal(state, accepted.operationId);
  assert.equal(operation.status, 'SUCCEEDED');
  assert.deepEqual(JSON.parse(operation.result), { databaseId: state.database.id });
  assert.deepEqual(state.calls.map((call) => call.step), ['snapshot', 'import']);
  const uploadSession = await state.prisma.transferSession.findUnique({ where: { id: uploadSessionId } });
  const artifact = await state.prisma.transferArtifact.findUnique({ where: { id: uploadSession.artifactId } });
  assert.equal(artifact.state, 'DELETED');
  assert.ok(artifact.deletedAt);
});

test('T-OPS-005 confirmed database import failure restores snapshot and releases locks', async (t) => {
  const state = await fixture(t, { importFailure: 'confirmed' });
  const uploadSessionId = await uploadDatabase(state);
  const accepted = await state.service.enqueueImport(
    state.site.id,
    state.domain.id,
    state.database.id,
    uploadSessionId,
    { userId: state.user.id, role: 'ADMIN' },
    `database-import-rollback-${crypto.randomUUID()}`,
  );
  const operation = await terminal(state, accepted.operationId);
  assert.equal(operation.status, 'FAILED');
  assert.deepEqual(
    state.calls.map((call) => call.step),
    ['snapshot', 'import', 'rollback-drop', 'rollback-create', 'rollback-import'],
  );
  assert.equal(
    await state.prisma.operationLock.count({ where: { operationId: accepted.operationId } }),
    0,
  );
});

test('T-OPS-006 unknown database import outcome retains lock and skips unsafe rollback', async (t) => {
  const state = await fixture(t, { importFailure: 'unknown' });
  const uploadSessionId = await uploadDatabase(state);
  const accepted = await state.service.enqueueImport(
    state.site.id,
    state.domain.id,
    state.database.id,
    uploadSessionId,
    { userId: state.user.id, role: 'ADMIN' },
    `database-import-attention-${crypto.randomUUID()}`,
  );
  const operation = await terminal(state, accepted.operationId);
  assert.equal(operation.status, 'NEEDS_ATTENTION');
  assert.match(operation.errorMessage, /reconcile the physical database/);
  assert.deepEqual(state.calls.map((call) => call.step), ['snapshot', 'import']);
  assert.ok(await state.prisma.operationLock.findFirst({
    where: { operationId: accepted.operationId },
  }));
});
