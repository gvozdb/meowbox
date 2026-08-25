'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const { PrismaClient } = require('@prisma/client');
const { MockAgent } = require('undici');
const masterKey = require('../src/common/crypto/master-key');
const {
  canonicalizeFederationHeaders,
  sha256Body,
} = require('../src/federation/delegation-headers');
const {
  verifyDelegationAssertion,
} = require('../src/federation/delegation-envelope');
const {
  FederationDispatcherService,
} = require('../src/federation/federation-dispatcher.service');
const {
  FederationActionCatalogueService,
} = require('../src/federation/federation-action-catalogue.service');
const {
  generateFederationRelationshipKey,
} = require('../src/federation/federation-key-material');
const {
  PanelIdentityService,
} = require('../src/federation/panel-identity.service');
const {
  RemoteContextService,
} = require('../src/federation/remote-context.service');

const descriptor = {
  actionId: 'http.get.sites',
  transport: { kind: 'http', method: 'GET', routeTemplate: '/api/sites' },
  owner: 'target',
  authorization: { roles: ['ADMIN', 'MANAGER'], permissions: ['sites.read'] },
  request: { schema: 'Empty', media: ['application/json'] },
  response: { schema: 'SiteList', media: ['application/json'] },
  execution: { mode: 'INTERACTIVE' },
  idempotency: { policy: 'NOT_DECLARED', currentBehavior: 'READ_ONLY' },
  cancellation: { policy: 'UNSUPPORTED', currentBehavior: 'BOUNDED_READ' },
  deadline: {
    connectMs: 5000,
    headersMs: 15000,
    idleMs: 30000,
    operationMs: 30000,
    currentTimeoutMs: 30000,
    currentTimeoutSource: 'FEDERATION_V1',
  },
  capability: 'sites-read-v1',
  legacy: { behavior: 'FEDERATION_V1', remoteActivation: 'ALLOW' },
  codeOwner: { file: 'api/src/sites/sites.controller.ts', symbol: 'SitesController.findAll' },
  sourceKey: 'http|sites|get',
  sourceBindings: ['http|sites|get'],
  traceability: { cf: [], a: ['A3'], sp: ['SP2'], im: [], bn: [] },
  verification: {
    test: 'T-SIG-001',
    metric: { name: 'dispatch-errors', comparator: 'EQ', threshold: 0, unit: 'requests' },
  },
};

const capabilityFor = (selectedDescriptor) => ({
  actionId: selectedDescriptor.actionId,
  schemaVersion: 1,
  enabled: true,
  roles: selectedDescriptor.authorization.roles,
  permissions: selectedDescriptor.authorization.permissions,
  requestMedia: selectedDescriptor.request.media,
  responseMedia: selectedDescriptor.response.media,
  executionMode: selectedDescriptor.execution.mode,
  idempotency: selectedDescriptor.idempotency.policy,
  cancellation: selectedDescriptor.cancellation.policy,
  connectMs: 5000,
  headersMs: 15000,
  idleMs: 30000,
  operationMs: 30000,
  legacySafe: false,
});

