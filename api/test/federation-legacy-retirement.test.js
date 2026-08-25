'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  evaluateFederationLegacyRetirement,
} = require('../src/federation/federation-legacy-retirement');

const now = new Date('2026-08-25T12:00:00.000Z');

test('T-LEG-001 legacy retirement requires every measurable DB9 criterion', () => {
  const accepted = evaluateFederationLegacyRetirement({
    registeredLegacyPeers: 0,
    fallbackUses: 0,
    zeroUseSince: '2026-07-26T12:00:00.000Z',
    releasesWithZeroUse: 2,
    rollbackDrillPassed: true,
    keyDrillPassed: true,
    operatorApproved: true,
  }, now);
  assert.deepEqual(accepted, { eligible: true, blockers: [], observedZeroUseDays: 30 });

  const blocked = evaluateFederationLegacyRetirement({
    registeredLegacyPeers: 1,
    fallbackUses: 1,
    zeroUseSince: '2026-07-27T12:00:00.000Z',
    releasesWithZeroUse: 1,
    rollbackDrillPassed: false,
    keyDrillPassed: false,
    operatorApproved: false,
  }, now);
  assert.equal(blocked.eligible, false);
  assert.deepEqual(blocked.blockers, [
    'REGISTERED_LEGACY_PEERS',
    'LEGACY_FALLBACK_USE',
    'ZERO_USE_WINDOW_LT_30_DAYS',
    'ZERO_USE_RELEASES_LT_2',
    'ROLLBACK_DRILL_UNVERIFIED',
    'KEY_DRILL_UNVERIFIED',
    'OPERATOR_APPROVAL_REQUIRED',
  ]);
});

test('T-LEG-001 invalid counters and future evidence fail closed', () => {
  const base = {
    registeredLegacyPeers: 0,
    fallbackUses: 0,
    zeroUseSince: now.toISOString(),
    releasesWithZeroUse: 2,
    rollbackDrillPassed: true,
    keyDrillPassed: true,
    operatorApproved: true,
  };
  assert.throws(() => evaluateFederationLegacyRetirement({ ...base, fallbackUses: -1 }, now));
  assert.throws(() => evaluateFederationLegacyRetirement({
    ...base,
    zeroUseSince: '2026-08-26T00:00:00.000Z',
  }, now));
});

