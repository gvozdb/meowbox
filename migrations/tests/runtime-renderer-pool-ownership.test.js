'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  shouldDeleteExistingPool,
} = require('../dist/runtime-renderer');

const domainId = '20000000-0000-4000-8000-000000000001';
const otherDomainId = '20000000-0000-4000-8000-000000000002';
const target = '/etc/php/7.2/fpm/pool.d/kvd.conf';
const desiredOwner = { domainId, runtimeKey: 'kvd' };
const canWrite = (previousDomainId, nextDomainId, runtimeKey) =>
  previousDomainId === nextDomainId ||
  previousDomainId === `migrated-${runtimeKey}`;

function classify(overrides = {}) {
  return shouldDeleteExistingPool({
    target,
    existingDomainId: domainId,
    desiredOwner,
    desiredTargetForExistingDomain: target,
    existingDomainRemains: true,
    canWrite,
    ...overrides,
  });
}

test('runtime renderer adopts the exact legacy Hostpanel pool owner in place', () => {
  assert.equal(
    classify({ existingDomainId: 'migrated-kvd' }),
    false,
  );
  assert.equal(classify(), false);
});

test('runtime renderer rejects an unrelated owner at a desired pool target', () => {
  assert.throws(
    () => classify({ existingDomainId: otherDomainId }),
    /PHP-FPM pool ownership collision/,
  );
  assert.throws(
    () => classify({ existingDomainId: 'migrated-other' }),
    /PHP-FPM pool ownership collision/,
  );
});

test('runtime renderer still removes stale and relocated managed pools', () => {
  assert.equal(
    classify({
      desiredOwner: undefined,
      desiredTargetForExistingDomain: undefined,
      existingDomainRemains: false,
    }),
    true,
  );
  assert.equal(
    classify({
      desiredOwner: undefined,
      desiredTargetForExistingDomain:
        '/etc/php/8.3/fpm/pool.d/kvd.conf',
    }),
    true,
  );
});