async function fixture(t, selectedDescriptor = descriptor) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-dispatcher-'));
  const databaseUrl = `file:${path.join(root, 'fixture.db')}`;
  execFileSync(path.resolve(__dirname, '../node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'ignore',
  });
  const previous = process.env.MEOWBOX_MASTER_KEY;
  process.env.MEOWBOX_MASTER_KEY = Buffer.alloc(32, 23).toString('base64');
  masterKey._resetMasterKeyCacheForTests();
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  t.after(async () => {
    await mockAgent.close();
    await prisma.$disconnect();
    if (previous === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previous;
    masterKey._resetMasterKeyCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const identityService = new PanelIdentityService(prisma, {
    get: (key, fallback) => key === 'MEOWBOX_INSTALLATION_ROLE' ? 'MASTER' : fallback,
  });
  const master = await identityService.getLocalIdentity();
  const targetInstallationId = randomUUID();
  const relationship = generateFederationRelationshipKey(
    master.installationId,
    targetInstallationId,
  );
  const validUntil = new Date(Date.now() + 60_000);
  const server = await prisma.remoteServer.create({
    data: {
      id: 'legacy-id-1',
      installationId: targetInstallationId,
      displayName: 'Fixture target',
      activationMode: 'V1_ENABLED',
      topologyMode: 'PUBLIC',
      protocolVersion: 1,
      transportState: 'ONLINE',
      trustState: 'ACTIVE',
      capabilityState: 'FRESH',
      browserState: 'REACHABLE',
      reasonCode: 'READY',
      statusCheckedAt: new Date(),
      manifestFetchedAt: new Date(),
      activeEndpointGeneration: 1,
      httpEnabled: true,
      publicEnabled: true,
      endpoints: {
        create: {
          generation: 1,
          state: 'ACTIVE',
          apiOrigin: 'https://target.example',
          wsOrigin: 'https://target.example',
          wsPath: '/socket.io',
          browserPublicOrigin: 'https://target.example',
          directTransferOrigin: 'https://target.example',
          sshHost: 'target.example',
          sshPort: 22,
          spkiSha256: `sha256/${Buffer.alloc(32, 7).toString('base64')}`,
          normalizedHash: 'a'.repeat(64),
          verifiedAt: new Date(),
        },
      },
      manifests: {
        create: {
          schemaVersion: 1,
          revision: 'fixture-revision',
          protocolMin: 1,
          protocolMax: 1,
          acceptedMasterRange: JSON.stringify({ min: 1, max: 1 }),
          capabilitiesJson: JSON.stringify({
            [selectedDescriptor.actionId]: capabilityFor(selectedDescriptor),
          }),
          endpointsJson: '{}',
          signingKid: relationship.kid,
          signature: 'fixture-signature',
          validationState: 'VALID',
          validUntil,
        },
      },
      issuers: {
        create: {
          issuerInstallationId: master.installationId,
          targetInstallationId,
          state: 'ACTIVE',
          maxRole: 'ADMIN',
          permissionPolicyJson: JSON.stringify(selectedDescriptor.authorization.permissions),
          principalVersion: 1,
          keys: {
            create: {
              kid: relationship.kid,
              publicKeySpki: relationship.publicKeySpki,
              encryptedPrivateKey: relationship.encryptedPrivateKey,
              state: 'ACTIVE',
            },
          },
        },
      },
    },
  });
  const catalogue = {
    resolveHttpByConcretePath: (method, concretePath) =>
      method === selectedDescriptor.transport.method &&
      (concretePath === selectedDescriptor.transport.routeTemplate ||
        (selectedDescriptor.transport.routeTemplate.endsWith('/:vpnUserId') &&
          concretePath.startsWith(selectedDescriptor.transport.routeTemplate.slice(0, -':vpnUserId'.length))))
        ? selectedDescriptor
        : undefined,
  };
  const service = new FederationDispatcherService(
    prisma,
    identityService,
    new RemoteContextService(prisma),
    catalogue,
    { get: () => mockAgent },
  );
  return { mockAgent, relationship, server, service, targetInstallationId };
}

function normalizeHeaders(headers) {
  if (headers && typeof headers.entries === 'function') return Object.fromEntries(headers.entries());
  return Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
}

test('T-SIG-001 dispatcher strips browser authority and signs exact target bytes', async (t) => {
  const state = await fixture(t);
  let outbound;
  state.mockAgent.get('https://target.example')
    .intercept({ path: '/api/sites?tag=a&tag=&literal=one+two', method: 'GET' })
    .reply((options) => {
      outbound = normalizeHeaders(options.headers);
      return {
        statusCode: 200,
        data: JSON.stringify({ success: true, data: [] }),
        responseOptions: { headers: { 'content-type': 'application/json; charset=utf-8' } },
      };
    });

  const actorId = randomUUID();
  const inboundTarget = `/api/proxy/${state.targetInstallationId}/sites?tag=a&tag=&literal=one+two`;
  const response = await state.service.dispatch({
    targetInstallationId: state.targetInstallationId,
    inboundTarget,
    method: 'GET',
    rawHeaders: [
      'Host', 'master.example',
      'Authorization', 'Bearer browser-token-must-not-leave',
      'Cookie', 'browser-cookie-must-not-leave=1',
      'Accept', 'application/json',
    ],
    body: Buffer.alloc(0),
    actor: { id: actorId, role: 'MANAGER' },
    browserIp: '198.51.100.26',
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(await response.body.text()), { success: true, data: [] });
  assert.equal(outbound.authorization, undefined);
  assert.equal(outbound.cookie, undefined);
  assert.equal(outbound['x-proxy-token'], undefined);
  assert.equal(typeof outbound['x-meowbox-assertion'], 'string');
  assert.equal(typeof outbound['x-meowbox-signature'], 'string');

  const claims = verifyDelegationAssertion({
    assertion: outbound['x-meowbox-assertion'],
    signature: outbound['x-meowbox-signature'],
  }, {
    method: 'GET',
    targetPathAndQuery: '/api/sites?tag=a&tag=&literal=one+two',
    headers: canonicalizeFederationHeaders([['Accept', 'application/json']]),
    bodySha256: sha256Body(Buffer.alloc(0)),
  }, {
    expectedIssuerInstallationId: state.relationship.issuerInstallationId,
    expectedTargetInstallationId: state.targetInstallationId,
    expectedKeyId: state.relationship.kid,
    publicKeySpki: state.relationship.publicKeySpki,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  assert.equal(claims.requestId, response.requestId);
  assert.equal(claims.subject, actorId);
  assert.equal(claims.browserIp, '198.51.100.26');
  assert.equal(claims.role, 'MANAGER');
  assert.deepEqual(claims.permissions, ['sites.read']);
});

test('T-AUTH-003 reviewed reads enforce the generated ADMIN/MANAGER/VIEWER policy', async (t) => {
  const catalogue = new FederationActionCatalogueService();
  const reviewedRead = catalogue.findAction('http.get.sites');
  assert.ok(reviewedRead);
  assert.deepEqual(reviewedRead.authorization.roles, ['ADMIN', 'MANAGER', 'VIEWER']);

  const state = await fixture(t, reviewedRead);
  const assertions = [];
  for (const role of ['ADMIN', 'MANAGER', 'VIEWER']) {
    state.mockAgent.get('https://target.example')
      .intercept({ path: '/api/sites', method: 'GET' })
      .reply((options) => {
        assertions.push(normalizeHeaders(options.headers)['x-meowbox-assertion']);
        return {
          statusCode: 200,
          data: JSON.stringify({ success: true, data: [] }),
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      });
    const response = await state.service.dispatch({
      targetInstallationId: state.targetInstallationId,
      inboundTarget: `/api/proxy/${state.targetInstallationId}/sites`,
      method: 'GET',
      rawHeaders: ['Accept', 'application/json'],
      body: Buffer.alloc(0),
      actor: { id: randomUUID(), role },
      browserIp: '198.51.100.26',
    });
    assert.equal(response.statusCode, 200);
    await response.body.text();
  }

  assert.deepEqual(assertions.map((assertion) => JSON.parse(
    Buffer.from(assertion, 'base64url').toString('utf8'),
  ).role), ['ADMIN', 'MANAGER', 'VIEWER']);

  const adminOnly = catalogue.findAction('http.get.audit-logs');
  assert.ok(adminOnly);
  assert.deepEqual(adminOnly.authorization.roles, ['ADMIN']);
  const denied = await fixture(t, adminOnly);
  await assert.rejects(
    () => denied.service.dispatch({
      targetInstallationId: denied.targetInstallationId,
      inboundTarget: `/api/proxy/${denied.targetInstallationId}/audit-logs`,
      method: 'GET',
      rawHeaders: ['Accept', 'application/json'],
      body: Buffer.alloc(0),
      actor: { id: randomUUID(), role: 'VIEWER' },
      browserIp: '198.51.100.26',
    }),
    (error) => error?.contract?.code === 'REMOTE_PERMISSION_DENIED' && error.httpStatus === 403,
  );
  denied.mockAgent.assertNoPendingInterceptors();
});

test('unknown concrete routes fail before any target dispatch', async (t) => {
  const state = await fixture(t);
  await assert.rejects(
    () => state.service.dispatch({
      targetInstallationId: state.targetInstallationId,
      inboundTarget: `/api/proxy/${state.targetInstallationId}/users`,
      method: 'GET',
      rawHeaders: ['Accept', 'application/json'],
      body: Buffer.alloc(0),
      actor: { id: randomUUID(), role: 'ADMIN' },
      browserIp: '198.51.100.26',
    }),
    (error) => error?.contract?.code === 'REMOTE_ACTION_UNKNOWN' && error.httpStatus === 404,
  );
  state.mockAgent.assertNoPendingInterceptors();
});

test('T-MODX-001 dispatcher permits target APP_HANDOFF issuance but never public-route proxying', async (t) => {
  const handoffDescriptor = {
    ...descriptor,
    actionId: 'http.post.test-handoff',
    transport: { kind: 'http', method: 'POST', routeTemplate: '/api/test-handoff' },
    authorization: { roles: ['ADMIN'], permissions: ['http.post.test-handoff'] },
    execution: { mode: 'APP_HANDOFF' },
    idempotency: { policy: 'DECLARED', currentBehavior: 'HEADER' },
  };
  const state = await fixture(t, handoffDescriptor);
  state.mockAgent.get('https://target.example')
    .intercept({ path: '/api/test-handoff', method: 'POST' })
    .reply(200, JSON.stringify({ success: true, data: { kind: 'AppHandoff' } }), {
      headers: { 'content-type': 'application/json' },
    });
  const response = await state.service.dispatch({
    targetInstallationId: state.targetInstallationId,
    inboundTarget: `/api/proxy/${state.targetInstallationId}/test-handoff`,
    method: 'POST',
    rawHeaders: [
      'Content-Type', 'application/json',
      'Idempotency-Key', 'modx-handoff-fixture-1',
    ],
    body: Buffer.from('{}'),
    actor: { id: randomUUID(), role: 'ADMIN' },
    browserIp: '198.51.100.26',
  });
  assert.equal(response.statusCode, 200);
  await response.body.text();

  handoffDescriptor.owner = 'public';
  await assert.rejects(
    () => state.service.dispatch({
      targetInstallationId: state.targetInstallationId,
      inboundTarget: `/api/proxy/${state.targetInstallationId}/test-handoff`,
      method: 'POST',
      rawHeaders: [
        'Content-Type', 'application/json',
        'Idempotency-Key', 'modx-handoff-fixture-2',
      ],
      body: Buffer.from('{}'),
      actor: { id: randomUUID(), role: 'ADMIN' },
      browserIp: '198.51.100.26',
    }),
    (error) => error?.contract?.code === 'REMOTE_ACTION_UNKNOWN',
  );
});

test('T-XFER-001 dispatcher permits authenticated staged-artifact control actions', async (t) => {
  const stagedDescriptor = {
    ...descriptor,
    actionId: 'http.post.test-staged-artifact',
    transport: {
      kind: 'http',
      method: 'POST',
      routeTemplate: '/api/test-staged-artifact',
    },
    authorization: {
      roles: ['ADMIN'],
      permissions: ['http.post.test-staged-artifact'],
    },
    execution: { mode: 'STAGED_ARTIFACT' },
    idempotency: { policy: 'DECLARED', currentBehavior: 'HEADER' },
  };
  const state = await fixture(t, stagedDescriptor);
  state.mockAgent.get('https://target.example')
    .intercept({ path: '/api/test-staged-artifact', method: 'POST' })
    .reply(200, JSON.stringify({ success: true, data: { kind: 'TransferSession' } }), {
      headers: { 'content-type': 'application/json' },
    });
  const response = await state.service.dispatch({
    targetInstallationId: state.targetInstallationId,
    inboundTarget: `/api/proxy/${state.targetInstallationId}/test-staged-artifact`,
    method: 'POST',
    rawHeaders: [
      'Content-Type', 'application/json',
      'Idempotency-Key', 'staged-artifact-fixture-1',
    ],
    body: Buffer.from('{}'),
    actor: { id: randomUUID(), role: 'ADMIN' },
    browserIp: '198.51.100.26',
  });
  assert.equal(response.statusCode, 200);
  await response.body.text();
});

test('T-VPN-001 SERVICE dispatch cannot impersonate an operator', async (t) => {
  const serviceDescriptor = {
    ...descriptor,
    actionId: 'http.get.federation-v1-vpn-fragments-vpn-user-id',
    transport: {
      kind: 'http',
      method: 'GET',
      routeTemplate: '/api/federation/v1/vpn/fragments/:vpnUserId',
    },
    authorization: {
      roles: ['SERVICE'],
      permissions: ['http.get.federation-v1-vpn-fragments-vpn-user-id'],
    },
  };
  const state = await fixture(t, serviceDescriptor);
  const vpnUserId = randomUUID();
  let outbound;
  state.mockAgent.get('https://target.example')
    .intercept({ path: `/api/federation/v1/vpn/fragments/${vpnUserId}`, method: 'GET' })
    .reply((options) => {
      outbound = normalizeHeaders(options.headers);
      return {
        statusCode: 200,
        data: JSON.stringify({ success: true, data: {} }),
        responseOptions: { headers: { 'content-type': 'application/json' } },
      };
    });
  const response = await state.service.dispatchService({
    targetInstallationId: state.targetInstallationId,
    inboundTarget: `/api/proxy/${state.targetInstallationId}/federation/v1/vpn/fragments/${vpnUserId}`,
    method: 'GET',
    rawHeaders: ['Accept', 'application/json'],
    body: Buffer.alloc(0),
    serviceSubject: 'vpn-subscription-gateway',
    browserIp: '203.0.113.12',
  });
  await response.body.text();
  const claims = verifyDelegationAssertion({
    assertion: outbound['x-meowbox-assertion'],
    signature: outbound['x-meowbox-signature'],
  }, {
    method: 'GET',
    targetPathAndQuery: `/api/federation/v1/vpn/fragments/${vpnUserId}`,
    headers: canonicalizeFederationHeaders([['Accept', 'application/json']]),
    bodySha256: sha256Body(Buffer.alloc(0)),
  }, {
    expectedIssuerInstallationId: state.relationship.issuerInstallationId,
    expectedTargetInstallationId: state.targetInstallationId,
    expectedKeyId: state.relationship.kid,
    publicKeySpki: state.relationship.publicKeySpki,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  assert.equal(claims.actorKind, 'SERVICE');
  assert.equal(claims.role, 'SERVICE');
  assert.equal(claims.subject, 'vpn-subscription-gateway');
});
