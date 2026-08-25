'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PrismaClient } = require('@prisma/client');
const shared = require('@meowbox/shared');
const masterKey = require('../src/common/crypto/master-key');
const {
  FederationActionCatalogueService,
} = require('../src/federation/federation-action-catalogue.service');
const {
  FederationManifestVerifierService,
  federationManifestRevision,
} = require('../src/federation/federation-manifest-verifier.service');
const {
  generateFederationManifestKey,
  signFederationManifestPayload,
} = require('../src/federation/federation-key-material');
const {
  FederationMasterEnrollmentService,
} = require('../src/federation/federation-master-enrollment.service');
const { FederationSshError } = require('../src/federation/federation-enrollment-ssh.service');
const { LegacyRegistryFileService } = require('../src/federation/legacy-registry-file.service');
const { PanelIdentityService } = require('../src/federation/panel-identity.service');
const { RegistryImportService } = require('../src/federation/registry-import.service');
const { RemoteRegistryService } = require('../src/federation/remote-registry.service');

const NOW = new Date('2026-08-24T18:00:00.000Z');
const TARGET_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ORIGIN = 'https://8.8.8.8';
const SSH_FINGERPRINT = `SHA256:${Buffer.alloc(32, 17).toString('base64').replace(/=+$/, '')}`;
const SPKI_PIN = `sha256/${Buffer.alloc(32, 18).toString('base64')}`;

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-master-enrollment-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(stateDir, 'data'), { recursive: true });
  const databaseUrl = `file:${path.join(root, 'fixture.db')}`;
  execFileSync(path.resolve(__dirname, '../node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'ignore',
  });
  const previousKey = process.env.MEOWBOX_MASTER_KEY;
  process.env.MEOWBOX_MASTER_KEY = Buffer.alloc(32, 71).toString('base64');
  masterKey._resetMasterKeyCacheForTests();
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const config = {
    get: (key, fallback) => {
      if (key === 'MEOWBOX_STATE_DIR') return stateDir;
      if (key === 'MEOWBOX_INSTALLATION_ROLE') return 'MASTER';
      return fallback;
    },
  };
  const file = new LegacyRegistryFileService(config);
  await file.writeMode600('[]\n');
  const identity = new PanelIdentityService(prisma, config);
  const registry = new RemoteRegistryService(prisma, identity, file);
  const importer = new RegistryImportService(prisma, file, registry);
  const imported = await importer.importAuthoritativeJson();
  await importer.cutoverToDb(imported.sourceDigest);
  const catalogue = new FederationActionCatalogueService();
  const targetManifestKey = generateFederationManifestKey(TARGET_ID);
  const calls = { runtime: [], ssh: [], exchange: [], complete: [] };
  const ssh = {
    ensureTargetRuntime: async (input) => {
      calls.runtime.push(input);
      if (options.sshFailure) throw new FederationSshError(options.sshFailure);
      return { installed: Boolean(options.runtimeInstalled) };
    },
    prepareTargetBootstrap: async (input) => {
      calls.ssh.push(input);
      if (options.bootstrapFailure) throw new FederationSshError(options.bootstrapFailure);
      return {
        enrollmentId: input.enrollmentId,
        targetInstallationId: TARGET_ID,
        manifestKid: targetManifestKey.kid,
        manifestPublicKeySpki: targetManifestKey.publicKeySpki,
      };
    },
  };
  const http = {
    exchangeTrust: async (input) => {
      calls.exchange.push(input);
      const endpoints = {
        apiOrigin: ORIGIN,
        apiPath: '/api',
        wsOrigin: ORIGIN,
        socketPath: '/socket.io',
        browserPublicOrigin: ORIGIN,
        directTransferOrigin: ORIGIN,
      };
      const basis = {
        schemaVersion: shared.FEDERATION_MANIFEST_SCHEMA_VERSION,
        catalogueSha256: catalogue.matrixSha256,
        installationId: TARGET_ID,
        installationRole: 'TARGET',
        protocolMode: 'disabled',
        productVersion: 'v0.7.36',
        protocol: { min: 1, max: 1 },
        acceptedMasterProtocol: { min: 1, max: 1 },
        endpointState: 'READY',
        endpoints,
        actions: catalogue.capabilities(false),
      };
      const unsigned = {
        ...basis,
        revision: federationManifestRevision(basis),
        generatedAt: NOW.toISOString(),
        validUntil: new Date(NOW.getTime() + 60_000).toISOString(),
      };
      return {
        trust: {
          enrollmentId: calls.ssh.at(-1).enrollmentId,
          state: 'MANIFEST_PENDING',
          target: {
            installationId: TARGET_ID,
            manifestKid: targetManifestKey.kid,
            manifestPublicKeySpki: targetManifestKey.publicKeySpki,
          },
          healthPath: '/api/federation/v1/health',
          manifestPath: '/api/federation/v1/manifest',
        },
        manifest: {
          ...unsigned,
          signature: {
            algorithm: 'Ed25519',
            kid: targetManifestKey.kid,
            value: signFederationManifestPayload(
              Buffer.from(shared.canonicalFederationJson(unsigned), 'utf8'),
              targetManifestKey,
            ),
          },
        },
      };
    },
    complete: async (input) => {
      calls.complete.push(input);
      return true;
    },
  };
  const service = new FederationMasterEnrollmentService(
    prisma,
    identity,
    catalogue,
    ssh,
    http,
    new FederationManifestVerifierService(),
    registry,
  );
  t.after(async () => {
    await prisma.$disconnect();
    if (previousKey === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previousKey;
    masterKey._resetMasterKeyCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { calls, file, prisma, service };
}

function createInput() {
  return {
    displayName: 'Federated fixture',
    sshHost: '8.8.4.4',
    sshPort: 2222,
    sshFingerprint: SSH_FINGERPRINT,
    apiOrigin: ORIGIN,
    wsOrigin: ORIGIN,
    wsPath: '/socket.io',
    browserPublicOrigin: ORIGIN,
    directTransferOrigin: ORIGIN,
    spkiSha256: SPKI_PIN,
    maxRole: 'ADMIN',
  };
}

test('T-PROV-001 master commits disabled server only after SSH trust and signed manifest', async (t) => {
  const f = await fixture(t);
  const created = await f.service.create(createInput(), 'operator-fixture', NOW);
  const before = await f.prisma.federationEnrollment.findUniqueOrThrow({ where: { id: created.id } });
  assert.equal(before.state, 'MASTER_PREPARED');
  assert.match(before.bootstrapHash, /^[0-9a-f]{64}$/);
  assert.ok(before.bootstrapSecretEnc);
  assert.equal(await f.prisma.remoteServer.count(), 0);

  const completed = await f.service.resume(created.id, 'ssh-password-fixture', NOW);
  assert.equal(completed.state, 'COMPLETED');
  assert.equal(completed.remoteServerId, created.id);
  assert.equal(f.calls.runtime.length, 1);
  assert.equal(f.calls.ssh.length, 1);
  assert.equal(f.calls.exchange.length, 1);
  assert.equal(f.calls.complete.length, 1);
  assert.deepEqual({
    apiOrigin: f.calls.ssh[0].apiOrigin,
    wsOrigin: f.calls.ssh[0].wsOrigin,
    wsPath: f.calls.ssh[0].wsPath,
    browserPublicOrigin: f.calls.ssh[0].browserPublicOrigin,
    directTransferOrigin: f.calls.ssh[0].directTransferOrigin,
  }, {
    apiOrigin: ORIGIN,
    wsOrigin: ORIGIN,
    wsPath: '/socket.io',
    browserPublicOrigin: ORIGIN,
    directTransferOrigin: ORIGIN,
  });
  assert.equal(Object.hasOwn(f.calls.exchange[0].establish, 'encryptedPrivateKey'), false);

  const enrollment = await f.prisma.federationEnrollment.findUniqueOrThrow({
    where: { id: created.id },
  });
  assert.equal(enrollment.bootstrapSecretEnc, null);
  assert.equal(enrollment.leaseUntil, null);
  assert.equal(JSON.stringify(enrollment).includes('ssh-password-fixture'), false);
  const server = await f.prisma.remoteServer.findUniqueOrThrow({
    where: { id: created.id },
    include: { endpoints: true, manifests: true, issuers: { include: { keys: true } } },
  });
  assert.equal(server.activationMode, 'DISABLED');
  assert.equal(server.httpEnabled, false);
  assert.equal(server.wsEnabled, false);
  assert.equal(server.publicEnabled, false);
  assert.equal(server.transportState, 'ONLINE');
  assert.equal(server.trustState, 'ACTIVE');
  assert.equal(server.endpoints[0].state, 'ACTIVE');
  assert.equal(server.manifests[0].validationState, 'VALID');
  assert.equal(server.issuers[0].keys[0].state, 'ACTIVE');
  assert.ok(server.issuers[0].keys[0].encryptedPrivateKey);
  assert.equal((await fsp.stat(f.file.path)).mode & 0o777, 0o600);
});

test('T-PROV-002 failed SSH leaves no server, releases lease, and exposes only reason code', async (t) => {
  const f = await fixture(t, { sshFailure: 'SSH_FINGERPRINT_MISMATCH' });
  const created = await f.service.create(createInput(), 'operator-fixture', NOW);
  await assert.rejects(
    () => f.service.resume(created.id, 'never-persist-this', NOW),
    (error) => error?.status === 503,
  );
  const failed = await f.prisma.federationEnrollment.findUniqueOrThrow({
    where: { id: created.id },
  });
  assert.equal(failed.state, 'MASTER_PREPARED');
  assert.equal(failed.sanitizedErrorCode, 'SSH_FINGERPRINT_MISMATCH');
  assert.equal(failed.leaseUntil, null);
  assert.ok(failed.bootstrapSecretEnc);
  assert.equal(JSON.stringify(failed).includes('never-persist-this'), false);
  assert.equal(await f.prisma.remoteServer.count(), 0);
  assert.equal(await f.prisma.federationIssuer.count(), 0);
});

test('T-PROV-003 active lease blocks duplicate resume and cancel clears encrypted bootstrap', async (t) => {
  const f = await fixture(t);
  const created = await f.service.create(createInput(), 'operator-fixture', NOW);
  await f.prisma.federationEnrollment.update({
    where: { id: created.id },
    data: { leaseUntil: new Date(NOW.getTime() + 60_000) },
  });
  await assert.rejects(
    () => f.service.resume(created.id, 'password', NOW),
    (error) => error?.status === 409,
  );
  await assert.rejects(
    () => f.service.cancel(created.id, NOW),
    (error) => error?.status === 409,
  );
  await f.prisma.federationEnrollment.update({
    where: { id: created.id },
    data: { leaseUntil: null },
  });
  const cancelled = await f.service.cancel(created.id, NOW);
  assert.equal(cancelled.state, 'CANCELLED');
  const row = await f.prisma.federationEnrollment.findUniqueOrThrow({ where: { id: created.id } });
  assert.equal(row.bootstrapSecretEnc, null);
  assert.equal(row.completedAt.toISOString(), NOW.toISOString());
});
