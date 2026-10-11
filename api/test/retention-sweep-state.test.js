'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { RetentionSweepState } = require('../src/backups/retention-sweep-state');
const { RESTIC_RETENTION_LEASE_MS } = require('../src/backups/restic-retention.constants');

function fixture() {
  const rows = new Map();
  const panelSetting = {
    create: async ({ data }) => {
      if (rows.has(data.key)) throw Object.assign(new Error('unique'), { code: 'P2002' });
      rows.set(data.key, data.value);
      return { ...data };
    },
    findUnique: async ({ where }) => rows.has(where.key)
      ? { key: where.key, value: rows.get(where.key) } : null,
    updateMany: async ({ where, data }) => {
      if (rows.get(where.key) !== where.value) return { count: 0 };
      rows.set(where.key, data.value);
      return { count: 1 };
    },
  };
  return { rows, prisma: { panelSetting } };
}

test('lease and successful cadence survive a new service instance', async () => {
  const { prisma } = fixture();
  const first = new RetentionSweepState(prisma);
  const now = new Date('2026-10-10T00:00:00Z');
  const lease = await first.claim('location-1', 'repo-1', now);
  assert.ok(lease);
  assert.equal(await new RetentionSweepState(prisma).claim('location-1', 'repo-1', now), null);
  assert.equal(await first.finish(lease, true, now), true);
  assert.equal(await new RetentionSweepState(prisma).claim('location-1', 'repo-1', new Date(now.getTime() + 23 * 3600000)), null);
  assert.ok(await new RetentionSweepState(prisma).claim('location-1', 'repo-1', new Date(now.getTime() + 24 * 3600000)));
});

test('failure retries after delay, expired lease recovers, stale finish cannot overwrite new owner', async () => {
  const { prisma } = fixture();
  const state = new RetentionSweepState(prisma);
  const now = new Date('2026-10-10T00:00:00Z');
  const first = await state.claim('location-1', 'repo-1', now);
  assert.equal(await state.finish(first, false, now), true);
  assert.equal(await state.claim('location-1', 'repo-1', new Date(now.getTime() + 3600000)), null);
  const retry = await state.claim('location-1', 'repo-1', new Date(now.getTime() + 2 * 3600000));
  assert.ok(retry);
  const retryAt = now.getTime() + 2 * 3600000;
  assert.equal(await state.claim('location-1', 'repo-1', new Date(retryAt + RESTIC_RETENTION_LEASE_MS - 1)), null);
  const recovered = await state.claim('location-1', 'repo-1', new Date(retryAt + RESTIC_RETENTION_LEASE_MS));
  assert.ok(recovered);
  assert.equal(await state.finish(retry, true, now), false);
});
