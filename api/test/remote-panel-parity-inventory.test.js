'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  FederationActionDescriptorError,
  validateFederationActionMatrix,
} = require('../../shared/src/federation-actions');
const {
  discoverCurrentSurface,
} = require('./remote-panel-parity-inventory');

const matrixPath = path.resolve(__dirname, '../../specs/remote-panel-parity/action-matrix.yaml');
const overridesPath = path.resolve(__dirname, '../../specs/remote-panel-parity/action-overrides.json');

const sorted = (values) => [...values].sort();

const loadMatrix = () => {
  // JSON is a YAML 1.2 subset. Keeping this document JSON-compatible avoids
  // coupling this safety check to an undeclared/transitive YAML parser.
  return JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
};

const assertSameSet = (actual, expected, label) => {
  assert.deepEqual(sorted(actual), sorted(expected), label);
};

const assertMatrixCoverage = (matrix, surface) => {
  const expectedActionKeys = [
    ...surface.http.map((route) => route.sourceKey),
    ...surface.socket.actions.map((entry) => entry.sourceKey),
  ];
  const actualActionKeys = matrix.actions.map((action) => action.sourceKey);
  assertSameSet(actualActionKeys, expectedActionKeys, 'matrix actions must exactly cover discovered HTTP and Socket.IO actions');

  const expectedBindings = [
    ...surface.http.flatMap((route) => [route.sourceKey]),
    ...surface.socket.actions.flatMap((entry) => entry.sourceBindings),
  ];
  const actualBindings = matrix.actions.flatMap((action) => action.sourceBindings);
  assertSameSet(actualBindings, expectedBindings, 'matrix source bindings must exactly cover relevant Socket.IO declarations');

  const expectedFindings = surface.socket.legacyUnsafeFindings.map((finding) => finding.sourceKey);
  const actualFindings = matrix.legacyUnsafeFindings.map((finding) => finding.sourceKey);
  assertSameSet(actualFindings, expectedFindings, 'matrix must classify every legacy Socket.IO wildcard relay finding');
};

