'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const masterKey = require('../src/common/crypto/master-key');
const { FederationActionCatalogueService } = require('../src/federation/federation-action-catalogue.service');
const { FederatedSocketPolicyService } = require('../src/federation/federated-socket-policy.ts');
const { FederationWsChannelIssuerService } = require('../src/federation/federation-ws-channel-issuer.service');
const { FederationWsChannelVerifierService } = require('../src/federation/federation-ws-channel-verifier.service');
const { generateFederationRelationshipKey } = require('../src/federation/federation-key-material');

const ISSUER_ID = '11111111-2222-4333-8444-555555555555';
const TARGET_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SERVER_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

function fixture(t) {
  const previous = process.env.MEOWBOX_MASTER_KEY;
  process.env.MEOWBOX_MASTER_KEY = Buffer.alloc(32, 37).toString('base64');
  masterKey._resetMasterKeyCacheForTests();
  t.after(() => {
    if (previous === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previous;
    masterKey._resetMasterKeyCacheForTests();
  });
  const now = new Date('2026-08-24T16:00:00.000Z');
  const catalogue = new FederationActionCatalogueService();
  const policy = new FederatedSocketPolicyService(catalogue);
  const relationship = generateFederationRelationshipKey(ISSUER_ID, TARGET_ID);
  const permissions = [...new Set(policy.actionsForRole('MANAGER').flatMap((action) =>
    action.descriptor.authorization.permissions))].sort();
  const capabilities = catalogue.capabilities(true);
  const issuer = {
    id: 'issuer-row',
    issuerInstallationId: ISSUER_ID,
    targetInstallationId: TARGET_ID,
    state: 'ACTIVE',
    revokedAt: null,
    maxRole: 'ADMIN',
    permissionPolicyJson: JSON.stringify(permissions),
    principalVersion: 4,
    keys: [{
      id: 'key-row',
      issuerId: 'issuer-row',
      ...relationship,
      state: 'ACTIVE',
      revokedAt: null,
      validFrom: new Date(now.getTime() - 1_000),
      expiresAt: null,
    }],
  };
  const endpoint = {
    generation: 2,
    state: 'ACTIVE',
    verifiedAt: new Date(now.getTime() - 1_000),
    wsOrigin: 'https://target.example',
    wsPath: '/socket.io',
    spkiSha256: `sha256/${Buffer.alloc(32, 1).toString('base64')}`,
    caCertificatePem: null,
  };
  const server = {
    id: SERVER_ID,
    installationId: TARGET_ID,
    activeEndpointGeneration: 2,
    endpoints: [endpoint],
    issuers: [issuer],
  };
  const context = {
    topologyMode: 'PUBLIC',
    killSwitches: { ws: false },
    protocol: { selected: 1, mode: 'v1-enabled' },
    status: {
      transport: { state: 'ONLINE' },
      trust: { state: 'ACTIVE' },
      capability: { state: 'FRESH' },
    },
    manifest: { validUntil: new Date(now.getTime() + 60_000).toISOString() },
    capabilities,
  };
  return { now, catalogue, policy, relationship, permissions, capabilities, issuer, server, context };
}

test('T-WS-002 issuer intersects role, manifest capabilities and relationship policy', async (t) => {
  const f = fixture(t);
  const service = new FederationWsChannelIssuerService(
    { remoteServer: { findUnique: async () => f.server } },
    { getLocalIdentity: async () => ({ installationId: ISSUER_ID, installationRole: 'MASTER' }) },
    { getRemoteContext: async () => f.context },
    f.policy,
  );
  const issued = await service.issue({
    targetInstallationId: TARGET_ID,
    actor: { id: 'operator-1', role: 'MANAGER' },
    browserIp: '203.0.113.7',
    epoch: 3,
    now: f.now,
  });
  assert.equal(issued.assertion.targetInstallationId, TARGET_ID);
  assert.equal(issued.assertion.epoch, 3);
  assert.ok(issued.assertion.actionIds.includes('ws.browser-command.ai-start'));
  assert.ok(!issued.assertion.actionIds.includes('ws.browser-command.terminal-open'));
});

test('T-WS-003 target verifies signature, replay, local capability and JIT owner', async (t) => {
  const f = fixture(t);
  const issuerService = new FederationWsChannelIssuerService(
    { remoteServer: { findUnique: async () => f.server } },
    { getLocalIdentity: async () => ({ installationId: ISSUER_ID, installationRole: 'MASTER' }) },
    { getRemoteContext: async () => f.context },
    f.policy,
  );
  const issued = await issuerService.issue({
    targetInstallationId: TARGET_ID,
    actor: { id: 'operator-1', role: 'MANAGER' },
    browserIp: '203.0.113.7',
    epoch: 3,
    now: f.now,
  });
  const targetKey = {
    ...f.issuer.keys[0],
    encryptedPrivateKey: null,
    issuer: { ...f.issuer, keys: undefined },
  };
  let replayCalls = 0;
  const verifier = new FederationWsChannelVerifierService(
    { federationKey: { findUnique: async () => targetKey } },
    { getLocalIdentity: async () => ({ installationId: TARGET_ID, installationRole: 'TARGET' }) },
    f.policy,
    { consume: async () => { replayCalls += 1; return 'a'.repeat(64); } },
    { resolveVerifiedOperator: async () => ({ userId: 'shadow-user', principalId: 'principal-1' }) },
    {
      manifest: async () => ({
        protocolMode: 'v1-enabled', endpointState: 'READY', actions: f.capabilities,
      }),
    },
  );
  const verified = await verifier.verify(issued.assertion, f.now);
  assert.equal(verified.userId, 'shadow-user');
  assert.equal(verified.claims.role, 'MANAGER');
  assert.equal(replayCalls, 1);

  const firstSignatureCharacter = issued.assertion.signature[0] === 'A' ? 'B' : 'A';
  await assert.rejects(() => verifier.verify({
    ...issued.assertion,
    signature: `${firstSignatureCharacter}${issued.assertion.signature.slice(1)}`,
  }, f.now), /signature/i);
});

test('T-WS-005 target denies channels when local WS capability is disabled', async (t) => {
  const f = fixture(t);
  const issuerService = new FederationWsChannelIssuerService(
    { remoteServer: { findUnique: async () => f.server } },
    { getLocalIdentity: async () => ({ installationId: ISSUER_ID, installationRole: 'MASTER' }) },
    { getRemoteContext: async () => f.context },
    f.policy,
  );
  const issued = await issuerService.issue({
    targetInstallationId: TARGET_ID,
    actor: { id: 'operator-1', role: 'MANAGER' },
    browserIp: '203.0.113.7', epoch: 1, now: f.now,
  });
  const targetKey = {
    ...f.issuer.keys[0], encryptedPrivateKey: null,
    issuer: { ...f.issuer, keys: undefined },
  };
  const verifier = new FederationWsChannelVerifierService(
    { federationKey: { findUnique: async () => targetKey } },
    { getLocalIdentity: async () => ({ installationId: TARGET_ID, installationRole: 'TARGET' }) },
    f.policy,
    { consume: async () => 'a'.repeat(64) },
    { resolveVerifiedOperator: async () => ({ userId: 'shadow-user', principalId: 'principal-1' }) },
    { manifest: async () => ({ protocolMode: 'disabled', endpointState: 'READY', actions: {} }) },
  );
  await assert.rejects(() => verifier.verify(issued.assertion, f.now), /disabled on target/);
});
