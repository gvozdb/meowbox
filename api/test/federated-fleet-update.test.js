'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const test = require('node:test');
const {
  FEDERATED_TARGET_UPDATE_ACTIONS,
} = require('../src/federation/federation-update-actions');
const {
  FederatedTargetUpdateController,
} = require('../src/panel-update/federated-target-update.controller');
const {
  FederatedFleetUpdateService,
} = require('../src/proxy/federated-fleet-update.service');

const SERVER_ID = 'target-1';
const INSTALLATION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ACTOR = {
  id: 'operator-1',
  role: 'ADMIN',
  browserIp: '198.51.100.20',
  peerIp: '203.0.113.10',
  userAgent: 'fixture',
};

function capability(actionId) {
  return {
    actionId,
    schemaVersion: 1,
    enabled: true,
    roles: ['ADMIN'],
    permissions: [actionId],
    requestMedia: ['application/json'],
    responseMedia: ['application/json'],
    executionMode: actionId.startsWith('http.post.') ? 'OPERATION' : 'INTERACTIVE',
    idempotency: actionId.startsWith('http.post.') ? 'DECLARED' : 'NOT_DECLARED',
    cancellation: 'UNSUPPORTED',
    connectMs: 5_000,
    headersMs: 15_000,
    idleMs: 30_000,
    operationMs: 30_000,
    legacySafe: false,
  };
}

function remoteContext(overrides = {}) {
  return {
    productVersion: 'v1.0.0-beta.2',
    protocol: { selected: 1, mode: 'v1-enabled' },
    status: {
      transport: { state: 'ONLINE' },
      trust: { state: 'ACTIVE' },
      capability: { state: 'PARTIAL' },
    },
    topologyMode: 'PUBLIC',
    killSwitches: { http: false },
    capabilities: Object.fromEntries(
      FEDERATED_TARGET_UPDATE_ACTIONS.map((actionId) => [actionId, capability(actionId)]),
    ),
    ...overrides,
  };
}

function dispatchResponse(data, requestId = 'request-1') {
  return {
    requestId,
    actionId: 'fixture-action',
    targetInstallationId: INSTALLATION_ID,
    issuerInstallationId: 'master-installation',
    keyId: 'kid-1',
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: Readable.from([Buffer.from(JSON.stringify({ success: true, data }))]),
  };
}

function fixture(options = {}) {
  const calls = [];
  const audits = [];
  const ingested = [];
  const proxyCalls = [];
  const context = options.context ?? remoteContext();
  const proxy = {
    getServer: (id) => {
      proxyCalls.push(['getServer', id]);
      return options.legacyServer;
    },
    pingServer: async (server) => {
      proxyCalls.push(['pingServer', server.id]);
      return { online: true, version: server.version };
    },
    proxyRequest: async (...args) => {
      proxyCalls.push(['proxyRequest', ...args]);
      return { status: 202 };
    },
  };
  const dispatcher = {
    resolveRouteTarget: async (id) => ({
      kind: 'V1',
      serverId: id,
      displayName: 'Federated target',
      targetInstallationId: INSTALLATION_ID,
    }),
    dispatch: async (input) => {
      calls.push(input);
      if (input.inboundTarget.endsWith('/status')) {
        return dispatchResponse({
          current: options.statusVersion ?? 'v1.0.0',
          state: { status: 'succeeded', errorMessage: null },
        }, 'status-request');
      }
      if (input.inboundTarget.endsWith('/manifest')) {
        return dispatchResponse(options.manifest ?? { productVersion: 'v1.0.0' }, 'manifest-request');
      }
      return dispatchResponse({ ok: true, pid: 42 }, 'trigger-request');
    },
  };
  const service = new FederatedFleetUpdateService(
    proxy,
    {
      listFederatedServerSummaries: async () => options.federated === false
        ? []
        : [{ id: SERVER_ID, name: 'Federated target' }],
    },
    { getRemoteContext: async () => context },
    dispatcher,
    { ingestManifest: async (...args) => { ingested.push(args); } },
    { logOut: async (entry) => { audits.push(entry); } },
  );
  return { service, calls, audits, ingested, proxyCalls };
}

