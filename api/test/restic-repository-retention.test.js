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

function retentionFixture(scope, responses = {}) {
  const events = [];
  const updates = [];
  let listing = 0;
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
        const response = responses.snapshots?.[listing];
        listing++;
        return response ?? { success: true, data: { snapshots: listing === 1
          ? [{ id: 'alive-1' }, { id: 'removed-1' }]
          : [{ id: 'alive-1' }] } };
      }
      return responses.forget ?? { success: true };
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
    'restic:repository-snapshots',
    'restic:forget-repository',
    'restic:repository-snapshots',
  ]);
  assert.equal(fixture.events[1].payload.repoName, 'panel-db-hourly');
  assert.deepEqual(fixture.events[1].payload.policy, {
    keepDaily: 7,
    keepWeekly: 4,
    keepMonthly: 2,
    keepYearly: 1,
  });
  assert.deepEqual(fixture.updates[0].where.resticSnapshotId, { in: ['removed-1'] });
});

test('failed inner agent response never reconciles backup history', async () => {
  const fixture = retentionFixture('panel', {
    forget: { success: true, data: { success: false, error: 'forget failed' } },
  });
  await assert.rejects(fixture.service.applyForPanelBackup('backup-1'), /forget failed/);
  assert.deepEqual(fixture.events.map(({ event }) => event),
    ['restic:repository-snapshots', 'restic:forget-repository']);
  assert.equal(fixture.updates.length, 0);
});

test('all-zero policy performs no forget and leaves history untouched', async () => {
  const fixture = retentionFixture('panel');
  const record = await fixture.service.prisma.panelDataBackup.findUnique();
  Object.assign(record.config, { keepDaily: 0, keepWeekly: 0, keepMonthly: 0, keepYearly: 0 });
  await fixture.service.applyForPanelBackup('backup-1');
  assert.equal(fixture.events.length, 0);
  assert.equal(fixture.updates.length, 0);
});

test('malformed snapshot listing never marks history pruned', async () => {
  const fixture = retentionFixture('server', {
    snapshots: [{ success: true, data: { snapshots: [{ unexpected: 'id' }] } }],
  });
  await assert.rejects(fixture.service.applyForServerPathBackup('backup-1'), /Snapshot listing failed/);
  assert.equal(fixture.events.length, 1);
  assert.equal(fixture.updates.length, 0);
});

test('empty snapshot listing does not clear an entire config history', async () => {
  const fixture = retentionFixture('panel', {
    snapshots: [{ success: true, data: { snapshots: [] } }],
  });
  await assert.rejects(fixture.service.applyForPanelBackup('backup-1'), /Snapshot listing failed/);
  assert.equal(fixture.events.length, 1);
  assert.equal(fixture.updates.length, 0);
});

test('failed post-forget inventory cannot infer removed snapshot IDs', async () => {
  const fixture = retentionFixture('panel', {
    snapshots: [
      { success: true, data: { snapshots: [{ id: 'old-1' }] } },
      { success: true, data: { snapshots: [] } },
    ],
  });
  await assert.rejects(fixture.service.applyForPanelBackup('backup-1'), /Snapshot listing failed/);
  assert.deepEqual(fixture.events.map(({ event }) => event), [
    'restic:repository-snapshots', 'restic:forget-repository', 'restic:repository-snapshots',
  ]);
  assert.equal(fixture.updates.length, 0);
});

test('renamed config history is untouched when its old snapshots were absent before forget', async () => {
  const fixture = retentionFixture('panel', {
    snapshots: [
      { success: true, data: { snapshots: [{ id: 'new-repo-1' }] } },
      { success: true, data: { snapshots: [{ id: 'new-repo-1' }] } },
    ],
  });
  await fixture.service.applyForPanelBackup('backup-1');
  assert.deepEqual(fixture.events.map(({ event }) => event), [
    'restic:repository-snapshots', 'restic:forget-repository', 'restic:repository-snapshots',
  ]);
  assert.equal(fixture.updates.length, 0);
});

