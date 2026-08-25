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
const { OperationAdmissionService } = require('../src/operations/operation-admission.service');
const { OperationsService } = require('../src/operations/operations.service');
const { OperationsWorkerService } = require('../src/operations/operations-worker.service');
const { ResticQueryOperationsService } = require('../src/backups/restic-query-operations.service');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-restic-query-'));
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
      username: `restic-${suffix}`,
      email: `restic-${suffix}@example.test`,
      passwordHash: 'not-used',
      identityKind: 'LOCAL',
      role: 'MANAGER',
    },
  });
  const site = await prisma.site.create({
    data: {
      name: `restic_${suffix}`,
      rootPath: `/var/www/restic_${suffix}`,
      nginxConfigPath: `/etc/nginx/sites/restic_${suffix}.conf`,
      systemUser: `rt${suffix}`,
      userId: user.id,
    },
  });
  const location = await prisma.storageLocation.create({
    data: {
      name: `restic-${suffix}`,
      type: 'LOCAL',
      config: '{}',
      resticEnabled: true,
      resticPassword: 'not-read-directly',
    },
  });
  const snapshotId = 'a'.repeat(64);
  const otherSnapshotId = 'b'.repeat(64);
  const backup = await prisma.backup.create({
    data: {
      siteId: site.id,
      type: 'FULL',
      status: 'COMPLETED',
      engine: 'RESTIC',
      storageLocationId: location.id,
      resticSnapshotId: snapshotId,
      filePath: `restic:${snapshotId}`,
      completedAt: new Date(),
    },
  });
  const operations = new OperationsService(prisma);
  const worker = new OperationsWorkerService(operations);
  const admission = new OperationAdmissionService(operations, {
    getLocalIdentity: async () => ({ installationId: '11111111-2222-4333-8444-555555555555' }),
  });
  const calls = [];
  const relay = {
    isAgentConnected: () => true,
    runAgentJob: async (input) => {
      calls.push(input);
      if (input.actionId === 'agent.restic.snapshots') {
        return {
          snapshots: [{
            id: snapshotId,
            short_id: snapshotId.slice(0, 8),
            time: '2026-08-25T00:00:00.000Z',
            hostname: 'fixture',
            paths: [site.rootPath],
            tags: [`site:${site.name}`],
          }],
        };
      }
      if (input.actionId === 'agent.restic.list_tree') {
        return { items: [{ name: 'public', type: 'dir', size: 4096 }] };
      }
      if (input.actionId === 'agent.restic.diff_snapshots' || input.actionId === 'agent.restic.diff_live') {
        return {
          items: [{ path: `${site.rootPath}/public/index.php`, modifier: 'M' }],
          stats: { changedFiles: 1, addedFiles: 0, removedFiles: 0 },
        };
      }
      if (input.actionId === 'agent.restic.diff_file' || input.actionId === 'agent.restic.diff_file_live') {
        return { binary: false, sizeA: 10, sizeB: 12, unifiedDiff: '@@ fixture @@', truncated: false };
      }
      throw new Error(`unexpected action ${input.actionId}`);
    },
  };
  const locations = {
    getFullConfigForAgent: async (id) => {
      assert.equal(id, location.id);
      return {
        id,
        type: 'LOCAL',
        config: { remotePath: '/srv/fixture-backups' },
        resticPassword: 'fixture-restic-secret',
      };
    },
  };
  const service = new ResticQueryOperationsService(
    prisma,
    relay,
    locations,
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
  return {
    backup,
    calls,
    location,
    otherSnapshotId,
    prisma,
    relay,
    service,
    site,
    snapshotId,
    user,
    worker,
  };
}

