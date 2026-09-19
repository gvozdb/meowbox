'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  OperationFailedError,
  OperationNeedsAttentionError,
} = require('../src/operations/operation-errors');
const {
  SiteDeleteOperationsService,
} = require('../src/sites/site-delete-operations.service');

const options = {
  confirmSiteName: 'demo',
  confirmDataDeletion: true,
  removeSslCertificate: true,
  removeBackupsLocal: true,
  removeBackupsRestic: false,
  removeBackupsRemote: false,
  removeDatabases: true,
  removeFiles: true,
  removeMinioData: false,
  removeSystemUser: true,
  removeNginxConfig: true,
  removePhpPool: true,
};

function context({ recovering = false, userId, role = 'ADMIN' } = {}) {
  return {
    operationId: crypto.randomUUID(),
    attempt: recovering ? 2 : 1,
    recovering,
    deadlineAt: new Date(Date.now() + 60_000),
    actor: {
      kind: 'OPERATOR',
      userId: userId || crypto.randomUUID(),
      role,
    },
    heartbeat: async () => undefined,
    isCancellationRequested: async () => false,
    throwIfCancellationRequested: async () => undefined,
  };
}

function fixture() {
  const siteId = crypto.randomUUID();
  const ownerId = crypto.randomUUID();
  let site = { id: siteId };
  let existingOperation = null;
  let handler;
  let unregistered = false;
  const admissions = [];
  const preflights = [];
  const executions = [];
  const cleanups = [];
  const recoveryMarks = [];
  const sites = {
    assertDeleteReady: async (...args) => {
      preflights.push(args);
      return { id: siteId, name: 'demo' };
    },
    executeDelete: async (...args) => {
      executions.push(args);
      return { deletedSiteId: siteId, siteName: 'demo' };
    },
    cleanupDeleteOperationSnapshots: async (...args) => {
      cleanups.push(args);
    },
    markDeleteRecoveryAttention: async (...args) => {
      recoveryMarks.push(args);
    },
  };
  const service = new SiteDeleteOperationsService(
    {
      site: {
        findUnique: async () => site,
      },
      operation: {
        findUnique: async () => existingOperation,
      },
    },
    sites,
    {
      admit: async (input) => {
        admissions.push(input);
        return { operationId: crypto.randomUUID(), replayed: false };
      },
    },
    {
      registerHandler: (actionId, registeredHandler) => {
        assert.equal(actionId, 'sites.delete');
        handler = registeredHandler;
        return () => {
          unregistered = true;
        };
      },
    },
  );
  service.onModuleInit();
  return {
    admissions,
    cleanups,
    executions,
    handler: (...args) => handler(...args),
    ownerId,
    preflights,
    recoveryMarks,
    service,
    setSite: (value) => {
      site = value;
    },
    setExistingOperation: (value) => {
      existingOperation = value;
    },
    siteId,
    wasUnregistered: () => unregistered,
  };
}

test('site deletion admits one locked reconcile-only durable operation', async () => {
  const state = fixture();
  const key = `site-delete-${crypto.randomUUID()}`;
  const accepted = await state.service.enqueue(
    state.siteId,
    { userId: state.ownerId, role: 'ADMIN' },
    options,
    key,
  );

  assert.match(accepted.operationId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(state.preflights, [
    [state.siteId, state.ownerId, 'ADMIN', options],
  ]);
  assert.deepEqual(state.admissions, [
    {
      actionId: 'sites.delete',
      type: 'SITE_DELETE',
      idempotencyKey: key,
      actor: { userId: state.ownerId, role: 'ADMIN' },
      request: { siteId: state.siteId, options },
      deadlineMs: 4 * 60 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      globalLockKey: 'hostname-registry',
      siteId: state.siteId,
      lockSite: true,
    },
  ]);
  state.service.onModuleDestroy();
  assert.equal(state.wasUnregistered(), true);
});

test('site deletion replays admission before mutable preflight state', async () => {
  const state = fixture();
  state.setExistingOperation({ id: crypto.randomUUID() });
  state.setSite(null);
  const key = `site-delete-${crypto.randomUUID()}`;

  await state.service.enqueue(
    state.siteId,
    { userId: state.ownerId, role: 'ADMIN' },
    options,
    key,
  );

  assert.equal(state.preflights.length, 0);
  assert.equal(state.admissions.length, 1);
  assert.equal(state.admissions[0].idempotencyKey, key);
});

test('site deletion executes once and fails closed for a non-admin policy', async () => {
  const state = fixture();
  const execution = context({ userId: state.ownerId });
  assert.deepEqual(
    await state.handler(
      { siteId: state.siteId, options },
      execution,
    ),
    { deletedSiteId: state.siteId, siteName: 'demo' },
  );
  assert.deepEqual(state.executions, [
    [state.siteId, options, execution],
  ]);

  await assert.rejects(
    () => state.handler(
      { siteId: state.siteId, options },
      context({ role: 'MANAGER' }),
    ),
    OperationFailedError,
  );
  assert.equal(state.executions.length, 1);
});

test('site deletion recovery reconciles only a confirmed missing Site', async () => {
  const state = fixture();
  state.setSite(null);
  const missingContext = context({ recovering: true });
  assert.deepEqual(
    await state.handler(
      { siteId: state.siteId, options },
      missingContext,
    ),
    { deletedSiteId: state.siteId, siteName: 'demo' },
  );
  assert.deepEqual(state.cleanups, [[missingContext]]);

  state.setSite({ id: state.siteId });
  const ambiguousContext = context({ recovering: true });
  await assert.rejects(
    () => state.handler(
      { siteId: state.siteId, options },
      ambiguousContext,
    ),
    OperationNeedsAttentionError,
  );
  assert.equal(state.recoveryMarks.length, 1);
  assert.equal(state.recoveryMarks[0][0], state.siteId);
  assert.match(state.recoveryMarks[0][1], /interrupted/);
  assert.equal(state.executions.length, 0);
});

test('site deletion rejects malformed durable payloads', async () => {
  const state = fixture();
  const execution = context();
  await assert.rejects(
    () => state.handler(
      { siteId: '../site', options },
      execution,
    ),
    /request is invalid/,
  );
  await assert.rejects(
    () => state.handler(
      { siteId: state.siteId, options: { ...options, extra: true } },
      execution,
    ),
    /request is invalid/,
  );
  await assert.rejects(
    () => state.handler(
      {
        siteId: state.siteId,
        options: { ...options, confirmDataDeletion: false },
      },
      execution,
    ),
    /request is invalid/,
  );
});
