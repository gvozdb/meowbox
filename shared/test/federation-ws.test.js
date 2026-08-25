'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  validateFederatedWsAck,
  validateFederatedWsState,
} = require('../dist');

test('T-WS-001 state contract binds READY timestamp and bounded retry', () => {
  assert.equal(validateFederatedWsState({
    state: 'READY', reasonCode: 'READY',
    readyAt: '2026-08-24T16:00:00.000Z', retryAfterMs: null,
  }).state, 'READY');
  assert.throws(() => validateFederatedWsState({
    state: 'READY', reasonCode: 'READY', readyAt: null, retryAfterMs: null,
  }), /readyAt/);
  assert.throws(() => validateFederatedWsState({
    state: 'DEGRADED', reasonCode: 'REMOTE_OFFLINE', readyAt: null, retryAfterMs: 30_001,
  }), /retryAfterMs/);
});

test('T-WS-004 ack contract carries only correlation result and bounded metadata', () => {
  assert.deepEqual(validateFederatedWsAck({
    acceptedSequence: 4,
    outcome: 'COMPLETED',
    code: null,
    message: null,
    result: { sessionId: 'terminal-1' },
  }).result, { sessionId: 'terminal-1' });
  assert.throws(() => validateFederatedWsAck({
    acceptedSequence: 4,
    outcome: 'COMPLETED',
    code: null,
    message: null,
  }), /result is required/);
});
