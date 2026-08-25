'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Writable, Readable } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PrismaClient } = require('@prisma/client');
const { TransferSessionService } = require('../src/transfers/transfer-session.service');
const {
  TransferArtifactService,
  __transferArtifactTest,
} = require('../src/transfers/transfer-artifact.service');
const { validatePublicDelivery } = require('../../shared/src/public-delivery');

const TARGET_ID = '11111111-1111-4111-8111-111111111111';
process.env.MEOWBOX_MASTER_KEY ||= Buffer.alloc(32, 0x42).toString('base64');

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = new Map();
    this.locals = {};
    this.statusCode = 200;
    this.writableFinished = false;
    this.destroyed = false;
  }

  setHeader(name, value) {
    this.headers.set(String(name).toLowerCase(), String(value));
  }
}

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-transfer-'));
  const databaseUrl = `file:${path.join(root, 'fixture.db')}`;
  execFileSync(path.resolve(__dirname, '../node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'ignore',
  });
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const user = await prisma.user.create({
    data: {
      username: `transfer-${crypto.randomUUID()}`,
      email: `transfer-${crypto.randomUUID()}@example.test`,
      passwordHash: 'not-used',
      identityKind: 'LOCAL',
      role: 'ADMIN',
    },
  });
  const stateDir = path.join(root, 'state');
  const overrides = {
    MEOWBOX_STATE_DIR: stateDir,
    TRANSFER_DISK_RESERVE_BYTES: 1,
    TRANSFER_DISK_RESERVE_PERCENT: 0,
    TRANSFER_MAX_ARTIFACT_BYTES: 1024 * 1024,
  };
  const config = { get: (key, fallback) => key in overrides ? overrides[key] : fallback };
  const identity = {
    getLocalIdentity: async () => ({ installationId: TARGET_ID, installationRole: 'TARGET' }),
  };
  const origins = { directTransferOrigin: () => 'https://transfer.target.test' };
  const service = new TransferSessionService(prisma, config, identity, origins);
  const artifacts = new TransferArtifactService(prisma, config, identity, service);
  await artifacts.onModuleInit();
  t.after(async () => {
    artifacts.onModuleDestroy();
    service.onModuleDestroy();
    await prisma.$disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { prisma, service, artifacts, user, stateDir };
}

function issue(service, user, resourceId = crypto.randomUUID()) {
  return service.issueGeneratedStream({
    sourceKind: 'BACKUP_EXPORT',
    resourceId,
    actor: { userId: user.id, role: user.role },
    filename: `backup-${resourceId.slice(0, 8)}.tar`,
    contentType: 'application/x-tar',
    resourceExpiresAt: new Date(Date.now() + 60 * 60_000),
  });
}

async function waitFor(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for durable transfer state');
}

test('T-XFER-001 generated stream grant stores only a hash and advertises no resume', async (t) => {
  const { prisma, service, user } = await fixture(t);
  service.registerGeneratedSource('BACKUP_EXPORT', {
    stream: async (_resourceId, _actor, response) => {
      response.writableFinished = true;
      response.emit('finish');
    },
  });
  const delivery = validatePublicDelivery(await issue(service, user));
  assert.equal(delivery.kind, 'TransferSession');
  assert.equal(delivery.transferMode, 'GENERATED_STREAM');
  assert.equal(delivery.rangeSupported, false);
  assert.equal(delivery.resumeSupported, false);
  assert.equal(delivery.contentLength, null);
  assert.equal(delivery.sha256, null);
  assert.match(delivery.url, /^https:\/\/transfer\.target\.test\/api\/public\/v1\/transfers\/[0-9a-f-]{36}\/download\?secret=[A-Za-z0-9_-]{43}$/);

  const secret = new URL(delivery.url).searchParams.get('secret');
  const row = await prisma.transferSession.findUnique({ where: { id: delivery.leaseId } });
  assert.ok(row);
  assert.match(row.secretHash, /^[0-9a-f]{64}$/);
  assert.equal(
    JSON.stringify(row, (_key, value) => typeof value === 'bigint' ? value.toString() : value).includes(secret),
    false,
  );
});

test('T-XFER-001 generated stream resource payload is encrypted and session-bound', async (t) => {
  const { prisma, service, user } = await fixture(t);
  const resourceId = crypto.randomUUID();
  const payload = {
    siteId: crypto.randomUUID(),
    domainId: resourceId,
    path: '/private/report.txt',
  };
  let received = null;
  service.registerGeneratedSource('SITE_FILE', {
    stream: async (_resourceId, _actor, response, resourcePayload) => {
      received = resourcePayload;
      response.writableFinished = true;
      response.emit('finish');
    },
  });
  const delivery = await service.issueGeneratedStream({
    sourceKind: 'SITE_FILE',
    resourceId,
    actor: { userId: user.id, role: user.role },
    filename: 'report.txt',
    contentType: 'application/octet-stream',
    resourceExpiresAt: new Date(Date.now() + 60 * 60_000),
    resourcePayload: payload,
  });
  const row = await prisma.transferSession.findUnique({ where: { id: delivery.leaseId } });
  assert.match(row.resourcePayloadEnc, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(row.resourcePayloadEnc.includes(payload.path), false);

  const secret = new URL(delivery.url).searchParams.get('secret');
  await service.streamGenerated(delivery.leaseId, secret, undefined, new FakeResponse());
  assert.deepEqual(received, payload);
});

test('T-XFER-001 HEAD does not consume, Range returns 416, GET is single-start', async (t) => {
  const { prisma, service, user } = await fixture(t);
  let starts = 0;
  service.registerGeneratedSource('BACKUP_EXPORT', {
    stream: async (_resourceId, _actor, response) => {
      starts += 1;
      response.writableFinished = true;
      response.emit('finish');
    },
  });
  const delivery = await issue(service, user);
  const secret = new URL(delivery.url).searchParams.get('secret');
  const head = new FakeResponse();
  await service.head(delivery.leaseId, secret, head);
  assert.equal(head.headers.get('accept-ranges'), 'none');
  assert.equal((await prisma.transferSession.findUnique({ where: { id: delivery.leaseId } })).startedAt, null);

  await assert.rejects(
    service.streamGenerated(delivery.leaseId, secret, 'bytes=0-1', new FakeResponse()),
    (error) => error.getStatus() === 416,
  );
  await service.streamGenerated(delivery.leaseId, secret, undefined, new FakeResponse());
  await waitFor(async () => (
    await prisma.transferSession.findUnique({ where: { id: delivery.leaseId } })
  )?.consumedAt);
  assert.equal(starts, 1);
  const consumed = await prisma.transferSession.findUnique({ where: { id: delivery.leaseId } });
  assert.ok(consumed.startedAt);
  assert.ok(consumed.consumedAt);
  await assert.rejects(
    service.streamGenerated(delivery.leaseId, secret, undefined, new FakeResponse()),
    /expired or was consumed/,
  );
});

test('T-XFER-004 generated session admission is bounded per actor', async (t) => {
  const { service, user } = await fixture(t);
  service.registerGeneratedSource('BACKUP_EXPORT', { stream: async () => undefined });
  await issue(service, user);
  await issue(service, user);
  await assert.rejects(issue(service, user), /Actor transfer limit exceeded/);
});

test('T-XFER-001 staged artifact is immutable, checksummed, reusable, and single-range', async (t) => {
  const { prisma, service, artifacts, user } = await fixture(t);
  const payload = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
  const staged = await artifacts.stage({
    sourceKind: 'BACKUP_EXPORT',
    resourceId: crypto.randomUUID(),
    actor: { userId: user.id, role: user.role },
    filename: 'staged-backup.tar',
    contentType: 'application/x-tar',
    expiresAt: new Date(Date.now() + 60 * 60_000),
    expectedMaxBytes: payload.length,
    source: Readable.from(payload),
  });
  assert.equal(staged.sizeBytes, payload.length);
  assert.equal(staged.sha256, crypto.createHash('sha256').update(payload).digest('hex'));

  const delivery = validatePublicDelivery(await service.issueStagedArtifact({
    artifactId: staged.artifactId,
    actor: { userId: user.id, role: user.role },
  }));
  assert.equal(delivery.transferMode, 'STAGED_ARTIFACT');
  assert.equal(delivery.reusable, true);
  assert.equal(delivery.rangeSupported, true);
  assert.equal(delivery.resumeSupported, true);
  assert.equal(delivery.contentLength, payload.length);
  const secret = new URL(delivery.url).searchParams.get('secret');

  const head = new FakeResponse();
  await service.head(delivery.leaseId, secret, head);
  assert.equal(head.headers.get('content-length'), String(payload.length));
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  const etag = head.headers.get('etag');

  const first = new StreamResponse();
  await service.download(delivery.leaseId, secret, 'bytes=2-5', etag, first);
  assert.equal(first.statusCode, 206);
  assert.equal(first.headers.get('content-range'), `bytes 2-5/${payload.length}`);
  assert.deepEqual(first.body(), payload.subarray(2, 6));

  const second = new StreamResponse();
  await service.download(delivery.leaseId, secret, 'bytes=-4', etag, second);
  assert.deepEqual(second.body(), payload.subarray(payload.length - 4));
  await new Promise((resolve) => setImmediate(resolve));
  const session = await prisma.transferSession.findUnique({ where: { id: delivery.leaseId } });
  assert.equal(session.consumedAt, null);
  assert.ok(session.completedAt);
});

test('T-XFER-004 staged Range rejects multipart and If-Range mismatch returns full body', async (t) => {
  const { service, artifacts, user } = await fixture(t);
  const payload = Buffer.from('range-contract');
  const staged = await artifacts.stage({
    sourceKind: 'DATABASE_EXPORT',
    resourceId: crypto.randomUUID(),
    actor: { userId: user.id, role: user.role },
    filename: 'database.sql',
    contentType: 'application/octet-stream',
    expiresAt: new Date(Date.now() + 60 * 60_000),
    expectedMaxBytes: payload.length,
    source: Readable.from(payload),
  });
  const delivery = await service.issueStagedArtifact({
    artifactId: staged.artifactId,
    actor: { userId: user.id, role: user.role },
  });
  const secret = new URL(delivery.url).searchParams.get('secret');
  await assert.rejects(
    service.download(delivery.leaseId, secret, 'bytes=0-1,3-4', undefined, new StreamResponse()),
    (error) => error.getStatus() === 416,
  );
  const full = new StreamResponse();
  await service.download(delivery.leaseId, secret, 'bytes=2-4', '"stale"', full);
  assert.equal(full.statusCode, 200);
  assert.deepEqual(full.body(), payload);
  assert.deepEqual(__transferArtifactTest.parseSingleRange('bytes=3-', payload.length), {
    start: 3,
    end: payload.length - 1,
  });
});

function issueUpload(service, user, overrides = {}) {
  return service.issueStagedUpload({
    sourceKind: 'DATABASE_IMPORT',
    resourceId: crypto.randomUUID(),
    actor: { userId: user.id, role: user.role },
    filename: 'database.sql',
    contentType: 'application/octet-stream',
    contentLength: 16,
    resourceExpiresAt: new Date(Date.now() + 60 * 60_000),
    idempotencyKey: `upload-${crypto.randomUUID()}`,
    ...overrides,
  });
}

test('T-XFER-002 upload grant is deterministic, hash-only, and conflicts on changed binding', async (t) => {
  const { prisma, service, user } = await fixture(t);
  const input = {
    sourceKind: 'DATABASE_IMPORT',
    resourceId: crypto.randomUUID(),
    actor: { userId: user.id, role: user.role },
    filename: 'fixture.sql.gz',
    contentType: 'application/octet-stream',
    contentLength: 32,
    resourceExpiresAt: new Date(Date.now() + 60 * 60_000),
    idempotencyKey: `upload-${crypto.randomUUID()}`,
  };
  const first = validatePublicDelivery(await service.issueStagedUpload(input));
  const replay = validatePublicDelivery(await service.issueStagedUpload({
    ...input,
    resourceExpiresAt: new Date(Date.now() + 2 * 60 * 60_000),
  }));
  assert.equal(first.purpose, 'UPLOAD');
  assert.equal(first.method, 'PUT');
  assert.equal(first.reusable, false);
  assert.equal(first.contentLength, 32);
  assert.equal(first.url, replay.url);
  assert.equal(first.leaseId, replay.leaseId);

  const secret = new URL(first.url).searchParams.get('secret');
  const row = await prisma.transferSession.findUnique({ where: { id: first.leaseId } });
  assert.ok(row);
  assert.match(row.secretHash, /^[0-9a-f]{64}$/);
  assert.equal(
    JSON.stringify(row, (_key, value) => typeof value === 'bigint' ? value.toString() : value).includes(secret),
    false,
  );
  assert.equal(await prisma.transferArtifact.count(), 1);
  assert.equal(await prisma.transferSession.count(), 1);
  await assert.rejects(
    service.issueStagedUpload({ ...input, filename: 'different.sql' }),
    /different upload/,
  );
});

test('T-XFER-002 upload streams exact bytes into an immutable artifact and is single-use', async (t) => {
  const { prisma, service, artifacts, user } = await fixture(t);
  const payload = Buffer.from('SELECT 1;\nSELECT 2;\n');
  const resourceId = crypto.randomUUID();
  const delivery = await issueUpload(service, user, {
    resourceId,
    contentLength: payload.length,
  });
  const secret = new URL(delivery.url).searchParams.get('secret');
  const completed = await service.upload(
    delivery.leaseId,
    secret,
    String(payload.length),
    'application/octet-stream',
    Readable.from(payload),
  );
  assert.equal(completed.sizeBytes, payload.length);
  assert.equal(completed.sha256, crypto.createHash('sha256').update(payload).digest('hex'));

  const session = await prisma.transferSession.findUnique({ where: { id: delivery.leaseId } });
  assert.ok(session.startedAt);
  assert.ok(session.completedAt);
  assert.ok(session.consumedAt);
  assert.equal(session.failureCode, null);
  assert.equal(session.sha256, completed.sha256);
  const uploaded = await artifacts.requireUploadedArtifact({
    sessionId: delivery.leaseId,
    sourceKind: 'DATABASE_IMPORT',
    resourceId,
    actorUserId: user.id,
  });
  assert.deepEqual(fs.readFileSync(uploaded.path), payload);
  await assert.rejects(
    service.upload(
      delivery.leaseId,
      secret,
      String(payload.length),
      'application/octet-stream',
      Readable.from(payload),
    ),
    /expired or was consumed/,
  );
});

test('T-XFER-002 short upload fails closed and removes partial files', async (t) => {
  const { prisma, service, user, stateDir } = await fixture(t);
  const payload = Buffer.from('short');
  const delivery = await issueUpload(service, user, { contentLength: payload.length + 1 });
  const secret = new URL(delivery.url).searchParams.get('secret');
  await assert.rejects(
    service.upload(
      delivery.leaseId,
      secret,
      String(payload.length + 1),
      'application/octet-stream',
      Readable.from(payload),
    ),
    /ended before the declared length/,
  );
  const session = await prisma.transferSession.findUnique({ where: { id: delivery.leaseId } });
  const artifact = await prisma.transferArtifact.findUnique({ where: { id: session.artifactId } });
  assert.equal(session.failureCode, 'UPLOAD_FAILED');
  assert.ok(session.consumedAt);
  assert.equal(artifact.state, 'FAILED');
  assert.equal(fs.existsSync(path.join(stateDir, 'data', 'transfers', 'artifacts', artifact.relativePath)), false);
});

test('T-XFER-002 upload completion reconciles after artifact-ready crash window', async (t) => {
  const { prisma, service, artifacts, user } = await fixture(t);
  const payload = Buffer.from('crash-window');
  const delivery = await issueUpload(service, user, { contentLength: payload.length });
  const secret = new URL(delivery.url).searchParams.get('secret');
  const row = await prisma.transferSession.findUnique({ where: { id: delivery.leaseId } });
  const staged = {
    id: row.id,
    targetInstallationId: row.targetInstallationId,
    artifactId: row.artifactId,
    sourceKind: row.sourceKind,
    resourceId: row.resourceId,
    actorUserId: row.actorUserId,
    actorRole: row.actorRole,
    contentType: row.contentType,
    filename: row.filename,
    contentLength: row.contentLength,
    expiresAt: row.expiresAt,
  };
  const completed = await artifacts.upload(staged, Readable.from(payload));
  await prisma.transferSession.update({
    where: { id: row.id },
    data: { startedAt: new Date() },
  });
  const reconciled = await service.upload(
    delivery.leaseId,
    secret,
    String(payload.length),
    'application/octet-stream',
    Readable.from([]),
  );
  assert.deepEqual(reconciled, completed);
  const final = await prisma.transferSession.findUnique({ where: { id: row.id } });
  assert.equal(final.sha256, completed.sha256);
  assert.ok(final.completedAt);
  assert.ok(final.consumedAt);
});
