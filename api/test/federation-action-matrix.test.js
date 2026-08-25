'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  resolveFederationAction,
  validateFederationActionMatrix,
} = require('../../shared/src/federation-actions');
const {
  discoverCurrentSurface,
  legacyFindingsFromSurface,
  matrixEntriesFromSurface,
} = require('./remote-panel-parity-inventory');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const matrixPath = path.join(
  repositoryRoot,
  'specs',
  'remote-panel-parity',
  'action-matrix.yaml',
);
const overridesPath = path.join(
  repositoryRoot,
  'specs',
  'remote-panel-parity',
  'action-overrides.json',
);

function loadMatrix() {
  return JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
}

function activeActionIds() {
  const overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
  return new Set([
    ...Object.keys(overrides.actions),
    ...overrides.reviewedJsonReads.actionIds,
    ...overrides.reviewedJsonMutations.actionIds,
  ]);
}

function discoverFederationSourceInventory() {
  const surface = discoverCurrentSurface();
  return {
    actions: matrixEntriesFromSurface(surface),
    legacyUnsafeFindings: legacyFindingsFromSurface(surface),
  };
}

test('T-TRACE-001 every controller route and Socket.IO event has one fail-closed action', () => {
  const source = discoverFederationSourceInventory();
  const matrix = validateFederationActionMatrix(loadMatrix());
  const sourceKeys = source.actions.map((action) => action.sourceKey);
  const matrixKeys = matrix.actions.map((action) => action.sourceKey).sort();
  assert.deepEqual(matrixKeys, [...sourceKeys].sort());

  const bySourceKey = new Map(matrix.actions.map((action) => [action.sourceKey, action]));
  const active = activeActionIds();
  for (const discovered of source.actions) {
    const action = bySourceKey.get(discovered.sourceKey);
    assert.ok(action, discovered.sourceKey);
    assert.deepEqual(action.transport, discovered.transport, discovered.sourceKey);
    assert.deepEqual(action.codeOwner, discovered.codeOwner, discovered.sourceKey);
    assert.equal(
      action.legacy.remoteActivation,
      active.has(action.actionId) ? 'ALLOW' : 'DENY',
      discovered.sourceKey,
    );
    assert.equal(action.verification.test, 'T-TRACE-001', discovered.sourceKey);
  }

  assert.deepEqual(
    matrix.legacyUnsafeFindings.map((finding) => finding.sourceKey).sort(),
    source.legacyUnsafeFindings.map((finding) => finding.sourceKey).sort(),
  );
  for (const finding of matrix.legacyUnsafeFindings) {
    assert.equal(finding.remoteActivation, 'DENY');
    assert.equal(finding.transport.channel, 'proxy-relay');
    assert.equal(finding.transport.event, '*');
  }
});

test('unknown, stale, mismatched and wildcard actions never resolve', () => {
  const matrix = validateFederationActionMatrix(loadMatrix());
  const active = activeActionIds();
  assert.equal(resolveFederationAction(matrix, {
    kind: 'http',
    actionId: 'unknown.action',
    method: 'GET',
    routeTemplate: '/api/sites',
  }), undefined);

  for (const action of matrix.actions) {
    const lookup = action.transport.kind === 'http'
      ? {
          kind: 'http',
          actionId: action.actionId,
          method: action.transport.method,
          routeTemplate: action.transport.routeTemplate,
        }
      : {
          kind: 'socket.io',
          actionId: action.actionId,
          channel: action.transport.channel,
          event: action.transport.event,
          direction: action.transport.direction,
        };
    const resolved = resolveFederationAction(matrix, lookup);
    if (active.has(action.actionId)) assert.equal(resolved?.actionId, action.actionId, action.sourceKey);
    else assert.equal(resolved, undefined, action.sourceKey);
  }
});

test('T-CRUD-001 reviewed JSON mutations are bounded and use at-most-once admission', () => {
  const overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
  const matrix = validateFederationActionMatrix(loadMatrix());
  const byId = new Map(matrix.actions.map((action) => [action.actionId, action]));

  for (const actionId of overrides.reviewedJsonMutations.actionIds) {
    const action = byId.get(actionId);
    assert.ok(action, actionId);
    assert.equal(action.owner, 'target', actionId);
    assert.equal(action.transport.kind, 'http', actionId);
    assert.ok(['POST', 'PUT', 'PATCH', 'DELETE'].includes(action.transport.method), actionId);
    assert.equal(action.execution.mode, 'INTERACTIVE', actionId);
    assert.deepEqual(action.request.media, ['application/json'], actionId);
    assert.deepEqual(action.response.media, ['application/json'], actionId);
    assert.equal(action.idempotency.policy, 'DECLARED', actionId);
    assert.equal(
      action.idempotency.currentBehavior,
      'FEDERATION_TRANSPORT_AT_MOST_ONCE_ADMISSION',
      actionId,
    );
    assert.ok(action.authorization.roles.length > 0, actionId);
    assert.ok(
      action.authorization.roles.every((role) => role === 'ADMIN' || role === 'MANAGER'),
      actionId,
    );
    assert.equal(action.legacy.remoteActivation, 'ALLOW', actionId);
  }
});

test('matrix validator rejects duplicates, unknown fields and unsafe activation', () => {
  const raw = loadMatrix();
  assert.throws(() => validateFederationActionMatrix({
    ...raw,
    actions: [...raw.actions, raw.actions[0]],
  }));
  assert.throws(() => validateFederationActionMatrix({ ...raw, surprise: true }));
  assert.throws(() => validateFederationActionMatrix({
    ...raw,
    actions: raw.actions.map((action, index) => index === 0
      ? { ...action, owner: 'master', legacy: { behavior: 'unsafe', remoteActivation: 'ALLOW' } }
      : action),
  }));
});
