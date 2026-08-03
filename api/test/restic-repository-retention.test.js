'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  failStaleBackupRuns,
} = require('../src/backups/backup-run-recovery');
const {
  resticRepositoryName,
} = require('../src/backups/restic-repository-name');
const {
  ResticRepositoryRetentionService,
} = require('../src/backups/restic-repository-retention.service');

function backupRecord(config) {
  return {
    id: 'backup-1',
    engine: 'RESTIC',
    storageLocationId: 'storage-1',
    config,
  };
}

function config(name) {
  return {
    id: 'config-1',
    name,
    keepDaily: 7,
    keepWeekly: 4,
    keepMonthly: 2,
    keepYearly: 1,
  };
}

function retentionFixture(scope) {
  const events = [];
  const updates = [];
  const panelRecord = scope === 'panel' ? backupRecord(config('Panel DB Hourly')) : null;
  const serverRecord = scope === 'server' ? backupRecord(config('Root Daily')) : null;
  const prisma = {
    panelDataBackup: {
      findUnique: async () => panelRecord,
      updateMany: async (args) => {
        updates.push(args);
        return { count: 1 };
      },
    },
    serverPathBackup: {
      findUnique: async () => serverRecord,
      updateMany: async (args) => {
        updates.push(args);
        return { count: 1 };
      },
    },
  };
  const relay = {
    emitToAgent: async (event, payload) => {
      events.push({ event, payload });
      if (event === 'restic:repository-snapshots') {
        return { success: true, data: { snapshots: [{ id: 'alive-1' }] } };
      }
      return { success: true };
    },
  };
  const storageLocations = {
    getFullConfigForAgent: async () => ({
      id: 'storage-1',
      name: 'S3',
      type: 'S3',
      config: { bucket: 'backups' },
      resticPassword: 'password',
    }),
  };
  return {
    events,
    updates,
    service: new ResticRepositoryRetentionService(prisma, relay, storageLocations),
  };
}

test('panel-data retention uses repository events and reconciles pruned history', async () => {
  const fixture = retentionFixture('panel');
  await fixture.service.applyForPanelBackup('backup-1');

  assert.deepEqual(fixture.events.map(({ event }) => event), [
    'restic:forget-repository',
    'restic:repository-snapshots',
  ]);
  assert.equal(fixture.events[0].payload.repoName, 'panel-db-hourly');
  assert.deepEqual(fixture.events[0].payload.policy, {
    keepDaily: 7,
    keepWeekly: 4,
    keepMonthly: 2,
    keepYearly: 1,
  });
  assert.deepEqual(fixture.updates[0].where.NOT, {
    resticSnapshotId: { in: ['alive-1'] },
  });
});

test('server-path retention uses same fail-closed repository contract', async () => {
  const fixture = retentionFixture('server');
  await fixture.service.applyForServerPathBackup('backup-1');

  assert.equal(fixture.events[0].payload.repoName, 'root-daily');
  assert.equal(fixture.updates[0].where.configId, 'config-1');
  assert.equal(fixture.updates[0].data.filePath, '');
});

test('repository name is deterministic and bounded', () => {
  assert.equal(resticRepositoryName('  ROOT daily  ', 'fallback'), 'root-daily');
  assert.equal(resticRepositoryName('***', 'fallback'), 'fallback');
  assert.equal(resticRepositoryName('x'.repeat(100), 'fallback').length, 60);
});

test('stale backup recovery covers site, server-path and panel-data runs', async () => {
  const calls = [];
  const table = (count) => ({
    updateMany: async (args) => {
      calls.push(args);
      return { count };
    },
  });
  const cutoff = new Date('2026-08-03T00:00:00.000Z');
  const completedAt = new Date('2026-08-03T04:00:00.000Z');

  const result = await failStaleBackupRuns(
    {
      backup: table(1),
      serverPathBackup: table(2),
      panelDataBackup: table(3),
    },
    cutoff,
    completedAt,
  );

  assert.deepEqual(result, { site: 1, serverPath: 2, panelData: 3 });
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.deepEqual(call.where.status.in, ['PENDING', 'IN_PROGRESS']);
    assert.equal(call.where.createdAt.lt, cutoff);
    assert.equal(call.data.status, 'FAILED');
    assert.equal(call.data.completedAt, completedAt);
  }
});
