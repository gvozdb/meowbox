'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  validateAgentJobHeartbeat,
  validateAgentJobResult,
  validateAgentJobStart,
} = require('../dist');

function start(overrides = {}) {
  return {
    protocolVersion: 1,
    jobId: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    actionId: 'agent.test.execute',
    step: 'execute',
    requestHash: crypto.randomBytes(32).toString('hex'),
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    cancelSafe: true,
    payload: { value: 42 },
    ...overrides,
  };
}

test('T-OPS-004 AgentJob protocol validates exact bounded identities', () => {
  const valid = start();
  assert.deepEqual(validateAgentJobStart(valid), valid);
  assert.throws(() => validateAgentJobStart({ ...valid, extra: true }), /not allowed/);
  assert.throws(() => validateAgentJobStart({ ...valid, protocolVersion: 2 }), /invalid/);
  assert.throws(
    () => validateAgentJobStart({ ...valid, payload: 'x'.repeat(1024 * 1024 + 1) }),
    /exceeds/,
  );
});

test('T-OPS-004 AgentJob heartbeat/result reject malformed state', () => {
  const identity = {
    jobId: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    bootId: crypto.randomUUID(),
  };
  const heartbeat = {
    ...identity,
    sequence: 1,
    progress: 50,
    step: 'half',
    timestamp: new Date().toISOString(),
  };
  assert.deepEqual(validateAgentJobHeartbeat(heartbeat), heartbeat);
  assert.throws(() => validateAgentJobHeartbeat({ ...heartbeat, progress: 101 }), /invalid/);

  const result = {
    ...identity,
    sequence: 2,
    success: true,
    cancelled: false,
    result: { ok: true },
    error: null,
    timestamp: new Date().toISOString(),
  };
  assert.deepEqual(validateAgentJobResult(result), result);
  assert.throws(
    () => validateAgentJobResult({ ...result, cancelled: true }),
    /inconsistent|invalid/,
  );
});