test('only IDs observed disappearing are marked pruned', async () => {
  const fixture = retentionFixture('server', {
    snapshots: [
      { success: true, data: { snapshots: [{ id: 'kept' }, { id: 'removed' }] } },
      { success: true, data: { snapshots: [{ id: 'kept' }, { id: 'new' }] } },
    ],
  });
  await fixture.service.applyForServerPathBackup('backup-1');
  assert.deepEqual(fixture.updates[0].where.resticSnapshotId, { in: ['removed'] });
});

test('periodic sweep retries a repository even when backup completion was lost', async () => {
  const rows = new Map();
  const events = [];
  const updates = [];
  const prisma = {
    panelDataBackup: {
      groupBy: async () => [{ configId: 'config-1', storageLocationId: 'storage-1' }],
      findFirst: async () => null,
      updateMany: async (args) => { updates.push(args); return { count: 0 }; },
    },
    serverPathBackup: { groupBy: async () => [] },
    panelDataBackupConfig: { findUnique: async () => ({ ...config('Panel DB Hourly'), engine: 'RESTIC' }) },
    panelSetting: {
      findUnique: async ({ where }) => rows.has(where.key) ? { key: where.key, value: rows.get(where.key) } : null,
      create: async ({ data }) => { rows.set(data.key, data.value); return data; },
      updateMany: async ({ where, data }) => {
        if (rows.get(where.key) !== where.value) return { count: 0 };
        rows.set(where.key, data.value);
        return { count: 1 };
      },
    },
  };
  let listing = 0;
  const relay = { emitToAgent: async (event) => {
    events.push(event);
    return event === 'restic:repository-snapshots'
      ? { success: true, data: { snapshots: listing++ === 0
        ? [{ id: 'alive-1' }, { id: 'removed-1' }] : [{ id: 'alive-1' }] } }
      : { success: true };
  } };
  const locations = { getFullConfigForAgent: async () => ({
    name: 'S3', type: 'S3', config: {}, resticPassword: 'test-password',
  }) };
  const now = new Date('2026-10-10T00:00:00Z');
  const service = new ResticRepositoryRetentionService(prisma, relay, locations);
  assert.deepEqual(await service.sweepDueRepositories(now), { attempted: 1, failed: 0 });
  assert.deepEqual(events, ['restic:repository-snapshots', 'restic:forget-repository', 'restic:repository-snapshots']);
  assert.equal(updates[0].where.configId, 'config-1');
  assert.deepEqual(updates[0].where.resticSnapshotId, { in: ['removed-1'] });
  const restarted = new ResticRepositoryRetentionService(prisma, relay, locations);
  assert.deepEqual(await restarted.sweepDueRepositories(now), { attempted: 0, failed: 0 });
});

test('sweep skips conflicting configs that normalize to the same repository', async () => {
  const prisma = {
    panelDataBackup: {
      groupBy: async () => [{ configId: 'panel-1', storageLocationId: 'storage-1' }],
    },
    serverPathBackup: {
      groupBy: async () => [{ configId: 'path-1', storageLocationId: 'storage-1' }],
    },
    panelDataBackupConfig: { findUnique: async () => ({ ...config('shared'), engine: 'RESTIC' }) },
    serverPathBackupConfig: { findUnique: async () => ({ ...config('shared'), engine: 'RESTIC' }) },
  };
  const relay = { emitToAgent: async () => { throw new Error('should not call agent'); } };
  const service = new ResticRepositoryRetentionService(prisma, relay, {});
  assert.deepEqual(await service.sweepDueRepositories(), { attempted: 0, failed: 0 });
});

test('server-path retention uses same fail-closed repository contract', async () => {
  const fixture = retentionFixture('server');
  await fixture.service.applyForServerPathBackup('backup-1');

  assert.equal(fixture.events[1].payload.repoName, 'root-daily');
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
