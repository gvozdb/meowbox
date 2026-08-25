'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PrismaClient } = require('@prisma/client');
const masterKey = require('../src/common/crypto/master-key');
const {
  FederationActionCatalogueService,
} = require('../src/federation/federation-action-catalogue.service');
const {
  FederationCompatibilityService,
} = require('../src/federation/federation-compatibility.service');
const {
  generateFederationManifestKey,
  generateFederationRelationshipKey,
  signFederationManifestPayload,
} = require('../src/federation/federation-key-material');
const {
  federationManifestRevision,
  FederationManifestVerifierService,
} = require('../src/federation/federation-manifest-verifier.service');
const {
  PanelIdentityService,
} = require('../src/federation/panel-identity.service');
const {
  RemoteContextService,
} = require('../src/federation/remote-context.service');
const { canonicalFederationJson } = require('@meowbox/shared');

const TARGET_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SERVER_ID = 'fixture-target';
const NOW = new Date('2026-08-24T16:00:00.000Z');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-compatibility-'));
  const databaseUrl = `file:${path.join(root, 'fixture.db')}`;
  execFileSync(path.resolve(__dirname, '../node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'ignore',
  });
  const previous = process.env.MEOWBOX_MASTER_KEY;
  process.env.MEOWBOX_MASTER_KEY = Buffer.alloc(32, 41).toString('base64');
  masterKey._resetMasterKeyCacheForTests();
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  t.after(async () => {
    await prisma.$disconnect();
    if (previous === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previous;
    masterKey._resetMasterKeyCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const panelIdentity = new PanelIdentityService(prisma, { get: () => 'MASTER' });
  const master = await panelIdentity.getLocalIdentity();
  const targetManifestKey = generateFederationManifestKey(TARGET_ID);
  const relationship = generateFederationRelationshipKey(master.installationId, TARGET_ID);
  const catalogue = new FederationActionCatalogueService();
  await prisma.remoteServer.create({
    data: {
      id: SERVER_ID,
      installationId: TARGET_ID,
      displayName: 'Fixture target',
      registryGeneration: 2,
      activationMode: 'V1_READ_ONLY',
      topologyMode: 'PUBLIC',
      activeEndpointGeneration: 1,
      targetManifestKid: targetManifestKey.kid,
      targetManifestPublicKeySpki: targetManifestKey.publicKeySpki,
      targetManifestPinnedAt: NOW,
      httpEnabled: true,
      endpoints: {
        create: {
          generation: 1,
          state: 'ACTIVE',
          apiOrigin: 'https://api.target.test',
          wsOrigin: 'https://ws.target.test',
          wsPath: '/socket.io',
          browserPublicOrigin: 'https://panel.target.test',
          directTransferOrigin: 'https://transfer.target.test',
          sshHost: 'target.test',
          sshPort: 2222,
          spkiSha256: `sha256/${Buffer.alloc(32, 7).toString('base64')}`,
          normalizedHash: 'a'.repeat(64),
          verifiedAt: NOW,
        },
      },
      issuers: {
        create: {
          issuerInstallationId: master.installationId,
          targetInstallationId: TARGET_ID,
          state: 'ACTIVE',
          maxRole: 'ADMIN',
          permissionPolicyJson: JSON.stringify(
            catalogue.activeActions().flatMap((action) => action.authorization.permissions),
          ),
          keys: {
            create: {
              kid: relationship.kid,
              publicKeySpki: relationship.publicKeySpki,
              encryptedPrivateKey: relationship.encryptedPrivateKey,
              state: 'ACTIVE',
              validFrom: new Date(NOW.getTime() - 60_000),
            },
          },
        },
      },
    },
  });
  const service = new FederationCompatibilityService(
    prisma,
    panelIdentity,
    new FederationManifestVerifierService(),
    catalogue,
  );
  return {
    prisma,
    catalogue,
    service,
    context: new RemoteContextService(prisma),
    targetManifestKey,
  };
}

function signedManifest(f, overrides = {}) {
  const basis = {
    schemaVersion: 1,
    catalogueSha256: f.catalogue.matrixSha256,
    installationId: TARGET_ID,
    installationRole: 'TARGET',
    protocolMode: 'v1-read-only',
    productVersion: 'v0.8.0',
    protocol: { min: 1, max: 1 },
    acceptedMasterProtocol: { min: 1, max: 1 },
    endpointState: 'READY',
    endpoints: {
      apiOrigin: 'https://api.target.test',
      apiPath: '/api',
      wsOrigin: 'https://ws.target.test',
      socketPath: '/socket.io',
      browserPublicOrigin: 'https://panel.target.test',
      directTransferOrigin: 'https://transfer.target.test',
    },
    actions: f.catalogue.capabilities(true),
    ...overrides,
  };
  const unsigned = {
    ...basis,
    revision: federationManifestRevision(basis),
    generatedAt: NOW.toISOString(),
    validUntil: new Date(NOW.getTime() + 60_000).toISOString(),
  };
  return {
    ...unsigned,
    signature: {
      algorithm: 'Ed25519',
      kid: f.targetManifestKey.kid,
      value: signFederationManifestPayload(
        Buffer.from(canonicalFederationJson(unsigned), 'utf8'),
        f.targetManifestKey,
      ),
    },
  };
}

test('RPP-130 valid signed manifest persists exact compatible context', async (t) => {
  const f = await fixture(t);
  const result = await f.service.ingestManifest(SERVER_ID, signedManifest(f), NOW);
  assert.deepEqual(result, {
    selectedProtocol: 1,
    validationState: 'VALID',
    capabilityState: 'FRESH',
  });
  const context = await f.context.getRemoteContext(SERVER_ID);
  assert.equal(context.status.transport.state, 'ONLINE');
  assert.equal(context.status.transport.reasonCode, 'READY');
  assert.equal(context.status.trust.state, 'ACTIVE');
  assert.equal(context.status.capability.state, 'FRESH');
  assert.equal(Object.keys(context.capabilities).length, f.catalogue.activeActions().length);
  const snapshot = await f.prisma.remoteManifestSnapshot.findFirstOrThrow();
  assert.equal(snapshot.validationState, 'VALID');
  assert.equal(snapshot.protocolMode, 'v1-read-only');
  assert.equal(snapshot.catalogueSha256, f.catalogue.matrixSha256);
});

test('RPP-130 invalid signature fails closed and marks trust without storing a snapshot', async (t) => {
  const f = await fixture(t);
  const manifest = signedManifest(f);
  manifest.signature.value = `${manifest.signature.value.slice(0, -1)}${
    manifest.signature.value.endsWith('A') ? 'B' : 'A'
  }`;
  await assert.rejects(
    () => f.service.ingestManifest(SERVER_ID, manifest, NOW),
    (error) => error?.status === 503,
  );
  assert.equal(await f.prisma.remoteManifestSnapshot.count(), 0);
  const server = await f.prisma.remoteServer.findUniqueOrThrow({ where: { id: SERVER_ID } });
  assert.equal(server.trustState, 'FAILED');
  assert.equal(server.trustReasonCode, 'MANIFEST_INVALID');
  assert.equal(server.capabilityState, 'UNKNOWN');
});

test('RPP-130 protocol and endpoint skew remain distinct non-ready states', async (t) => {
  const incompatible = await fixture(t);
  const protocol = { min: 2, max: 2 };
  const incompatibleResult = await incompatible.service.ingestManifest(
    SERVER_ID,
    signedManifest(incompatible, { protocol }),
    NOW,
  );
  assert.equal(incompatibleResult.validationState, 'INCOMPATIBLE');
  assert.equal(incompatibleResult.selectedProtocol, null);

  const mismatched = await fixture(t);
  const endpointResult = await mismatched.service.ingestManifest(
    SERVER_ID,
    signedManifest(mismatched, {
      endpoints: {
        ...signedManifest(mismatched).endpoints,
        browserPublicOrigin: 'https://new-panel.target.test',
      },
    }),
    NOW,
  );
  assert.equal(endpointResult.validationState, 'ENDPOINT_MISMATCH');
  const server = await mismatched.prisma.remoteServer.findUniqueOrThrow({ where: { id: SERVER_ID } });
  assert.equal(server.transportState, 'DEGRADED');
  assert.equal(server.transportReasonCode, 'ENDPOINT_CUTOVER');
});
