'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { PrismaClient } = require('@prisma/client');
const masterKey = require('../src/common/crypto/master-key');
const {
  generateFederationRelationshipKey,
} = require('../src/federation/federation-key-material');
const {
  FederationTrustTargetService,
} = require('../src/federation/federation-trust-target.service');
const {
  FederationTrustLifecycleService,
} = require('../src/proxy/federation-trust-lifecycle.service');

const MASTER_ID = '11111111-2222-4333-8444-555555555555';
const TARGET_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

async function targetFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-key-lifecycle-'));
  const databaseUrl = `file:${path.join(root, 'fixture.db')}`;
  execFileSync(path.resolve(__dirname, '../node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'ignore',
  });
  const previous = process.env.MEOWBOX_MASTER_KEY;
  process.env.MEOWBOX_MASTER_KEY = Buffer.alloc(32, 27).toString('base64');
  masterKey._resetMasterKeyCacheForTests();
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const oldKey = generateFederationRelationshipKey(MASTER_ID, TARGET_ID);
  const issuer = await prisma.federationIssuer.create({
    data: {
      issuerInstallationId: MASTER_ID,
      targetInstallationId: TARGET_ID,
      state: 'ACTIVE',
      maxRole: 'ADMIN',
      permissionPolicyJson: JSON.stringify([
        'http.get.federation-v1-trust-keys',
        'http.post.federation-v1-trust-keys',
        'http.post.federation-v1-trust-revoke',
      ]),
      keys: {
        create: {
          kid: oldKey.kid,
          publicKeySpki: oldKey.publicKeySpki,
          encryptedPrivateKey: null,
          state: 'ACTIVE',
          validFrom: new Date('2026-08-25T10:00:00.000Z'),
        },
      },
    },
  });
  t.after(async () => {
    await prisma.$disconnect();
    if (previous === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previous;
    masterKey._resetMasterKeyCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { prisma, issuer, oldKey };
}

function request(issuerId, keyId, role = 'ADMIN') {
  return {
    federationContext: {
      verified: true,
      issuerId,
      keyId,
      actorKind: 'OPERATOR',
      role,
    },
  };
}

test('T-KEY-001 target rotation keeps only bounded public-key grace and reconciles replay', async (t) => {
  const fixture = await targetFixture(t);
  const service = new FederationTrustTargetService(fixture.prisma);
  const next = generateFederationRelationshipKey(MASTER_ID, TARGET_ID);
  const now = new Date('2026-08-25T12:00:00.000Z');
  const body = {
    previousKid: fixture.oldKey.kid,
    newKid: next.kid,
    newPublicKeySpki: next.publicKeySpki,
    graceSeconds: 3_600,
  };
  const rotated = await service.rotate(request(fixture.issuer.id, fixture.oldKey.kid), body, now);
  assert.equal(rotated.newKid, next.kid);
  assert.equal(rotated.reconciled, false);
  const replay = await service.rotate(request(fixture.issuer.id, fixture.oldKey.kid), body, now);
  assert.equal(replay.reconciled, true);

  const keys = await fixture.prisma.federationKey.findMany({
    where: { issuerId: fixture.issuer.id },
    orderBy: { validFrom: 'asc' },
  });
  assert.equal(keys.length, 2);
  assert.equal(keys.every((key) => key.encryptedPrivateKey === null), true);
  assert.equal(keys.find((key) => key.kid === fixture.oldKey.kid).expiresAt.toISOString(), rotated.graceUntil);
  assert.equal(keys.find((key) => key.kid === next.kid).expiresAt, null);
  assert.equal((await service.list(request(fixture.issuer.id, fixture.oldKey.kid), now)).keys.length, 2);
});

test('T-KEY-002 target revocation is no-grace and federated MANAGER cannot invoke it', async (t) => {
  const fixture = await targetFixture(t);
  const service = new FederationTrustTargetService(fixture.prisma);
  await assert.rejects(
    () => service.revoke(request(fixture.issuer.id, fixture.oldKey.kid, 'MANAGER')),
    /ADMIN is required/,
  );
  const now = new Date('2026-08-25T12:00:00.000Z');
  await service.revoke(request(fixture.issuer.id, fixture.oldKey.kid), now);
  const issuer = await fixture.prisma.federationIssuer.findUnique({
    where: { id: fixture.issuer.id },
    include: { keys: true },
  });
  assert.equal(issuer.state, 'REVOKED');
  assert.equal(issuer.revokedAt.toISOString(), now.toISOString());
  assert.equal(issuer.keys.every((key) => key.state === 'REVOKED' && key.revokedAt), true);
});

function dispatchResponse(data, overrides = {}) {
  return {
    requestId: '99999999-8888-4777-8666-555555555555',
    actionId: 'http.post.federation-v1-trust-keys',
    targetInstallationId: TARGET_ID,
    issuerInstallationId: MASTER_ID,
    keyId: 'fixture-key',
    statusCode: 200,
    body: Readable.from([Buffer.from(JSON.stringify({ success: true, data }))]),
    ...overrides,
  };
}

test('T-KEY-001 master activates pending key only after target acknowledgement', async () => {
  const calls = [];
  const prepared = {
    serverId: 'server-id',
    targetInstallationId: TARGET_ID,
    previousKid: 'old-kid',
    newKid: 'new-kid',
    newPublicKeySpki: 'new-public',
    registryGeneration: 9,
    replayed: false,
  };
  const registry = {
    prepareFederationKeyRotation: async () => prepared,
    activateFederationKeyRotation: async (...args) => {
      calls.push(['activate', ...args]);
      return { activeKid: 'new-kid', graceUntil: '2026-08-25T13:00:00.000Z', replayed: false };
    },
  };
  const dispatcher = {
    dispatch: async (input) => {
      calls.push(['dispatch', input]);
      return dispatchResponse({ newKid: 'new-kid', graceUntil: '2026-08-25T13:00:00.000Z' });
    },
  };
  const contexts = {
    getRemoteContext: async () => ({
      serverId: 'server-id',
      targetInstallationId: TARGET_ID,
      displayName: 'Fixture target',
      protocol: { selected: 1, mode: 'v1-enabled' },
      killSwitches: { http: false },
      status: { transport: { state: 'ONLINE' }, trust: { state: 'ACTIVE' } },
      capabilities: { 'http.post.federation-v1-trust-keys': { enabled: true } },
    }),
  };
  const service = new FederationTrustLifecycleService(
    contexts,
    registry,
    dispatcher,
    { logOut: async () => undefined },
  );
  const result = await service.rotate('server-id', {
    id: 'operator-id',
    role: 'ADMIN',
    browserIp: '192.0.2.1',
    peerIp: '192.0.2.2',
    userAgent: null,
  }, 'rotate-fixture-key');
  assert.equal(result.activeKid, 'new-kid');
  assert.equal(calls[0][0], 'dispatch');
  assert.equal(calls[1][0], 'activate');
});

test('T-KEY-002 master revokes local trust even when target confirmation fails', async () => {
  let revoked = false;
  const service = new FederationTrustLifecycleService(
    {
      getRemoteContext: async () => ({
        targetInstallationId: TARGET_ID,
        displayName: 'Offline target',
      }),
    },
    {
      revokeFederationTrust: async () => {
        revoked = true;
        return { state: 'REVOKED', revokedAt: '2026-08-25T12:00:00.000Z', replayed: false };
      },
    },
    { dispatch: async () => { throw new Error('offline'); } },
    { logOut: async () => undefined },
  );
  const result = await service.revoke('server-id', {
    id: 'operator-id',
    role: 'ADMIN',
    browserIp: '192.0.2.1',
    peerIp: '192.0.2.2',
    userAgent: null,
  }, 'revoke-fixture-key');
  assert.equal(revoked, true);
  assert.equal(result.state, 'REVOKED');
  assert.equal(result.targetConfirmed, false);
});

