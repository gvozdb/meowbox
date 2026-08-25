'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const masterKey = require('../src/common/crypto/master-key');
const {
  DNS_OPERATION_ACTIONS,
  DnsOperationsService,
} = require('../src/dns/dns-operations.service');
const {
  OperationNeedsAttentionError,
} = require('../src/operations/operation-errors');

function executionContext(recovering = false) {
  return {
    operationId: crypto.randomUUID(),
    attempt: recovering ? 2 : 1,
    recovering,
    deadlineAt: new Date(Date.now() + 60_000),
    actor: {
      kind: 'OPERATOR',
      userId: crypto.randomUUID(),
      role: 'ADMIN',
    },
    heartbeat: async () => {},
    isCancellationRequested: async () => false,
    throwIfCancellationRequested: async () => {},
  };
}

function fixture(t) {
  const previousMasterKey = process.env.MEOWBOX_MASTER_KEY;
  process.env.MEOWBOX_MASTER_KEY = crypto.randomBytes(32).toString('base64');
  masterKey._resetMasterKeyCacheForTests();
  const providerId = crypto.randomUUID();
  const zoneId = crypto.randomUUID();
  const admissions = [];
  const handlers = new Map();
  const calls = [];
  const service = new DnsOperationsService(
    {
      dnsProviderAccount: {
        findUnique: async ({ where }) => where.id === providerId ? { id: providerId } : null,
      },
      dnsZone: {
        findUnique: async ({ where }) => where.id === zoneId
          ? { accountId: providerId }
          : null,
      },
    },
    {
      createProvider: async (dto, requestedId) => {
        calls.push(['create', dto, requestedId]);
        return { id: requestedId, label: dto.label };
      },
      testProvider: async (id) => {
        calls.push(['test', id]);
        return { ok: true };
      },
      syncProviderFull: async (id) => {
        calls.push(['sync', id]);
        return { zonesAdded: 1, zonesRemoved: 0, zonesTotal: 1, recordsRefreshed: 1, recordsFailed: 0 };
      },
      refreshRecords: async (id) => {
        calls.push(['refresh', id]);
      },
      applyMailTemplate: async (id, dto) => {
        calls.push(['template', id, dto]);
        return { created: [{ type: 'MX', name: '@' }], skipped: [] };
      },
    },
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
  t.after(() => {
    service.onModuleDestroy();
    if (previousMasterKey === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previousMasterKey;
    masterKey._resetMasterKeyCacheForTests();
  });
  return { admissions, calls, handlers, providerId, service, zoneId };
}

const actor = () => ({ userId: crypto.randomUUID(), role: 'ADMIN' });

test('T-OPS-004 DNS provider enrollment persists only encrypted credentials', async (t) => {
  const state = fixture(t);
  const secret = `dns-provider-secret-${crypto.randomUUID()}`;
  const accepted = await state.service.enqueueCreateProvider(
    { type: 'CLOUDFLARE', label: 'fixture', credentials: { apiToken: secret } },
    actor(),
    `dns-create-${crypto.randomUUID()}`,
  );
  assert.match(accepted.operationId, /^[0-9a-f-]{36}$/);
  const admitted = state.admissions[0];
  assert.equal(admitted.actionId, DNS_OPERATION_ACTIONS.CREATE_PROVIDER);
  assert.equal(admitted.recoveryPolicy, 'RECONCILE_ONLY');
  assert.equal(admitted.retryable, false);
  assert.equal(JSON.stringify(admitted).includes(secret), false);

  const result = await state.handlers.get(DNS_OPERATION_ACTIONS.CREATE_PROVIDER)(
    admitted.request,
    executionContext(),
  );
  assert.equal(result.providerId, admitted.request.providerId);
  assert.equal(state.calls[0][0], 'create');
  assert.equal(state.calls[0][1].credentials.apiToken, secret);
  assert.equal(state.calls[0][2], admitted.request.providerId);
});

test('T-OPS-004 DNS provider and zone jobs are serialized by provider', async (t) => {
  const state = fixture(t);
  await state.service.enqueueProvider(
    'TEST_PROVIDER', state.providerId, actor(), `dns-test-${crypto.randomUUID()}`,
  );
  await state.service.enqueueProvider(
    'SYNC_PROVIDER', state.providerId, actor(), `dns-sync-${crypto.randomUUID()}`,
  );
  await state.service.enqueueRefreshZone(
    state.zoneId, actor(), `dns-refresh-${crypto.randomUUID()}`,
  );
  await state.service.enqueueApplyTemplate(
    state.zoneId,
    { template: 'YANDEX_MAIL', extras: { dkimSelector: 'mail' } },
    actor(),
    `dns-template-${crypto.randomUUID()}`,
  );
  assert.deepEqual(
    state.admissions.map((item) => item.globalLockKey),
    Array(4).fill(`dns-provider:${state.providerId}`),
  );

  for (const admitted of state.admissions) {
    await state.handlers.get(admitted.actionId)(admitted.request, executionContext());
  }
  assert.deepEqual(state.calls.map((call) => call[0]), ['test', 'sync', 'refresh', 'template']);
});

test('T-OPS-006 DNS jobs fail closed after ambiguous interruption', async (t) => {
  const state = fixture(t);
  const admitted = await state.service.enqueueProvider(
    'SYNC_PROVIDER', state.providerId, actor(), `dns-sync-${crypto.randomUUID()}`,
  );
  assert.ok(admitted.operationId);
  await assert.rejects(
    () => state.handlers.get(DNS_OPERATION_ACTIONS.SYNC_PROVIDER)(
      state.admissions[0].request,
      executionContext(true),
    ),
    OperationNeedsAttentionError,
  );
  assert.equal(state.calls.length, 0);
});

test('T-OPS-006 recovered provider enrollment accepts only confirmed DB postcondition', async (t) => {
  const state = fixture(t);
  await state.service.enqueueCreateProvider(
    { type: 'CLOUDFLARE', label: 'fixture', credentials: { apiToken: 'fixture-token' } },
    actor(),
    `dns-create-${crypto.randomUUID()}`,
  );
  const request = state.admissions[0].request;
  await assert.rejects(
    () => state.handlers.get(DNS_OPERATION_ACTIONS.TEST_PROVIDER)(
      request,
      executionContext(),
    ),
    /action does not match/,
  );
  const recovered = await state.handlers.get(DNS_OPERATION_ACTIONS.CREATE_PROVIDER)(
    { ...request, providerId: state.providerId },
    executionContext(true),
  );
  assert.deepEqual(recovered, { providerId: state.providerId, recovered: true });
});
