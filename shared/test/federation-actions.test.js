'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ACTION_MATRIX_SCHEMA_VERSION,
  FederationActionDescriptorError,
  UNKNOWN_REQUIRES_CHARACTERIZATION,
  matchesFederationRouteTemplate,
  resolveConcreteHttpFederationAction,
  resolveFederationAction,
  validateFederationActionMatrix,
} = require('../dist/federation-actions');

const verification = {
  test: 'T-ACT-001 remote-panel action inventory',
  metric: {
    name: 'unclassified-source-declarations',
    comparator: 'EQ',
    threshold: 0,
    unit: 'declarations',
  },
};

const safeFields = {
  request: { schema: 'KnownRequest', media: ['application/json'] },
  response: { schema: 'KnownResponse', media: ['application/json'] },
  execution: { mode: 'INTERACTIVE' },
  idempotency: { policy: 'DECLARED', currentBehavior: 'TEST_DECLARED' },
  cancellation: { policy: 'UNSUPPORTED', currentBehavior: 'TEST_UNSUPPORTED' },
  deadline: {
    connectMs: 100,
    headersMs: 200,
    idleMs: 300,
    operationMs: 400,
    currentTimeoutMs: 400,
    currentTimeoutSource: 'TEST',
  },
  capability: 'test-action-v1',
  legacy: { behavior: 'TEST_FULLY_CHARACTERIZED', remoteActivation: 'ALLOW' },
  verification,
};

const httpAction = () => ({
  ...safeFields,
  actionId: 'http.get.test-resource',
  transport: { kind: 'http', method: 'GET', routeTemplate: '/api/test-resource' },
  owner: 'target',
  authorization: { roles: ['ADMIN'], permissions: ['test.read'] },
  codeOwner: { file: 'api/src/test.controller.ts', symbol: 'TestController.getResource' },
  sourceKey: 'http|api/src/test.controller.ts|TestController|getResource|GET|/api/test-resource',
  sourceBindings: ['http|api/src/test.controller.ts|TestController|getResource|GET|/api/test-resource'],
  traceability: { cf: [], a: ['A19'], sp: [], im: [], bn: [] },
});

const socketAction = () => ({
  ...safeFields,
  actionId: 'ws.browser-command.test-start',
  transport: {
    kind: 'socket.io',
    channel: 'browser-command',
    event: 'test:start',
    direction: 'browser_to_api',
  },
  owner: 'target',
  authorization: { roles: ['ADMIN'], permissions: ['test.start'] },
  codeOwner: { file: 'api/src/gateway/test.gateway.ts', symbol: 'TestGateway.start' },
  sourceKey: 'socketio|browser-command|test:start',
  sourceBindings: ['socketio|browser-command|browser-handler|test:start'],
  traceability: { cf: ['CF15'], a: ['A19'], sp: [], im: [], bn: [] },
});

const matrix = (actions, legacyUnsafeFindings = []) => ({
  schemaVersion: ACTION_MATRIX_SCHEMA_VERSION,
  actions,
  legacyUnsafeFindings,
});

test('T-ACT-001 resolves only an exact, fully characterized active action', () => {
  const parsed = validateFederationActionMatrix(matrix([httpAction(), socketAction()]));

  assert.equal(resolveFederationAction(parsed, {
    kind: 'http',
    actionId: 'http.get.test-resource',
    method: 'GET',
    routeTemplate: '/api/test-resource',
  })?.actionId, 'http.get.test-resource');

  assert.equal(resolveFederationAction(parsed, {
    kind: 'socket.io',
    actionId: 'ws.browser-command.test-start',
    channel: 'browser-command',
    event: 'test:start',
    direction: 'browser_to_api',
  })?.actionId, 'ws.browser-command.test-start');

  assert.equal(resolveFederationAction(parsed, {
    kind: 'http',
    actionId: 'http.unknown.test-resource',
    method: 'GET',
    routeTemplate: '/api/test-resource',
  }), undefined, 'unknown action must deny');
  assert.equal(resolveFederationAction(parsed, {
    kind: 'http',
    actionId: 'http.get.test-resource',
    method: 'POST',
    routeTemplate: '/api/test-resource',
  }), undefined, 'unknown method must deny');
  assert.equal(resolveFederationAction(parsed, {
    kind: 'http',
    actionId: 'http.get.test-resource',
    method: 'GET',
    routeTemplate: '/api/other-resource',
  }), undefined, 'unknown template must deny');
  assert.equal(resolveFederationAction(parsed, {
    kind: 'socket.io',
    actionId: 'ws.browser-command.test-start',
    channel: 'browser-command',
    event: 'test:unknown',
    direction: 'browser_to_api',
  }), undefined, 'unknown event must deny');
});