test('T-ACT-001 source inventory is fully represented by the characterized fail-closed action matrix', () => {
  const rawMatrix = loadMatrix();
  const matrix = validateFederationActionMatrix(rawMatrix);
  const surface = discoverCurrentSurface();
  const overrideDocument = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
  const reviewedReadIds = new Set(overrideDocument.reviewedJsonReads.actionIds);
  const reviewedMutationIds = new Set(
    overrideDocument.reviewedJsonMutations.actionIds,
  );
  const activeActionIds = new Set([
    ...Object.keys(overrideDocument.actions),
    ...reviewedReadIds,
    ...reviewedMutationIds,
  ]);

  assertMatrixCoverage(matrix, surface);

  const actionsBySourceKey = new Map(matrix.actions.map((action) => [action.sourceKey, action]));
  for (const route of surface.http) {
    const action = actionsBySourceKey.get(route.sourceKey);
    assert.ok(action, `missing HTTP action ${route.sourceKey}`);
    assert.deepEqual(action.transport, {
      kind: 'http',
      method: route.method,
      routeTemplate: route.routeTemplate,
    }, route.sourceKey);
    assert.deepEqual(action.codeOwner, route.codeOwner, route.sourceKey);
    const expectedRoles = route.roles.includes('AUTHENTICATED_ANY')
      ? reviewedReadIds.has(action.actionId)
        ? ['ADMIN', 'MANAGER', 'VIEWER']
        : reviewedMutationIds.has(action.actionId)
          ? ['ADMIN', 'MANAGER']
          : route.roles
      : route.roles;
    assert.deepEqual(
      action.authorization.roles,
      expectedRoles,
      route.sourceKey,
    );
    assert.deepEqual(action.authorization.permissions, [action.actionId], route.sourceKey);
    assert.equal(
      action.idempotency.policy,
      route.idempotencyDeclared || reviewedMutationIds.has(action.actionId)
        ? 'DECLARED'
        : 'NOT_DECLARED',
      route.sourceKey,
    );
    if (route.multipart) {
      assert.deepEqual(action.request, {
        schema: `${route.codeOwner.symbol}.multipart-request`,
        media: ['multipart/form-data'],
      }, route.sourceKey);
    }
  }

  for (const entry of surface.socket.actions) {
    const action = actionsBySourceKey.get(entry.sourceKey);
    assert.ok(action, `missing Socket.IO action ${entry.sourceKey}`);
    assert.deepEqual(action.transport, {
      kind: 'socket.io',
      channel: entry.channel,
      event: entry.event,
      direction: entry.direction,
    }, entry.sourceKey);
    assert.ok(
      entry.codeOwners.some((owner) => owner.file === action.codeOwner.file && owner.symbol === action.codeOwner.symbol),
      `${entry.sourceKey} code owner is not a current declaration owner`,
    );
  }

  for (const actionId of reviewedReadIds) {
    const action = matrix.actions.find((candidate) => candidate.actionId === actionId);
    assert.ok(action, actionId);
    assert.equal(action.owner, 'target', actionId);
    assert.deepEqual(action.transport.kind === 'http'
      ? [action.transport.method, action.execution.mode]
      : [], ['GET', 'INTERACTIVE'], actionId);
    assert.deepEqual(action.request.media, ['application/json'], actionId);
    assert.deepEqual(action.response.media, ['application/json'], actionId);
    assert.ok(action.authorization.roles.every((role) =>
      ['ADMIN', 'MANAGER', 'VIEWER'].includes(role)), actionId);
  }

  // Ownership is a source classification rather than a route-prefix guess.
  // These representative declarations exercise the control-plane registry,
  // the documented main-server migration orchestrator, a direct
  // source-to-target migration endpoint, master registry/context/palette,
  // and a public delivery endpoint.
  const expectedOwners = new Map([
    ['http|api/src/proxy/proxy.controller.ts|ProxyController|listServers|GET|/api/servers', 'master'],
    ['http|api/src/federation/federation-master-enrollment.controller.ts|FederationMasterEnrollmentController|list|GET|/api/servers/enrollments', 'master'],
    ['http|api/src/federation/remote-context.controller.ts|RemoteContextController|getContext|GET|/api/servers/:id/context', 'master'],
    ['http|api/src/panel-settings/panel-settings.controller.ts|PanelSettingsController|getAppearance|GET|/api/panel-settings/appearance', 'master'],
    ['http|api/src/migration/migration.controller.ts|MigrationController|startMigration|POST|/api/migration/start', 'master'],
    ['http|api/src/migration/migration.controller.ts|MigrationController|importPull|POST|/api/migration/import-pull', 'direct'],
    ['http|api/src/deploy/deploy.controller.ts|DeployController|webhook|POST|/api/deploy/webhook/:domain', 'public'],
  ]);
  for (const [sourceKey, owner] of expectedOwners) {
    assert.equal(actionsBySourceKey.get(sourceKey)?.owner, owner, sourceKey);
  }

  assert.deepEqual(
    matrix.actions.filter((action) => action.legacy.remoteActivation === 'ALLOW').map((action) => action.actionId).sort(),
    [...activeActionIds].sort(),
    'only source-pinned reviewed overrides may activate',
  );
  assert.equal(
    JSON.stringify(matrix).includes('UNKNOWN_REQUIRES_CHARACTERIZATION'),
    false,
    'every discovered declaration must have concrete characterization metadata',
  );
  assert.ok(
    matrix.legacyUnsafeFindings.every((finding) => finding.remoteActivation === 'DENY'),
    'all generic legacy relays must remain explicitly denied',
  );
});

test('T-ACT-001 coverage comparison rejects missing and stale source records', () => {
  const matrix = validateFederationActionMatrix(loadMatrix());
  const surface = discoverCurrentSurface();

  const missing = {
    ...matrix,
    actions: matrix.actions.slice(1),
  };
  assert.throws(() => assertMatrixCoverage(missing, surface), assert.AssertionError);

  const stale = {
    ...matrix,
    actions: [
      ...matrix.actions,
      {
        ...matrix.actions[0],
        actionId: 'http.get.stale-action',
        sourceKey: 'http|stale|GET|/api/stale',
        sourceBindings: ['http|stale|GET|/api/stale'],
      },
    ],
  };
  assert.throws(() => assertMatrixCoverage(stale, surface), assert.AssertionError);
});

test('T-ACT-001 validator rejects duplicate and malformed matrix declarations before coverage', () => {
  const rawMatrix = loadMatrix();
  assert.throws(
    () => validateFederationActionMatrix({
      ...rawMatrix,
      actions: [...rawMatrix.actions, rawMatrix.actions[0]],
    }),
    FederationActionDescriptorError,
  );
  assert.throws(
    () => validateFederationActionMatrix({
      ...rawMatrix,
      actions: rawMatrix.actions.map((action, index) => index === 0
        ? { ...action, sourceBindings: [] }
        : action),
    }),
    FederationActionDescriptorError,
  );
});
