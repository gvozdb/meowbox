'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  BackupDeleteOperationsService,
} = require('../src/backups/backup-delete-operations.service');
const {
  OperationNeedsAttentionError,
} = require('../src/operations/operation-errors');

function fixture(overrides = {}) {
  const backupId = crypto.randomUUID();
  const ownerId = crypto.randomUUID();
  let backup = {
    id: backupId,
    siteId: crypto.randomUUID(),
    status: 'COMPLETED',
    site: { userId: ownerId },
  };
  let handler;
  let unregistered = false;
  const admissions = [];
  const deletions = [];
  const service = new BackupDeleteOperationsService(
    {
      backup: {
        findUnique: async () => backup,
      },
    },
    {
      deleteBackup: async (...args) => {
        deletions.push(args);
        backup = null;
        return { removed: true };
      },
    },
    {
      admit: async (input) => {
        admissions.push(input);
        return { operationId: crypto.randomUUID(), replayed: false };
      },
    },
    {
      registerHandler: (actionId, registeredHandler) => {
        assert.equal(actionId, 'backups.delete');
        handler = registeredHandler;
        return () => {
          unregistered = true;
        };
      },
    },
  );
  if (overrides.backup !== undefined) backup = overrides.backup;
  service.onModuleInit();
  return {
    admissions,
    backupId,
    deletions,
    handler: (...args) => handler(...args),
    ownerId,
    service,
    setBackup: (value) => {
      backup = value;
    },
    wasUnregistered: () => unregistered,
  };
}

function context({ recovering = false, userId, role = 'ADMIN' } = {}) {
  let cancellationChecks = 0;
  return {
    value: {
      operationId: crypto.randomUUID(),
      attempt: recovering ? 2 : 1,
      recovering,
      deadlineAt: new Date(Date.now() + 60_000),
      actor: {
        kind: 'OPERATOR',
        userId: userId ?? crypto.randomUUID(),
        role,
      },
      heartbeat: async () => {},
      isCancellationRequested: async () => false,
      throwIfCancellationRequested: async () => {
        cancellationChecks += 1;
      },
    },
    cancellationChecks: () => cancellationChecks,
  };
}

test('T-OPS-004 backup deletion admits one reconcile-only durable operation', async () => {
  const state = fixture();
  const key = `backup-delete-${crypto.randomUUID()}`;
  const accepted = await state.service.enqueue(
    state.backupId,
    { userId: state.ownerId, role: 'MANAGER' },
    key,
  );

  assert.match(accepted.operationId, /^[0-9a-f-]{36}$/);
  assert.equal(state.admissions.length, 1);
  assert.deepEqual(state.admissions[0], {
    actionId: 'backups.delete',
    type: 'BACKUP_DELETE',
    idempotencyKey: key,
    actor: { userId: state.ownerId, role: 'MANAGER' },
    request: { backupId: state.backupId },
    deadlineMs: 2 * 60 * 60_000,
    recoveryPolicy: 'RECONCILE_ONLY',
    retryable: false,
    globalLockKey: `backup-delete:${state.backupId}`,
    siteId: state.admissions[0].siteId,
    lockSite: false,
  });
  state.service.onModuleDestroy();
  assert.equal(state.wasUnregistered(), true);
});

test('T-OPS-004 backup deletion enforces ownership and rejects active backups', async () => {
  const state = fixture();
  await assert.rejects(
    () => state.service.enqueue(
      state.backupId,
      { userId: crypto.randomUUID(), role: 'MANAGER' },
      `backup-delete-denied-${crypto.randomUUID()}`,
    ),
    /Access denied/,
  );
  state.setBackup({
    id: state.backupId,
    siteId: crypto.randomUUID(),
    status: 'IN_PROGRESS',
    site: { userId: state.ownerId },
  });
  await assert.rejects(
    () => state.service.enqueue(
      state.backupId,
      { userId: state.ownerId, role: 'MANAGER' },
      `backup-delete-active-${crypto.randomUUID()}`,
    ),
    /Active backup cannot be deleted/,
  );
  assert.equal(state.admissions.length, 0);
});

test('T-OPS-006 backup deletion never retries an ambiguous physical delete', async () => {
  const state = fixture();
  const first = context({ userId: state.ownerId });
  const result = await state.handler(
    { backupId: state.backupId },
    first.value,
  );
  assert.deepEqual(result, {
    backupId: state.backupId,
    deleted: true,
    result: { removed: true },
  });
  assert.equal(first.cancellationChecks(), 1);
  assert.deepEqual(state.deletions, [[state.backupId, state.ownerId, 'ADMIN']]);

  const recoveredMissing = context({ recovering: true, userId: state.ownerId });
  assert.deepEqual(
    await state.handler({ backupId: state.backupId }, recoveredMissing.value),
    { backupId: state.backupId, deleted: true },
  );

  state.setBackup({ id: state.backupId });
  const recoveredAmbiguous = context({ recovering: true, userId: state.ownerId });
  await assert.rejects(
    () => state.handler({ backupId: state.backupId }, recoveredAmbiguous.value),
    OperationNeedsAttentionError,
  );
  assert.equal(state.deletions.length, 1);
});

test('T-OPS-004 backup deletion rejects malformed durable payloads', async () => {
  const state = fixture();
  const execution = context({ userId: state.ownerId });
  await assert.rejects(
    () => state.handler({ backupId: '../backup' }, execution.value),
    /request is invalid/,
  );
  await assert.rejects(
    () => state.handler({ backupId: state.backupId, extra: true }, execution.value),
    /request is invalid/,
  );
});
