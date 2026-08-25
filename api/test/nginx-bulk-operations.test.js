'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  SitesNginxOperationsService,
} = require('../src/sites/sites-nginx-operations.service');

function executionContext(role = 'ADMIN') {
  return {
    operationId: crypto.randomUUID(),
    attempt: 1,
    recovering: false,
    deadlineAt: new Date(Date.now() + 60_000),
    actor: {
      kind: 'OPERATOR',
      userId: crypto.randomUUID(),
      role,
    },
    heartbeat: async () => {},
    isCancellationRequested: async () => false,
    throwIfCancellationRequested: async () => {},
  };
}

function fixture(result, connected = true) {
  const admissions = [];
  const handlers = new Map();
  const service = new SitesNginxOperationsService(
    { regenerateAll: async () => result },
    { isAgentConnected: () => connected },
    {
      admit: async (input) => {
        admissions.push(input);
        return { operationId: crypto.randomUUID(), replayed: false };
      },
    },
    {
      registerHandler: (actionId, handler) => {
        handlers.set(actionId, handler);
        return () => handlers.delete(actionId);
      },
    },
  );
  service.onModuleInit();
  return { admissions, handlers, service };
}

test('T-OPS-004 Nginx rebuild is a retry-safe exclusive operation', async () => {
  const state = fixture({ total: 0, ok: 0, failed: 0, details: [] });
  const actor = { userId: crypto.randomUUID(), role: 'ADMIN' };
  await state.service.enqueue(actor, `nginx-rebuild-${crypto.randomUUID()}`);
  const admitted = state.admissions[0];
  assert.equal(admitted.actionId, 'nginx.rebuild_all');
  assert.equal(admitted.recoveryPolicy, 'RETRY_SAFE');
  assert.equal(admitted.retryable, true);
  assert.equal(admitted.maxAttempts, 3);
  assert.equal(admitted.globalLockKey, 'nginx:rebuild-all');
  assert.deepEqual(
    await state.handlers.get('nginx.rebuild_all')({}, executionContext()),
    {
      total: 0,
      ok: 0,
      failed: 0,
      details: [],
      detailsTruncated: false,
    },
  );
});

test('T-OPS-006 partial Nginx rebuild fails for safe retry', async () => {
  const state = fixture({
    total: 2,
    ok: 1,
    failed: 1,
    details: [
      { siteName: 'healthy', status: 'ok' },
      { siteName: 'broken', status: 'failed', error: 'nginx -t failed' },
    ],
  });
  await assert.rejects(
    () => state.handlers.get('nginx.rebuild_all')({}, executionContext()),
    /failed for 1\/2 site\(s\): broken/,
  );
});

test('T-AUTH-003 Nginx rebuild denies non-ADMIN and offline admission', async () => {
  const denied = fixture({ total: 0, ok: 0, failed: 0, details: [] });
  await assert.rejects(
    () => denied.service.enqueue(
      { userId: crypto.randomUUID(), role: 'MANAGER' },
      `nginx-rebuild-${crypto.randomUUID()}`,
    ),
    /Only ADMIN/,
  );
  const offline = fixture({ total: 0, ok: 0, failed: 0, details: [] }, false);
  await assert.rejects(
    () => offline.service.enqueue(
      { userId: crypto.randomUUID(), role: 'ADMIN' },
      `nginx-rebuild-${crypto.randomUUID()}`,
    ),
    /Agent is offline/,
  );
});
