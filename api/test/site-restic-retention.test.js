'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const { BackupsService } = require('../src/backups/backups.service');

const globalPolicy = {
  keepDaily: 11,
  keepWeekly: 8,
  keepMonthly: 5,
  keepYearly: 3,
};

function backupRecord(overrides = {}) {
  return {
    id: 'backup-1',
    siteId: 'site-1',
    engine: 'RESTIC',
    storageLocationId: 'storage-1',
    site: { name: 'example.test' },
    config: null,
    schedule: null,
    ...overrides,
  };
}

function retentionFixture({ record = backupRecord(), responses = {} } = {}) {
  const events = [];
  const updates = [];
  let defaultsCalls = 0;
  const prisma = {
    backup: {
      findUnique: async () => record,
      updateMany: async (args) => {
        updates.push(args);
        return { count: 1 };
      },
    },
  };
  const relay = {
    emitToAgent: async (event, payload) => {
      events.push({ event, payload });
      return responses[event] || (
        event === 'restic:snapshots'
          ? { success: true, data: { snapshots: [{ id: 'alive-1' }] } }
          : { success: true }
      );
    },
  };
  const storageLocations = {
    getFullConfigForAgent: async () => ({
      id: 'storage-1',
      type: 'S3',
      config: { bucket: 'backups' },
      resticPassword: 'password',
    }),
  };
  const panelSettings = {
    getBackupDefaults: async () => {
      defaultsCalls += 1;
      return { retention: globalPolicy };
    },
  };
  const service = new BackupsService(
    prisma,
    relay,
    {},
    {},
    storageLocations,
    panelSettings,
    {},
    {},
    {},
  );
  service.logger = { warn() {} };

  return { service, events, updates, getDefaultsCalls: () => defaultsCalls };
}

test('site retention policy precedence is schedule, config, then global defaults', async () => {
  const schedulePolicy = {
    keepDaily: 0,
    keepWeekly: 2,
    keepMonthly: 0,
    keepYearly: 0,
  };
  const configPolicy = {
    keepDaily: 4,
    keepWeekly: 3,
    keepMonthly: 2,
    keepYearly: 1,
  };

  const scheduled = retentionFixture({
    record: backupRecord({
      schedule: schedulePolicy,
      config: configPolicy,
    }),
  });
  await scheduled.service.applyResticRetentionIfNeeded('backup-1');
  assert.deepEqual(scheduled.events[0].payload.policy, schedulePolicy);
  assert.equal(scheduled.getDefaultsCalls(), 0);
  assert.equal(scheduled.updates.length, 1);
  assert.deepEqual(
    {
      siteId: scheduled.updates[0].where.siteId,
      storageLocationId: scheduled.updates[0].where.storageLocationId,
      engine: scheduled.updates[0].where.engine,
    },
    { siteId: 'site-1', storageLocationId: 'storage-1', engine: 'RESTIC' },
  );

  const configured = retentionFixture({
    record: backupRecord({ config: configPolicy }),
  });
  await configured.service.applyResticRetentionIfNeeded('backup-1');
  assert.deepEqual(configured.events[0].payload.policy, configPolicy);
  assert.equal(configured.getDefaultsCalls(), 0);

  const global = retentionFixture();
  await global.service.applyResticRetentionIfNeeded('backup-1');
  assert.deepEqual(global.events[0].payload.policy, globalPolicy);
  assert.equal(global.getDefaultsCalls(), 1);
});

test('nested forget failure stops snapshot reconciliation', async () => {
  const fixture = retentionFixture({
    responses: {
      'restic:forget': {
        success: true,
        data: { success: false, error: 'prune failed' },
      },
    },
  });

  await fixture.service.applyResticRetentionIfNeeded('backup-1');

  assert.deepEqual(fixture.events.map(({ event }) => event), ['restic:forget']);
  assert.equal(fixture.updates.length, 0);
});

test('failed or malformed snapshot listing never marks snapshots removed', async () => {
  const responses = [
    { success: false, error: 'listing failed', data: { snapshots: [] } },
    { success: true, data: { success: false, error: 'listing failed', snapshots: [] } },
    { success: true, data: { success: 'false', snapshots: [] } },
    { success: true, data: { snapshots: [{ id: 42 }] } },
  ];

  for (const response of responses) {
    const fixture = retentionFixture({
      responses: { 'restic:snapshots': response },
    });
    await fixture.service.applyResticRetentionIfNeeded('backup-1');
    assert.equal(fixture.updates.length, 0);
  }
});
