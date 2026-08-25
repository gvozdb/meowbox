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
const { BackupExportsService } = require('../src/backups/backup-exports.service');
const { OperationAdmissionService } = require('../src/operations/operation-admission.service');
const { OperationsService } = require('../src/operations/operations.service');
const { OperationsWorkerService } = require('../src/operations/operations-worker.service');
const { TransferArtifactService } = require('../src/transfers/transfer-artifact.service');
const { TransferSessionService } = require('../src/transfers/transfer-session.service');

const INSTALLATION_ID = '11111111-2222-4333-8444-555555555555';

async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('Timed out waiting for durable staged export state');
}

async function fixture(t, { slow = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-staged-export-'));
  const databaseUrl = `file:${path.join(root, 'fixture.db')}`;
  execFileSync(path.resolve(__dirname, '../node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'ignore',
  });
  const previousMasterKey = process.env.MEOWBOX_MASTER_KEY;
  const previousPath = process.env.PATH;
  process.env.MEOWBOX_MASTER_KEY = crypto.randomBytes(32).toString('base64');
  masterKey._resetMasterKeyCacheForTests();

  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const restic = path.join(bin, 'restic');
  fs.writeFileSync(restic, slow
    ? '#!/usr/bin/env node\nprocess.stdout.write("start"); setInterval(() => process.stdout.write("x"), 100);\n'
    : '#!/usr/bin/env node\nprocess.stdout.write("fixture-staged-tar");\n',
  { mode: 0o700 });
  process.env.PATH = `${bin}:${previousPath || '/usr/bin:/bin'}`;

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const user = await prisma.user.create({
    data: {
      username: `staged-export-${crypto.randomUUID()}`,
      email: `staged-export-${crypto.randomUUID()}@example.test`,
      passwordHash: 'not-used',
      identityKind: 'LOCAL',
      role: 'MANAGER',
    },
  });
  const site = await prisma.site.create({
    data: {
      name: `stage_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`,
      status: 'RUNNING',
      rootPath: '/srv/staged-export',
      nginxConfigPath: '/etc/nginx/sites-enabled/staged-export',
      userId: user.id,
    },
  });
  const storage = await prisma.storageLocation.create({
    data: {
      name: `staged-${crypto.randomUUID()}`,
      type: 'LOCAL',
      config: '{}',
      resticPassword: 'not-read-from-db',
      resticEnabled: true,
    },
  });
  const backup = await prisma.backup.create({
    data: {
      siteId: site.id,
      type: 'FULL',
      status: 'COMPLETED',
      engine: 'RESTIC',
      storageLocationId: storage.id,
      resticSnapshotId: 'a'.repeat(64),
      filePath: '',
      sizeBytes: 64n,
      completedAt: new Date(),
    },
  });
  const configValues = {
    MEOWBOX_STATE_DIR: path.join(root, 'state'),
    TRANSFER_DISK_RESERVE_BYTES: 1,
    TRANSFER_DISK_RESERVE_PERCENT: 0,
    TRANSFER_MAX_ARTIFACT_BYTES: 1024 * 1024,
    BACKUP_EXPORT_STAGED_MAX_BYTES: 1024 * 1024,
  };
  const config = { get: (key, fallback) => key in configValues ? configValues[key] : fallback };
  const identity = {
    getLocalIdentity: async () => ({
      installationId: INSTALLATION_ID,
      installationRole: 'TARGET',
    }),
  };
  const sessions = new TransferSessionService(
    prisma,
    config,
    identity,
    { directTransferOrigin: () => 'https://target.example.test' },
  );
  const artifacts = new TransferArtifactService(prisma, config, identity, sessions);
  const operations = new OperationsService(prisma);
  const worker = new OperationsWorkerService(operations);
  const admission = new OperationAdmissionService(operations, identity);
  const service = new BackupExportsService(
    prisma,
    {
      getFullConfigForAgent: async () => ({
        type: 'LOCAL',
        config: { remotePath: '/var/backups/meowbox' },
        resticPassword: 'fixture-password',
      }),
    },
    {},
    config,
    sessions,
    identity,
    artifacts,
    admission,
    worker,
    operations,
  );
  sessions.onModuleInit();
  await artifacts.onModuleInit();
  service.onModuleInit();
  t.after(async () => {
    service.onModuleDestroy();
    artifacts.onModuleDestroy();
    sessions.onModuleDestroy();
    worker.onModuleDestroy();
    await prisma.$disconnect();
    process.env.PATH = previousPath;
    if (previousMasterKey === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previousMasterKey;
    masterKey._resetMasterKeyCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { prisma, user, backup, service, worker, operations };
}

test('T-OPS-004/T-XFER-001 staged backup export is durable and Range-capable', async (t) => {
  const { prisma, user, backup, service, worker } = await fixture(t);
  const idempotencyKey = `staged-${crypto.randomUUID()}`;
  const accepted = await service.createStagedExport({
    backupId: backup.id,
    ttlHours: 1,
    userId: user.id,
    role: user.role,
    idempotencyKey,
  });
  assert.equal(accepted.export.mode, 'STAGED_ARTIFACT');
  assert.equal(accepted.export.status, 'PENDING');
  assert.ok(accepted.operation.operationId);

  await worker.pollOnce();
  const operation = await waitFor(async () => {
    const row = await prisma.operation.findUnique({
      where: { id: accepted.operation.operationId },
    });
    return row?.status === 'SUCCEEDED' ? row : null;
  });
  const exportRow = await prisma.backupExport.findUnique({
    where: { id: accepted.export.id },
  });
  assert.equal(exportRow.status, 'READY');
  assert.equal(exportRow.operationId, operation.id);
  assert.ok(exportRow.artifactId);
  const artifact = await prisma.transferArtifact.findUnique({
    where: { id: exportRow.artifactId },
  });
  assert.equal(artifact.state, 'READY');
  assert.equal(artifact.sizeBytes, BigInt('fixture-staged-tar'.length));
  assert.equal(
    artifact.sha256,
    crypto.createHash('sha256').update('fixture-staged-tar').digest('hex'),
  );

  const delivery = await service.issueDelivery(exportRow.id, user.id, user.role);
  assert.equal(delivery.kind, 'TransferSession');
  assert.equal(delivery.transferMode, 'STAGED_ARTIFACT');
  assert.equal(delivery.rangeSupported, true);
  assert.equal(delivery.resumeSupported, true);
  assert.equal(delivery.contentLength, 'fixture-staged-tar'.length);
});

test('T-OPS-005 staged export deletion cancels source and leaves no orphan artifact', async (t) => {
  const { prisma, user, backup, service, worker } = await fixture(t, { slow: true });
  const accepted = await service.createStagedExport({
    backupId: backup.id,
    ttlHours: 1,
    userId: user.id,
    role: user.role,
    idempotencyKey: `staged-cancel-${crypto.randomUUID()}`,
  });
  await worker.pollOnce();
  await waitFor(async () => {
    const row = await prisma.operation.findUnique({
      where: { id: accepted.operation.operationId },
    });
    return row?.status === 'RUNNING';
  });
  await service.deleteExport(accepted.export.id, user.id, user.role);
  await waitFor(async () => {
    const row = await prisma.operation.findUnique({
      where: { id: accepted.operation.operationId },
    });
    return row?.status === 'CANCELLED';
  }, 8_000);
  const exportRow = await prisma.backupExport.findUnique({
    where: { id: accepted.export.id },
  });
  assert.equal(exportRow, null);
  assert.equal(await prisma.transferArtifact.count({
    where: { resourceId: accepted.export.id, state: 'READY' },
  }), 0);
});
