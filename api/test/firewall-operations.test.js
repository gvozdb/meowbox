'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  FirewallOperationsService,
} = require('../src/firewall/firewall-operations.service');
const {
  OperationNeedsAttentionError,
} = require('../src/operations/operation-errors');

function context(recovering = false) {
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

function fixture(options = {}) {
  const rules = options.rules || [{
    action: 'ALLOW',
    protocol: 'TCP',
    port: '443',
    sourceIp: null,
    comment: 'HTTPS',
  }];
  const admissions = [];
  const calls = [];
  const handlers = new Map();
  const service = new FirewallOperationsService(
    {
      firewallRule: {
        findMany: async () => rules,
      },
    },
    {
      getPresets: () => [{ name: 'web-server' }],
      applyRuleSnapshots: async (snapshot) => {
        calls.push(['sync', snapshot]);
        return { applied: snapshot.length, failed: 0, total: snapshot.length };
      },
      applyPreset: async (name) => {
        calls.push(['preset', name]);
        return [{ id: crypto.randomUUID() }, { id: crypto.randomUUID() }];
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
  return { admissions, calls, handlers, service };
}

const actor = () => ({ userId: crypto.randomUUID(), role: 'ADMIN' });

test('T-OPS-004 firewall sync freezes a bounded rule snapshot', async () => {
  const state = fixture();
  await state.service.enqueueSync(actor(), `firewall-sync-${crypto.randomUUID()}`);
  const admitted = state.admissions[0];
  assert.equal(admitted.actionId, 'firewall.sync');
  assert.equal(admitted.globalLockKey, 'firewall:runtime');
  assert.equal(admitted.recoveryPolicy, 'RECONCILE_ONLY');
  assert.equal(admitted.retryable, false);
  assert.deepEqual(admitted.request.rules, [{
    action: 'ALLOW',
    protocol: 'TCP',
    port: '443',
    sourceIp: null,
    comment: 'HTTPS',
  }]);
  const result = await state.handlers.get('firewall.sync')(admitted.request, context());
  assert.deepEqual(result, { applied: 1, failed: 0, total: 1 });
  assert.equal(state.calls[0][0], 'sync');
});

test('T-OPS-004 firewall preset is allowlisted before admission', async () => {
  const state = fixture();
  await assert.rejects(
    () => state.service.enqueuePreset(
      '../arbitrary', actor(), `firewall-preset-${crypto.randomUUID()}`,
    ),
    /not found/,
  );
  await state.service.enqueuePreset(
    'web-server', actor(), `firewall-preset-${crypto.randomUUID()}`,
  );
  const admitted = state.admissions[0];
  assert.equal(admitted.actionId, 'firewall.apply_preset');
  assert.equal(admitted.globalLockKey, 'firewall:runtime');
  assert.deepEqual(
    await state.handlers.get('firewall.apply_preset')(admitted.request, context()),
    { presetName: 'web-server', created: 2 },
  );
});

test('T-OPS-006 firewall interruption needs manual reconciliation', async () => {
  const state = fixture();
  await state.service.enqueueSync(actor(), `firewall-sync-${crypto.randomUUID()}`);
  await assert.rejects(
    () => state.handlers.get('firewall.sync')(state.admissions[0].request, context(true)),
    OperationNeedsAttentionError,
  );
  assert.equal(state.calls.length, 0);
});

test('T-OPS-004 firewall sync rejects oversized snapshots', async () => {
  const rule = {
    action: 'ALLOW', protocol: 'TCP', port: '443', sourceIp: null, comment: null,
  };
  const state = fixture({ rules: Array(5_001).fill(rule) });
  await assert.rejects(
    () => state.service.enqueueSync(actor(), `firewall-sync-${crypto.randomUUID()}`),
    /too many rules/,
  );
  assert.equal(state.admissions.length, 0);
});
