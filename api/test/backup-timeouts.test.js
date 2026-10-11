'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveResticMaintenanceTimeouts } = require('@meowbox/shared');

test('Restic maintenance defaults leave margins for RPC and durable lease', () => {
  assert.deepEqual(resolveResticMaintenanceTimeouts(undefined), {
    processTimeoutMs: 7_200_000,
    rpcTimeoutMs: 7_500_000,
    leaseTimeoutMs: 7_800_000,
  });
});

test('Restic maintenance accepts a valid existing override and rejects invalid values', () => {
  assert.deepEqual(resolveResticMaintenanceTimeouts('1800000'), {
    processTimeoutMs: 1_800_000,
    rpcTimeoutMs: 2_100_000,
    leaseTimeoutMs: 2_400_000,
  });
  for (const raw of ['', '0', '-1', 'NaN', 'Infinity', '2147483648']) {
    assert.deepEqual(resolveResticMaintenanceTimeouts(raw), resolveResticMaintenanceTimeouts(undefined));
  }
});