test('T-LEG-002 fleet update uses signed v1 route and deterministic target idempotency', async () => {
  const f = fixture();
  const result = await f.service.triggerBulk(
    [SERVER_ID],
    'v1.0.0',
    ACTOR,
    'request-key-123',
  );

  assert.deepEqual(result, {
    version: 'v1.0.0',
    results: [{
      id: SERVER_ID,
      name: 'Federated target',
      success: true,
      federation: true,
      trackingPath: `/api/servers/${SERVER_ID}/update-status`,
    }],
  });
  assert.equal(f.calls.length, 1);
  assert.equal(
    f.calls[0].inboundTarget,
    `/api/proxy/${INSTALLATION_ID}/federation/v1/target-update`,
  );
  assert.equal(f.calls[0].method, 'POST');
  const headers = Object.fromEntries(
    Array.from({ length: f.calls[0].rawHeaders.length / 2 }, (_, index) => [
      f.calls[0].rawHeaders[index * 2],
      f.calls[0].rawHeaders[index * 2 + 1],
    ]),
  );
  assert.match(headers['idempotency-key'], /^fleet-update-[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(f.calls[0].body.toString('utf8')), { version: 'v1.0.0' });
  assert.equal(f.proxyCalls.length, 0, 'v1 must never fall back to static token relay');
  assert.equal(f.audits[0].requestId, 'trigger-request');
});

test('T-LEG-002 missing update capability fails that target without legacy fallback', async () => {
  const f = fixture({ context: remoteContext({ capabilities: {} }) });
  const result = await f.service.triggerBulk(
    [SERVER_ID],
    'v1.0.0',
    ACTOR,
    'request-key-123',
  );
  assert.equal(result.results[0].success, false);
  assert.equal(result.results[0].federation, true);
  assert.match(result.results[0].error, /lacks required update capabilities/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.proxyCalls.length, 0);
});

test('T-LEG-002 downgrade check follows SemVer prerelease ordering', async () => {
  const allowed = fixture();
  await allowed.service.triggerBulk(
    [SERVER_ID],
    'v1.0.0',
    ACTOR,
    'request-key-123',
  );
  const denied = fixture({ context: remoteContext({ productVersion: 'v1.0.0' }) });
  await assert.rejects(
    () => denied.service.triggerBulk(
      [SERVER_ID],
      'v1.0.0-rc.1',
      ACTOR,
      'request-key-456',
    ),
    /must be newer than v1\.0\.0/,
  );
  assert.equal(denied.calls.length, 0);
});

test('T-LEG-002 status is successful only after signed manifest ingestion', async () => {
  const manifest = { installationId: INSTALLATION_ID, productVersion: 'v1.0.0' };
  const f = fixture({ manifest });
  const result = await f.service.federatedStatus(SERVER_ID, ACTOR);
  assert.equal(result.manifestVerified, true);
  assert.equal(result.status.current, 'v1.0.0');
  assert.deepEqual(f.calls.map((call) => call.inboundTarget), [
    `/api/proxy/${INSTALLATION_ID}/federation/v1/target-update/status`,
    `/api/proxy/${INSTALLATION_ID}/federation/v1/target-update/manifest`,
  ]);
  assert.deepEqual(f.ingested, [[SERVER_ID, manifest]]);
  assert.equal(f.audits.length, 2);
});

test('T-LEG-002 target controller awaits manifest and rejects non-operator federation', async () => {
  const controller = new FederatedTargetUpdateController(
    { triggerUpdate: async () => ({ ok: true, pid: 7 }), getStatus: async () => ({ state: { status: 'running' } }) },
    { manifest: async () => ({ revision: 'signed-r1' }) },
  );
  const request = { federationContext: { verified: true, actorKind: 'OPERATOR', role: 'ADMIN' } };
  assert.deepEqual(await controller.manifest(request), {
    success: true,
    data: { revision: 'signed-r1' },
  });
  assert.deepEqual(
    await controller.trigger({ version: 'v1.0.0' }, { id: 'shadow-1', role: 'VIEWER' }, 'request-key-123', request),
    {
      success: true,
      data: {
        ok: true,
        pid: 7,
        targetVersion: 'v1.0.0',
        statusPath: '/api/federation/v1/target-update/status',
      },
    },
  );
  await assert.rejects(
    () => controller.status({ federationContext: { verified: true, actorKind: 'SERVICE', role: 'ADMIN' } }),
    /Verified federated ADMIN is required/,
  );
});
