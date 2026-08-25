'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const masterKey = require('../src/common/crypto/master-key');
const {
  OperationSensitiveResultService,
} = require('../src/operations/operation-sensitive-result.service');
const { assertNoSecretFields } = require('../src/common/safe-persisted-json');

function fixture(t) {
  const previousMasterKey = process.env.MEOWBOX_MASTER_KEY;
  process.env.MEOWBOX_MASTER_KEY = crypto.randomBytes(32).toString('base64');
  masterKey._resetMasterKeyCacheForTests();
  const operationId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const row = {
    id: operationId,
    status: 'SUCCEEDED',
    createdByUserId: userId,
    result: null,
  };
  const prisma = {
    operation: {
      findUnique: async ({ where }) => where.id === row.id ? { ...row } : null,
      updateMany: async ({ where, data }) => {
        if (where.id !== row.id || where.status !== row.status || where.result !== row.result) {
          return { count: 0 };
        }
        row.result = data.result;
        return { count: 1 };
      },
    },
  };
  const service = new OperationSensitiveResultService(prisma);
  t.after(() => {
    if (previousMasterKey === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previousMasterKey;
    masterKey._resetMasterKeyCacheForTests();
  });
  return { operationId, row, service, userId };
}

test('T-OPS-007 sensitive operation output is encrypted and consumed atomically', async (t) => {
  const state = fixture(t);
  const password = `fixture-${crypto.randomUUID()}`;
  const envelope = state.service.seal(
    state.operationId,
    'DATABASE_CREDENTIALS',
    { password },
  );
  state.row.result = JSON.stringify({ databaseId: crypto.randomUUID(), sensitiveResult: envelope });
  assert.equal(state.row.result.includes(password), false);

  const consumed = await state.service.consume(state.operationId, state.userId);
  assert.deepEqual(consumed, {
    kind: 'DATABASE_CREDENTIALS',
    value: { password },
  });
  assert.equal(state.row.result.includes(envelope.sealed), false);
  assert.match(state.row.result, /sensitiveResultConsumedAt/);
  await assert.rejects(
    () => state.service.consume(state.operationId, state.userId),
    /unavailable/,
  );
});

test('T-OPS-007 sensitive output is owner-bound and tamper-evident', async (t) => {
  const state = fixture(t);
  const envelope = state.service.seal(
    state.operationId,
    'DATABASE_CREDENTIALS',
    { password: 'fixture' },
  );
  state.row.result = JSON.stringify({ sensitiveResult: envelope });
  await assert.rejects(
    () => state.service.consume(state.operationId, crypto.randomUUID()),
    /not found/i,
  );
  state.row.result = JSON.stringify({
    sensitiveResult: { ...envelope, sealed: `${envelope.sealed.slice(0, -1)}x` },
  });
  await assert.rejects(
    () => state.service.consume(state.operationId, state.userId),
    /unavailable/,
  );
});

test('operation redaction accepts catalogue action IDs but still rejects nested secrets', () => {
  assert.doesNotThrow(() => assertNoSecretFields({
    candidate: {
      manifest: {
        actions: {
          'http.post.sites-site-id-databases-id-reset-password': {
            actionId: 'http.post.sites-site-id-databases-id-reset-password',
            enabled: true,
          },
        },
      },
    },
  }));
  assert.throws(() => assertNoSecretFields({
    candidate: {
      manifest: {
        actions: {
          'http.post.sites-site-id-databases-id-reset-password': {
            password: 'must-never-persist',
          },
        },
      },
    },
  }), /forbidden secret field/);
  assert.throws(
    () => assertNoSecretFields({ passwordResetToken: 'must-never-persist' }),
    /forbidden secret field/,
  );
});