test('T-SIG-002 concrete paths bind only to their exact controller template', () => {
  const parameterized = httpAction();
  parameterized.actionId = 'http.get.test-resource-id';
  parameterized.transport = {
    kind: 'http',
    method: 'GET',
    routeTemplate: '/api/test-resource/:id',
  };
  const parsed = validateFederationActionMatrix(matrix([parameterized]));
  assert.equal(resolveConcreteHttpFederationAction(parsed, {
    kind: 'http',
    actionId: parameterized.actionId,
    method: 'GET',
    concretePath: '/api/test-resource/a%20b',
  })?.actionId, parameterized.actionId);

  for (const path of [
    '/api/test-resource',
    '/api/test-resource/a/b',
    '/api/%74est-resource/a',
    '/api/test-resource/%2f',
    '/api/test-resource/%2e%2e',
    '/api/test-resource/a?x=1',
  ]) {
    assert.equal(matchesFederationRouteTemplate(parameterized.transport.routeTemplate, path), false, path);
  }
});

test('T-ACT-001 conservative markers and wildcard relay findings cannot activate remotely', () => {
  const conservative = httpAction();
  conservative.request = {
    schema: UNKNOWN_REQUIRES_CHARACTERIZATION,
    media: [UNKNOWN_REQUIRES_CHARACTERIZATION],
  };
  assert.throws(
    () => validateFederationActionMatrix(matrix([conservative])),
    FederationActionDescriptorError,
  );

  const wildcard = socketAction();
  wildcard.transport = {
    kind: 'socket.io',
    channel: 'proxy-relay',
    event: '*',
    direction: 'relay_bidirectional',
  };
  wildcard.legacy = { behavior: 'UNSAFE', remoteActivation: 'DENY' };
  assert.throws(
    () => validateFederationActionMatrix(matrix([wildcard])),
    FederationActionDescriptorError,
  );

  const parsed = validateFederationActionMatrix(matrix([httpAction()], [{
    findingId: 'ws.proxy.relay.browser-to-target-on-any',
    transport: {
      kind: 'socket.io',
      channel: 'proxy-relay',
      event: '*',
      direction: 'relay_bidirectional',
    },
    codeOwner: { file: 'api/src/gateway/agent.gateway.ts', symbol: 'AgentGateway.startProxyMode' },
    sourceKey: 'socketio|proxy-relay|browser-to-target-on-any',
    behavior: 'CURRENT_GENERIC_ON_ANY_PROXY_RELAY_UNCHARACTERIZED',
    remoteActivation: 'DENY',
    verification,
  }]));
  assert.equal(parsed.legacyUnsafeFindings.length, 1);
  assert.equal(resolveFederationAction(parsed, {
    kind: 'socket.io',
    actionId: 'ws.proxy.relay.browser-to-target-on-any',
    channel: 'proxy-relay',
    event: 'anything',
    direction: 'relay_bidirectional',
  }), undefined);
});

test('T-ACT-001 rejects malformed, duplicate, and stale-prone descriptor identities', () => {
  const first = httpAction();
  const duplicate = { ...httpAction(), sourceKey: 'http|other', sourceBindings: ['http|other'] };
  assert.throws(
    () => validateFederationActionMatrix(matrix([first, duplicate])),
    (error) => error instanceof FederationActionDescriptorError && error.issues.some((issue) => issue.includes('duplicate actionId')),
  );

  const bindingDuplicate = { ...socketAction(), sourceBindings: [...first.sourceBindings] };
  assert.throws(
    () => validateFederationActionMatrix(matrix([first, bindingDuplicate])),
    (error) => error instanceof FederationActionDescriptorError && error.issues.some((issue) => issue.includes('duplicate source binding')),
  );

  const malformed = httpAction();
  malformed.transport = { kind: 'http', method: 'TRACE', routeTemplate: '/api/test-resource' };
  assert.throws(
    () => validateFederationActionMatrix(matrix([malformed])),
    FederationActionDescriptorError,
  );

  assert.throws(
    () => validateFederationActionMatrix({
      schemaVersion: ACTION_MATRIX_SCHEMA_VERSION,
      profiles: {
        malformed: {
          ...safeFields,
          verification: { test: 'T-ACT-001', metric: {} },
        },
      },
      actions: [],
    }),
    FederationActionDescriptorError,
  );

  assert.throws(
    () => validateFederationActionMatrix({
      schemaVersion: ACTION_MATRIX_SCHEMA_VERSION,
      profiles: {
        unexpected: {
          ...safeFields,
          extraField: true,
        },
      },
      actions: [],
    }),
    (error) => error instanceof FederationActionDescriptorError &&
      error.issues.some((issue) => issue.includes('matrix.profiles.unexpected.extraField is not allowed')),
  );

  const mixedService = httpAction();
  mixedService.authorization = {
    roles: ['SERVICE', 'ADMIN'],
    permissions: ['test.read'],
  };
  assert.throws(
    () => validateFederationActionMatrix(matrix([mixedService])),
    FederationActionDescriptorError,
  );
});
