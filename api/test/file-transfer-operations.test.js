'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const { PrismaClient } = require('@prisma/client');
const masterKey = require('../src/common/crypto/master-key');
const { DomainContextService } = require('../src/sites/domain-context.service');
const { FilesService } = require('../src/files/files.service');
const { FileTransferService } = require('../src/files/file-transfer.service');
const { OperationAdmissionService } = require('../src/operations/operation-admission.service');
const { OperationsService } = require('../src/operations/operations.service');
const { OperationsWorkerService } = require('../src/operations/operations-worker.service');
const { TransferArtifactService } = require('../src/transfers/transfer-artifact.service');
const { TransferSessionService } = require('../src/transfers/transfer-session.service');

const INSTALLATION_ID = '11111111-2222-4333-8444-555555555555';

class StreamResponse extends Writable {
  constructor() {
    super();
    this.headers = new Map();
    this.locals = {};
    this.statusCode = 200;
    this.chunks = [];
  }

  setHeader(name, value) {
    this.headers.set(String(name).toLowerCase(), String(value));
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  body() {
    return Buffer.concat(this.chunks);
  }
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-file-transfer-'));
  const siteRoot = path.join(root, 'site');
  const applicationRoot = path.join(siteRoot, 'www');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(applicationRoot, { recursive: true });
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
      username: `file_${suffix}`,
      email: `file_${suffix}@example.test`,
      passwordHash: 'not-used',
      identityKind: 'LOCAL',
      role: 'ADMIN',
    },
  });
  const site = await prisma.site.create({
    data: {
      name: `file_${suffix}`,
      status: 'RUNNING',
      rootPath: siteRoot,
      nginxConfigPath: path.join(root, 'site.conf'),
      systemUser: `file_${suffix}`,
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

  const values = {
    MEOWBOX_STATE_DIR: stateDir,
    TRANSFER_DISK_RESERVE_BYTES: 1,
    TRANSFER_DISK_RESERVE_PERCENT: 0,
    TRANSFER_MAX_ARTIFACT_BYTES: 1024 * 1024,
    TRANSFER_GENERATED_STREAM_IDLE_MS: 5_000,
  };
  const config = { get: (key, fallback) => key in values ? values[key] : fallback };
  const identity = {
    getLocalIdentity: async () => ({
      installationId: INSTALLATION_ID,
      installationRole: 'TARGET',
    }),
  };
  const transfers = new TransferSessionService(
    prisma,
    config,
    identity,
    { directTransferOrigin: () => 'https://transfer.target.test' },
  );
  const artifacts = new TransferArtifactService(prisma, config, identity, transfers);
  await artifacts.onModuleInit();
  const ownershipCalls = [];
  const relay = {
    isAgentConnected: () => true,
    emitToAgent: async (event, payload) => {
      ownershipCalls.push({ event, payload });
      return { success: true };
    },
  };
  const files = new FilesService(new DomainContextService(prisma), relay);
  const operations = new OperationsService(prisma);
  const worker = new OperationsWorkerService(operations);
  const admission = new OperationAdmissionService(operations, identity);
  const fileTransfers = new FileTransferService(
    config,
    files,
    transfers,
    artifacts,
    admission,
    worker,
  );
  fileTransfers.onModuleInit();

  t.after(async () => {
    fileTransfers.onModuleDestroy();
    worker.onModuleDestroy();
    artifacts.onModuleDestroy();
    transfers.onModuleDestroy();
    await prisma.$disconnect();
    if (previousMasterKey === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previousMasterKey;
    masterKey._resetMasterKeyCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    applicationRoot,
    artifacts,
    domain,
    fileTransfers,
    ownershipCalls,
    prisma,
    site,
    transfers,
    user,
    worker,
  };
}

async function upload(state, filename, payload) {
  const delivery = await state.fileTransfers.issueUpload(
    state.site.id,
    state.domain.id,
    { targetDir: '/', filename, contentLength: payload.length },
    { userId: state.user.id, role: 'ADMIN' },
    `file-upload-session-${crypto.randomUUID()}`,
  );
  const secret = new URL(delivery.url).searchParams.get('secret');
  await state.transfers.upload(
    delivery.leaseId,
    secret,
    String(payload.length),
    'application/octet-stream',
    Readable.from(payload),
  );
  return delivery.leaseId;
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

test('T-XFER-001 file download keeps path encrypted and streams directly', async (t) => {
  const state = await fixture(t);
  const payload = Buffer.from('private file payload');
  const filePath = path.join(state.applicationRoot, 'report.txt');
  fs.writeFileSync(filePath, payload);
  const delivery = await state.fileTransfers.issueDownload(
    state.site.id,
    state.domain.id,
    '/report.txt',
    { userId: state.user.id, role: 'ADMIN' },
  );
  assert.equal(delivery.kind, 'TransferSession');
  assert.equal(delivery.transferMode, 'GENERATED_STREAM');
  assert.equal(delivery.rangeSupported, false);
  const row = await state.prisma.transferSession.findUnique({ where: { id: delivery.leaseId } });
  assert.ok(row.resourcePayloadEnc);
  assert.equal(row.resourcePayloadEnc.includes('/report.txt'), false);

  const response = new StreamResponse();
  await state.transfers.download(
    delivery.leaseId,
    new URL(delivery.url).searchParams.get('secret'),
    undefined,
    undefined,
    response,
  );
  assert.deepEqual(response.body(), payload);
  assert.equal(response.headers.get('content-length'), String(payload.length));
});

test('T-XFER-002 file upload commits atomically through durable operation', async (t) => {
  const state = await fixture(t);
  const payload = Buffer.from('uploaded without browser buffering');
  const uploadSessionId = await upload(state, 'document.txt', payload);
  const accepted = await state.fileTransfers.enqueueUploadCommit(
    state.site.id,
    state.domain.id,
    uploadSessionId,
    '/',
    { userId: state.user.id, role: 'ADMIN' },
    `file-upload-commit-${crypto.randomUUID()}`,
  );
  const operation = await terminal(state, accepted.operationId);
  assert.equal(operation.status, 'SUCCEEDED');
  assert.deepEqual(fs.readFileSync(path.join(state.applicationRoot, 'document.txt')), payload);
  assert.equal(
    fs.readdirSync(state.applicationRoot).some((name) => name.endsWith('.partial')),
    false,
  );
  assert.equal(state.ownershipCalls.length, 1);
  assert.equal(state.ownershipCalls[0].event, 'user:set-ownership');
  const session = await state.prisma.transferSession.findUnique({ where: { id: uploadSessionId } });
  const artifact = await state.prisma.transferArtifact.findUnique({ where: { id: session.artifactId } });
  assert.equal(artifact.state, 'DELETED');
});

test('T-OPS-006 interrupted file upload does not blind-retry an unknown commit', async (t) => {
  const state = await fixture(t);
  const payload = Buffer.from('recovery fixture');
  const uploadSessionId = await upload(state, 'recovery.txt', payload);
  const accepted = await state.fileTransfers.enqueueUploadCommit(
    state.site.id,
    state.domain.id,
    uploadSessionId,
    '/',
    { userId: state.user.id, role: 'ADMIN' },
    `file-upload-recovery-${crypto.randomUUID()}`,
  );
  await state.prisma.operation.update({
    where: { id: accepted.operationId },
    data: { status: 'RECOVERING', currentStep: 'reconcile' },
  });
  const operation = await terminal(state, accepted.operationId);
  assert.equal(operation.status, 'NEEDS_ATTENTION');
  assert.match(operation.errorMessage, /outcome is unknown/);
  assert.equal(fs.existsSync(path.join(state.applicationRoot, 'recovery.txt')), false);
  assert.ok(await state.prisma.operationLock.findFirst({
    where: { operationId: accepted.operationId },
  }));
});

test('T-XFER-002 file upload blocks executable and double extensions before admission', async (t) => {
  const state = await fixture(t);
  await assert.rejects(
    () => state.fileTransfers.issueUpload(
      state.site.id,
      state.domain.id,
      { targetDir: '/', filename: 'shell.php.jpg', contentLength: 12 },
      { userId: state.user.id, role: 'ADMIN' },
      `file-upload-blocked-${crypto.randomUUID()}`,
    ),
    /расширением \.php запрещена/,
  );
  assert.equal(await state.prisma.transferSession.count(), 0);
});