async function complete(state, accepted) {
  await state.worker.pollOnce();
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const row = await state.prisma.operation.findUnique({ where: { id: accepted.operationId } });
    if (row?.status === 'SUCCEEDED') return JSON.parse(row.result);
    if (['FAILED', 'NEEDS_ATTENTION'].includes(row?.status)) {
      assert.fail(`operation ${accepted.operationId} ended in ${row.status}: ${row.errorMessage}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`operation ${accepted.operationId} did not complete`);
}

function key(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

test('T-OPS-004 Restic list/tree/diff use bounded durable AgentJobs without persisted credentials', async (t) => {
  const state = await fixture(t);
  const actor = { userId: state.user.id, role: 'MANAGER' };
  const snapshotsKey = key('restic-snapshots');
  const snapshots = await state.service.enqueueSnapshots(
    state.site.id,
    state.location.id,
    actor,
    snapshotsKey,
  );
  const replay = await state.service.enqueueSnapshots(
    state.site.id,
    state.location.id,
    actor,
    snapshotsKey,
  );
  assert.equal(replay.operationId, snapshots.operationId);
  assert.equal(replay.replayed, true);
  assert.equal((await complete(state, snapshots))[0].inDatabase, true);

  const backupTree = await state.service.enqueueBackupTree(state.backup.id, actor, key('restic-tree'));
  assert.deepEqual(await complete(state, backupTree), {
    items: [{ name: 'public', type: 'dir', size: 4096 }],
  });

  const snapshotTree = await state.service.enqueueSnapshotTree({
    siteId: state.site.id,
    locationId: state.location.id,
    snapshotId: state.snapshotId,
  }, actor, key('restic-snapshot-tree'));
  await complete(state, snapshotTree);

  const snapshotsDiff = await state.service.enqueueDiffSnapshots({
    siteId: state.site.id,
    locationId: state.location.id,
    snapshotIdA: state.snapshotId,
    snapshotIdB: state.otherSnapshotId,
  }, actor, key('restic-diff-snapshots'));
  assert.equal((await complete(state, snapshotsDiff)).stats.changedFiles, 1);

  const liveDiff = await state.service.enqueueDiffLive({
    siteId: state.site.id,
    locationId: state.location.id,
    snapshotId: state.snapshotId,
  }, actor, key('restic-diff-live'));
  await complete(state, liveDiff);

  const filePath = `${state.site.rootPath}/public/index.php`;
  const fileDiff = await state.service.enqueueDiffFile({
    siteId: state.site.id,
    locationId: state.location.id,
    snapshotIdA: state.snapshotId,
    snapshotIdB: state.otherSnapshotId,
    filePath,
  }, actor, key('restic-diff-file'));
  assert.equal((await complete(state, fileDiff)).unifiedDiff, '@@ fixture @@');

  const liveFileDiff = await state.service.enqueueDiffFileLive({
    siteId: state.site.id,
    locationId: state.location.id,
    snapshotId: state.snapshotId,
    filePath,
  }, actor, key('restic-diff-file-live'));
  await complete(state, liveFileDiff);

  assert.deepEqual(state.calls.map((call) => call.actionId), [
    'agent.restic.snapshots',
    'agent.restic.list_tree',
    'agent.restic.list_tree',
    'agent.restic.diff_snapshots',
    'agent.restic.diff_live',
    'agent.restic.diff_file',
    'agent.restic.diff_file_live',
  ]);
  assert.equal(state.calls.every((call) => call.cancelSafe === true), true);
  const rows = await state.prisma.operation.findMany({
    where: { id: { in: [snapshots.operationId, backupTree.operationId, liveFileDiff.operationId] } },
  });
  const jobs = await state.prisma.agentJob.findMany();
  assert.equal(JSON.stringify(rows).includes('fixture-restic-secret'), false);
  assert.equal(JSON.stringify(jobs).includes('fixture-restic-secret'), false);
});

test('T-OPS-004 Restic durable queries preserve owner scope and file-root boundary', async (t) => {
  const state = await fixture(t);
  await assert.rejects(
    () => state.service.enqueueSnapshots(
      state.site.id,
      state.location.id,
      { userId: crypto.randomUUID(), role: 'MANAGER' },
      key('restic-denied'),
    ),
    /Access denied/,
  );
  await assert.rejects(
    () => state.service.enqueueDiffFileLive({
      siteId: state.site.id,
      locationId: state.location.id,
      snapshotId: state.snapshotId,
      filePath: '/etc/passwd',
    }, { userId: state.user.id, role: 'MANAGER' }, key('restic-outside-root')),
    /Файл вне корня сайта/,
  );
});

test('T-OPS-004 exhausted retry-safe Restic reads fail and release their lock', async (t) => {
  const state = await fixture(t);
  state.relay.runAgentJob = async () => {
    throw new Error('fixture repository offline');
  };
  const accepted = await state.service.enqueueSnapshots(
    state.site.id,
    state.location.id,
    { userId: state.user.id, role: 'MANAGER' },
    key('restic-retry-exhausted'),
  );
  const deadline = Date.now() + 3_000;
  let row;
  while (Date.now() < deadline) {
    await state.worker.pollOnce();
    row = await state.prisma.operation.findUnique({ where: { id: accepted.operationId } });
    if (row?.status === 'FAILED') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(row?.status, 'FAILED');
  assert.equal(row?.attempt, 3);
  assert.equal(
    await state.prisma.operationLock.count({ where: { operationId: accepted.operationId } }),
    0,
  );
});
