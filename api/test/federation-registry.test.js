'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PrismaClient } = require('@prisma/client');
const masterKey = require('../src/common/crypto/master-key');
const { LegacyRegistryFileService } = require('../src/federation/legacy-registry-file.service');
const { parseLegacyRegistry } = require('../src/federation/legacy-registry');
const { PanelIdentityService } = require('../src/federation/panel-identity.service');
const { RegistryImportService } = require('../src/federation/registry-import.service');
const { RemoteRegistryService } = require('../src/federation/remote-registry.service');
const { healthyFederationRolloutEvidence: healthyEvidence } = require('./helpers/federation-rollout-evidence');

const ORIGINAL = [
  {
    id: 'legacy-b',
    name: 'Legacy B',
    url: 'https://b.fixture.test:8443',
    token: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  },
  {
    id: 'legacy-a',
    name: 'Legacy A',
    url: 'http://a.fixture.test:11860',
    token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
];

async function fixture(t, role = 'MASTER') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-registry-'));
  const stateDir = path.join(root, 'state');
  const dataDir = path.join(stateDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const databaseUrl = `file:${path.join(root, 'fixture.db')}`;
  execFileSync(path.resolve(__dirname, '../node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'ignore',
  });
  const previous = process.env.MEOWBOX_MASTER_KEY;
  process.env.MEOWBOX_MASTER_KEY = Buffer.alloc(32, 19).toString('base64');
  masterKey._resetMasterKeyCacheForTests();
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const config = {
    get: (key, fallback) => {
      if (key === 'MEOWBOX_STATE_DIR') return stateDir;
      if (key === 'MEOWBOX_INSTALLATION_ROLE') return role;
      return fallback;
    },
  };
  const actualFile = new LegacyRegistryFileService(config);
  let failWrites = false;
  const file = {
    read: () => actualFile.read(),
    writeMode600: (content) => {
      if (failWrites) throw new Error('fixture projection failure');
      return actualFile.writeMode600(content);
    },
  };
  await actualFile.writeMode600(`${JSON.stringify(ORIGINAL, null, 2)}\n`);
  const identity = new PanelIdentityService(prisma, config);
  const registry = new RemoteRegistryService(prisma, identity, file);
  const importer = new RegistryImportService(prisma, file, registry);
  t.after(async () => {
    await prisma.$disconnect();
    if (previous === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previous;
    masterKey._resetMasterKeyCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    actualFile,
    importer,
    prisma,
    registry,
    setFailWrites: (value) => { failWrites = value; },
  };
}

test('T-REG-001 import preserves IDs, encrypts tokens, and remains JSON-authoritative', async (t) => {
  const { importer, prisma, registry } = await fixture(t);
  const imported = await importer.importAuthoritativeJson();
  assert.equal(imported.imported, 2);
  assert.equal(await registry.authority(), 'JSON');
  const rows = await prisma.remoteServer.findMany({ orderBy: { id: 'asc' } });
  assert.deepEqual(rows.map(({ id }) => id), ['legacy-a', 'legacy-b']);
  assert.equal(rows.every(({ activationMode }) => activationMode === 'LEGACY_UPGRADE_ONLY'), true);
  assert.equal(rows.every(({ legacyTokenEnc }) => !legacyTokenEnc.includes('aaaaaaaa')), true);

  const repeated = await importer.importAuthoritativeJson();
  assert.equal(repeated.generation, imported.generation);
  assert.equal(await prisma.registryProjectionJournal.count(), 1);
});

test('T-REG-002 cutover commits mode-0600 projection and DB mutations project atomically', async (t) => {
  const { actualFile, importer, prisma, registry } = await fixture(t);
  const imported = await importer.importAuthoritativeJson();
  await importer.cutoverToDb(imported.sourceDigest);
  assert.equal(await registry.authority(), 'DB');
  assert.equal((await fsp.stat(actualFile.path)).mode & 0o777, 0o600);
  assert.deepEqual(
    parseLegacyRegistry(await actualFile.read()).map(({ id }) => id),
    ['legacy-a', 'legacy-b'],
  );

  const updated = await registry.updateLegacyServer('legacy-a', { name: 'Legacy A renamed' });
  assert.equal(updated.name, 'Legacy A renamed');
  const projected = parseLegacyRegistry(await actualFile.read());
  assert.equal(projected.find(({ id }) => id === 'legacy-a').name, 'Legacy A renamed');
  assert.equal((await prisma.registryProjectionJournal.findFirst({ orderBy: { registryGeneration: 'desc' } })).state, 'COMMITTED');
});

test('T-REG-003 projection failure freezes mutation until explicit repair', async (t) => {
  const { actualFile, importer, prisma, registry, setFailWrites } = await fixture(t);
  const imported = await importer.importAuthoritativeJson();
  await importer.cutoverToDb(imported.sourceDigest);

  setFailWrites(true);
  await assert.rejects(
    () => registry.updateLegacyServer('legacy-a', { name: 'Committed but unprojected' }),
    /projection failed/i,
  );
  assert.equal(await registry.authority(), 'FROZEN');
  assert.equal(await prisma.remoteServer.count({ where: { mutationFrozenAt: { not: null } } }), 2);

  setFailWrites(false);
  await registry.repairProjection();
  assert.equal(await registry.authority(), 'DB');
  assert.equal(parseLegacyRegistry(await actualFile.read()).find(({ id }) => id === 'legacy-a').name, 'Committed but unprojected');
  assert.equal(await prisma.remoteServer.count({ where: { mutationFrozenAt: { not: null } } }), 0);
});

test('rollback to JSON is blocked after federated new-only identity state', async (t) => {
  const { importer, prisma, registry } = await fixture(t);
  const imported = await importer.importAuthoritativeJson();
  await importer.cutoverToDb(imported.sourceDigest);
  const issuer = await prisma.federationIssuer.create({
    data: {
      issuerInstallationId: '11111111-2222-4333-8444-555555555555',
      targetInstallationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      state: 'ACTIVE',
    },
  });
  const user = await prisma.user.create({
    data: {
      username: '__meowbox_federated_fixture',
      email: 'federated+fixture@federation.invalid',
      passwordHash: 'fixture',
      identityKind: 'FEDERATED',
      role: 'MANAGER',
    },
  });
  await prisma.federatedPrincipal.create({
    data: { userId: user.id, issuerId: issuer.id, subject: 'fixture' },
  });
  await assert.rejects(() => registry.rollbackAuthorityToJson(), /rollback floor/);
  assert.equal(await registry.authority(), 'DB');
});

test('target installation cannot import a recursive child registry', async (t) => {
  const { importer, prisma } = await fixture(t, 'TARGET');
  await assert.rejects(() => importer.importAuthoritativeJson(), /control-plane/);
  assert.equal(await prisma.remoteServer.count(), 0);
});

async function rolloutFixture(t) {
  const state = await fixture(t);
  const imported = await state.importer.importAuthoritativeJson();
  await state.importer.cutoverToDb(imported.sourceDigest);
  const remoteServerId = '55555555-6666-4777-8888-999999999999';
  const now = new Date('2026-08-25T10:00:00.000Z');
  const validUntil = new Date(now.getTime() + 60 * 60_000);
  await state.prisma.remoteServer.create({
    data: {
      id: remoteServerId,
      installationId: 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff',
      displayName: 'Rollout target',
      registryGeneration: 1,
      topologyMode: 'PUBLIC',
      protocolVersion: 1,
      targetManifestKid: 'target-manifest-fixture',
      targetManifestPublicKeySpki: 'fixture-public-key',
      targetManifestPinnedAt: now,
      transportState: 'ONLINE',
      transportFreshUntil: validUntil,
      trustState: 'ACTIVE',
      trustFreshUntil: validUntil,
      capabilityState: 'FRESH',
      activeEndpointGeneration: 1,
      endpoints: {
        create: {
          generation: 1,
          state: 'ACTIVE',
          apiOrigin: 'https://rollout.target.test',
          wsOrigin: 'https://rollout.target.test',
          wsPath: '/socket.io',
          browserPublicOrigin: 'https://rollout.target.test',
          directTransferOrigin: 'https://rollout.target.test',
          sshHost: 'rollout.target.test',
          sshPort: 22,
          spkiSha256: `sha256/${Buffer.alloc(32, 3).toString('base64')}`,
          normalizedHash: 'b'.repeat(64),
          verifiedAt: now,
        },
      },
      manifests: {
        create: {
          schemaVersion: 1,
          revision: 'rollout-fixture-v1',
          protocolMode: 'v1-enabled',
          protocolMin: 1,
          protocolMax: 1,
          acceptedMasterRange: '{"min":1,"max":1}',
          capabilitiesJson: '{}',
          endpointState: 'READY',
          endpointsJson: '{}',
          signingKid: 'target-manifest-fixture',
          signature: 'fixture-signature',
          validationState: 'VALID',
          generatedAt: now,
          validUntil,
          fetchedAt: now,
        },
      },
    },
  });
  return { ...state, remoteServerId, now };
}

test('T-CAN-001 rollout is CAS-protected, one-step, and idempotent', async (t) => {
  const state = await rolloutFixture(t);
  const disabled = await state.registry.getFederationRollout(state.remoteServerId);
  assert.equal(disabled.stage, 'DISABLED');

  const observeRequest = {
    serverId: state.remoteServerId,
    expectedRegistryGeneration: disabled.registryGeneration,
    stage: 'OBSERVE',
    reason: 'Observe signed protocol without relaying target traffic',
    requestKeyHash: 'a'.repeat(64),
    now: state.now,
  };
  const observe = await state.registry.updateFederationRollout(observeRequest);
  assert.equal(observe.stage, 'OBSERVE');
  assert.deepEqual(observe.killSwitches, {
    http: true,
    ws: true,
    publicDelivery: true,
    legacy: true,
  });
  const journals = await state.prisma.registryProjectionJournal.count();
  const replay = await state.registry.updateFederationRollout(observeRequest);
  assert.equal(replay.replayed, true);
  assert.equal(replay.registryGeneration, observe.registryGeneration);
  assert.equal(await state.prisma.registryProjectionJournal.count(), journals);
  await assert.rejects(
    () => state.registry.updateFederationRollout({
      ...observeRequest,
      reason: 'Reuse must not bind the same key to changed request data',
    }),
    /already bound/i,
  );
  await assert.rejects(
    () => state.registry.updateFederationRollout({
      ...observeRequest,
      stage: 'CANARY_5',
      reason: 'Skipping read only is forbidden even with healthy evidence',
      evidence: healthyEvidence(),
      requestKeyHash: 'b'.repeat(64),
      expectedRegistryGeneration: observe.registryGeneration,
    }),
    /one step/i,
  );
});

test('T-CAN-001 promotion enforces readiness, evidence, and 24-hour dwell', async (t) => {
  const state = await rolloutFixture(t);
  const first = await state.registry.updateFederationRollout({
    serverId: state.remoteServerId,
    expectedRegistryGeneration: 1,
    stage: 'OBSERVE',
    reason: 'Observe signed protocol without relaying target traffic',
    requestKeyHash: '1'.repeat(64),
    now: state.now,
  });
  const readOnly = await state.registry.updateFederationRollout({
    serverId: state.remoteServerId,
    expectedRegistryGeneration: first.registryGeneration,
    stage: 'READ_ONLY',
    reason: 'Enable signed read-only actions after target readiness',
    requestKeyHash: '2'.repeat(64),
    now: state.now,
  });
  assert.equal(readOnly.killSwitches.http, false);
  const canary = await state.registry.updateFederationRollout({
    serverId: state.remoteServerId,
    expectedRegistryGeneration: readOnly.registryGeneration,
    stage: 'CANARY_5',
    reason: 'Enable isolated five percent canary with healthy evidence',
    wsEnabled: true,
    publicEnabled: true,
    evidence: healthyEvidence(),
    requestKeyHash: '3'.repeat(64),
    now: state.now,
  });
  assert.equal(canary.stage, 'CANARY_5');
  assert.deepEqual(canary.killSwitches, {
    http: false,
    ws: false,
    publicDelivery: false,
    legacy: true,
  });
  await assert.rejects(
    () => state.registry.updateFederationRollout({
      serverId: state.remoteServerId,
      expectedRegistryGeneration: canary.registryGeneration,
      stage: 'CANARY_25',
      reason: 'Promotion before stage dwell must remain blocked',
      evidence: healthyEvidence({ eligiblePercent: 25 }),
      requestKeyHash: '4'.repeat(64),
      now: state.now,
    }),
    /24-hour window/i,
  );

  await state.prisma.remoteServer.update({
    where: { id: state.remoteServerId },
    data: { rolloutStageStartedAt: new Date(state.now.getTime() - 86_400_000) },
  });
  const promoted = await state.registry.updateFederationRollout({
    serverId: state.remoteServerId,
    expectedRegistryGeneration: canary.registryGeneration,
    stage: 'CANARY_25',
    reason: 'Promote after complete dwell and healthy sampled evidence',
    evidence: healthyEvidence({ eligiblePercent: 25 }),
    requestKeyHash: '5'.repeat(64),
    now: state.now,
  });
  assert.equal(promoted.stage, 'CANARY_25');

  await state.prisma.remoteServer.update({
    where: { id: state.remoteServerId },
    data: {
      transportState: 'OFFLINE',
      transportFreshUntil: new Date(state.now.getTime() - 1),
    },
  });
  const stopped = await state.registry.updateFederationRollout({
    serverId: state.remoteServerId,
    expectedRegistryGeneration: promoted.registryGeneration,
    stage: 'CANARY_25',
    reason: 'Emergency stop disables every target transport immediately',
    httpEnabled: false,
    wsEnabled: false,
    publicEnabled: false,
    requestKeyHash: '6'.repeat(64),
    now: state.now,
  });
  assert.equal(Object.values(stopped.killSwitches).every(Boolean), true);
});

async function endpointCutoverFixture(t) {
  const state = await fixture(t);
  const imported = await state.importer.importAuthoritativeJson();
  await state.importer.cutoverToDb(imported.sourceDigest);
  const remoteServerId = '11111111-2222-4333-8444-555555555555';
  await state.prisma.remoteServer.create({
    data: {
      id: remoteServerId,
      installationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      displayName: 'Panel Access target',
      trustState: 'ACTIVE',
      topologyMode: 'PUBLIC',
      activeEndpointGeneration: 1,
      endpoints: {
        create: {
          generation: 1,
          state: 'ACTIVE',
          apiOrigin: 'https://old.target.test',
          wsOrigin: 'https://old.target.test',
          wsPath: '/socket.io',
          browserPublicOrigin: 'https://old.target.test',
          directTransferOrigin: 'https://old.target.test',
          sshHost: 'old.target.test',
          sshPort: 2222,
          spkiSha256: `sha256/${Buffer.alloc(32, 1).toString('base64')}`,
          normalizedHash: 'a'.repeat(64),
          verifiedAt: new Date(),
        },
      },
    },
  });
  return { ...state, remoteServerId };
}

async function stageEndpointCutover(state, cutoverId) {
  await state.registry.prepareEndpointCutover({
    cutoverId,
    remoteServerId: state.remoteServerId,
    deadlineAt: new Date(Date.now() + 10 * 60_000),
  });
  return state.registry.stageEndpointCutover({
    cutoverId,
    apiOrigin: 'https://new.target.test',
    wsOrigin: 'https://new.target.test',
    wsPath: '/socket.io',
    browserPublicOrigin: 'https://new.target.test',
    directTransferOrigin: 'https://new.target.test',
    spkiSha256: `sha256/${Buffer.alloc(32, 2).toString('base64')}`,
    now: new Date(),
  });
}

test('T-PA-001 endpoint candidate stages without replacing the active listener', async (t) => {
  const state = await endpointCutoverFixture(t);
  const cutoverId = '22222222-3333-4444-8555-666666666666';
  await stageEndpointCutover(state, cutoverId);
  const server = await state.prisma.remoteServer.findUnique({
    where: { id: state.remoteServerId },
    include: { endpoints: { orderBy: { generation: 'asc' } } },
  });
  assert.equal(server.activeEndpointGeneration, 1);
  assert.equal(server.candidateEndpointGeneration, 2);
  assert.deepEqual(server.endpoints.map(({ state: endpointState }) => endpointState), ['ACTIVE', 'CANDIDATE']);

  await state.registry.activateEndpointCutover(cutoverId);
  await state.registry.markEndpointCutoverNeedsAttention(cutoverId, 'ACK_LOST');
  await state.registry.finalizeEndpointCutover(cutoverId);
  const finalized = await state.prisma.remoteEndpointCutover.findUnique({ where: { id: cutoverId } });
  assert.equal(finalized.state, 'FINALIZED');
  assert.ok(finalized.activatedAt);
  assert.ok(finalized.finalizedAt);
});

test('T-PA-003 rollback from lost acknowledgement restores the previous endpoint generation', async (t) => {
  const state = await endpointCutoverFixture(t);
  const cutoverId = '33333333-4444-4555-8666-777777777777';
  await stageEndpointCutover(state, cutoverId);
  await state.registry.activateEndpointCutover(cutoverId);
  await state.registry.markEndpointCutoverNeedsAttention(cutoverId, 'TARGET_STATUS_UNAVAILABLE');
  await state.registry.rollbackEndpointCutover(cutoverId, 'AUTO_ROLLBACK');
  await state.registry.rollbackEndpointCutover(cutoverId, 'AUTO_ROLLBACK');

  const server = await state.prisma.remoteServer.findUnique({
    where: { id: state.remoteServerId },
    include: { endpoints: { orderBy: { generation: 'asc' } } },
  });
  assert.equal(server.activeEndpointGeneration, 1);
  assert.equal(server.candidateEndpointGeneration, null);
  assert.equal(server.previousEndpointGeneration, 2);
  assert.deepEqual(server.endpoints.map(({ state: endpointState }) => endpointState), ['ACTIVE', 'ROLLED_BACK']);
  assert.equal(
    (await state.prisma.remoteEndpointCutover.findUnique({ where: { id: cutoverId } })).state,
    'ROLLED_BACK',
  );
});
