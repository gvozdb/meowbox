'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PrismaClient } = require('@prisma/client');
const shared = require('@meowbox/shared');
const masterKey = require('../src/common/crypto/master-key');
const {
  encryptFederatedVpnFragment,
} = require('../src/common/crypto/federated-vpn-cipher');
const {
  verifyFederationPayload,
} = require('../src/federation/federation-key-material');
const {
  PanelIdentityService,
} = require('../src/federation/panel-identity.service');
const {
  FederatedVpnFragmentService,
} = require('../src/vpn/federated-vpn-fragment.service');
const {
  FederatedVpnSubscriptionService,
} = require('../src/vpn/federated-vpn-subscription.service');

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-vpn-federation-'));
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
  t.after(async () => {
    await prisma.$disconnect();
    if (previousKey === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previousKey;
    masterKey._resetMasterKeyCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const identityService = new PanelIdentityService(prisma, {
    get: (key, fallback) => key === 'MEOWBOX_INSTALLATION_ROLE' ? 'MASTER' : fallback,
  });
  const identity = await identityService.getLocalIdentity();
  const actorUserId = randomUUID();
  await prisma.user.create({
    data: {
      id: actorUserId,
      username: `admin-${actorUserId}`,
      email: `${actorUserId}@fixture.invalid`,
      passwordHash: 'fixture-password-hash',
      role: 'ADMIN',
    },
  });

  const sources = new Map();
  const vpnSource = {
    buildFederatedSubscriptionSource: async (sourceId) => {
      const contents = sources.get(sourceId);
      if (!contents) throw new Error('missing fixture source');
      return {
        sourceId,
        epoch: sha256(`${sourceId}\0${contents.join('\0')}`),
        entries: contents.map((content) => ({ fingerprint: sha256(content), content })),
      };
    },
  };
  const fragments = new FederatedVpnFragmentService(vpnSource, identityService);
  const dispatcher = {
    dispatchService: async () => { throw new Error('unexpected remote dispatch'); },
  };
  const subscriptions = new FederatedVpnSubscriptionService(
    prisma,
    identityService,
    dispatcher,
    fragments,
    { browserPublicOrigin: () => 'https://master.fixture.test' },
  );
  return { prisma, identity, actorUserId, sources, fragments, subscriptions };
}

test('T-VPN-001 target fragment is content-bound and signed by panel identity', async (t) => {
  const state = await fixture(t);
  const vpnUserId = randomUUID();
  state.sources.set(vpnUserId, ['vless://fixture-one']);
  const fragment = await state.fragments.create(vpnUserId);
  assert.equal(shared.validateSignedFederatedVpnFragment(fragment).sourceId, vpnUserId);
  assert.equal(fragment.signature.kid, state.identity.manifestKid);
  assert.equal(verifyFederationPayload(
    Buffer.from(shared.canonicalFederationJson(shared.unsignedFederatedVpnFragment(fragment)), 'utf8'),
    fragment.signature.value,
    state.identity.manifestPublicKeySpki,
  ), true);
});

test('T-VPN-002 master token is stable, hashed at rest, ordered, and exactly deduplicated', async (t) => {
  const state = await fixture(t);
  const firstUserId = randomUUID();
  const secondUserId = randomUUID();
  state.sources.set(firstUserId, ['vless://shared', 'vless://first']);
  state.sources.set(secondUserId, ['vless://shared', 'vless://second']);

  const first = await state.subscriptions.createOrGet(
    'main', firstUserId, state.actorUserId, '198.51.100.10',
  );
  const repeated = await state.subscriptions.createOrGet(
    'main', firstUserId, state.actorUserId, '198.51.100.10',
  );
  assert.equal(repeated.url, first.url);
  const token = first.url.split('/').at(-1);
  const persisted = await state.prisma.federatedVpnSubscription.findUnique({
    where: { id: first.resource.id },
    include: { sources: { include: { cache: true } } },
  });
  assert.ok(persisted);
  assert.notEqual(persisted.tokenHash, token);
  assert.equal(persisted.tokenHash, sha256(token));
  assert.equal(persisted.sources[0].cache.payloadEnc.includes('vless://'), false);

  await state.subscriptions.addSource(
    first.resource.id, 'main', secondUserId, state.actorUserId, '198.51.100.10',
  );
  const publicResult = await state.subscriptions.publicSubscription(token, '198.51.100.10');
  assert.equal(publicResult.state, 'fresh');
  assert.equal(
    Buffer.from(publicResult.content, 'base64').toString('utf8'),
    'vless://shared\nvless://first\nvless://second',
  );
});

test('T-VPN-003 cache is stale for at most five minutes and revocation is immediate', async (t) => {
  const state = await fixture(t);
  const vpnUserId = randomUUID();
  state.sources.set(vpnUserId, ['vless://stale-fixture']);
  const delivery = await state.subscriptions.createOrGet(
    'main', vpnUserId, state.actorUserId, '203.0.113.20',
  );
  const token = delivery.url.split('/').at(-1);
  const source = await state.prisma.federatedVpnSubscriptionSource.findFirstOrThrow({
    where: { subscriptionId: delivery.resource.id },
  });
  const staleIssuedAt = new Date(Date.now() - 2 * 60_000);
  const staleFragment = await state.fragments.create(vpnUserId, staleIssuedAt);
  await state.prisma.federatedVpnSubscriptionCache.update({
    where: { sourceId: source.id },
    data: {
      epoch: staleFragment.epoch,
      payloadEnc: encryptFederatedVpnFragment(source.id, staleFragment),
      fingerprint: sha256(shared.canonicalFederationJson(
        shared.unsignedFederatedVpnFragment(staleFragment),
      )),
      generatedAt: new Date(staleFragment.issuedAt),
      validUntil: new Date(staleFragment.expiresAt),
    },
  });
  const originalCreate = state.fragments.create.bind(state.fragments);
  state.fragments.create = async () => { throw new Error('target offline'); };
  const stale = await state.subscriptions.publicSubscription(token, '203.0.113.20');
  assert.equal(stale.state, 'stale');

  const expiredIssuedAt = new Date(Date.now() - 5 * 60_000 - 1000);
  const expiredFragment = await originalCreate(vpnUserId, expiredIssuedAt);
  await state.prisma.federatedVpnSubscriptionCache.update({
    where: { sourceId: source.id },
    data: {
      epoch: expiredFragment.epoch,
      payloadEnc: encryptFederatedVpnFragment(source.id, expiredFragment),
      fingerprint: sha256(shared.canonicalFederationJson(
        shared.unsignedFederatedVpnFragment(expiredFragment),
      )),
      generatedAt: new Date(expiredFragment.issuedAt),
      validUntil: new Date(expiredFragment.expiresAt),
    },
  });
  await assert.rejects(
    state.subscriptions.publicSubscription(token, '203.0.113.20'),
    /unavailable/,
  );

  state.fragments.create = originalCreate;
  const rotated = await state.subscriptions.rotate(delivery.resource.id, state.actorUserId);
  await assert.rejects(
    state.subscriptions.publicSubscription(token, '203.0.113.20'),
  );
  const rotatedToken = rotated.url.split('/').at(-1);
  assert.equal(
    Buffer.from((await state.subscriptions.publicSubscription(rotatedToken, '203.0.113.20')).content, 'base64').toString('utf8'),
    'vless://stale-fixture',
  );
  await state.subscriptions.revoke(rotated.resource.id, state.actorUserId);
  await assert.rejects(
    state.subscriptions.publicSubscription(rotatedToken, '203.0.113.20'),
  );
});
