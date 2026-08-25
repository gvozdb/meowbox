'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const masterKey = require('../src/common/crypto/master-key');
const { generateFederationRelationshipKey } = require('../src/federation/federation-key-material');
const {
  decodeFederationWsChannelClaims,
  issueFederationWsChannelAssertion,
  newFederationWsChannelNonce,
  verifyFederationWsChannelAssertion,
} = require('../src/federation/federation-ws-channel');

const ISSUER_ID = '11111111-2222-4333-8444-555555555555';
const TARGET_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function fixture(t) {
  const previous = process.env.MEOWBOX_MASTER_KEY;
  process.env.MEOWBOX_MASTER_KEY = Buffer.alloc(32, 29).toString('base64');
  masterKey._resetMasterKeyCacheForTests();
  t.after(() => {
    if (previous === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previous;
    masterKey._resetMasterKeyCacheForTests();
  });
  const key = generateFederationRelationshipKey(ISSUER_ID, TARGET_ID);
  const now = Math.floor(Date.now() / 1_000);
  const claims = {
    keyId: key.kid,
    channelId: randomUUID(),
    targetInstallationId: TARGET_ID,
    issuerInstallationId: ISSUER_ID,
    actorKind: 'OPERATOR',
    subject: 'operator-id',
    browserIp: '203.0.113.7',
    role: 'MANAGER',
    permissions: ['logs.read', 'metrics.read'],
    principalVersion: 3,
    epoch: 9,
    nonce: newFederationWsChannelNonce(),
    actionIds: ['ws.browser.logs-tail-start', 'ws.browser.system-metrics'],
    issuedAt: now,
    expiresAt: now + 60,
  };
  return { key, claims, now };
}

test('T-WS-002 channel assertion binds actor, target, epoch and action set', (t) => {
  const { key, claims, now } = fixture(t);
  const encoded = issueFederationWsChannelAssertion(claims, key);
  const verified = verifyFederationWsChannelAssertion(encoded, {
    expectedIssuerInstallationId: ISSUER_ID,
    expectedTargetInstallationId: TARGET_ID,
    expectedKeyId: key.kid,
    publicKeySpki: key.publicKeySpki,
    nowSeconds: now,
  });
  assert.deepEqual(verified, claims);
  assert.deepEqual(decodeFederationWsChannelClaims(encoded.assertion), claims);
});

test('T-WS-003 channel rejects envelope tamper, signature tamper and expiry', (t) => {
  const { key, claims, now } = fixture(t);
  const encoded = issueFederationWsChannelAssertion(claims, key);
  const context = {
    expectedIssuerInstallationId: ISSUER_ID,
    expectedTargetInstallationId: TARGET_ID,
    expectedKeyId: key.kid,
    publicKeySpki: key.publicKeySpki,
    nowSeconds: now,
    clockSkewSeconds: 0,
  };
  assert.throws(() => verifyFederationWsChannelAssertion({ ...encoded, epoch: 10 }, context), /binding mismatch/);
  assert.throws(() => verifyFederationWsChannelAssertion({
    ...encoded,
    signature: `${encoded.signature.slice(0, -1)}${encoded.signature.endsWith('A') ? 'B' : 'A'}`,
  }, context), /signature is invalid/);
  assert.throws(() => verifyFederationWsChannelAssertion(encoded, {
    ...context,
    nowSeconds: claims.expiresAt + 1,
  }), /outside its time window/);
});

test('T-WS-002 channel claims require sorted, unique, explicit actions', (t) => {
  const { key, claims } = fixture(t);
  assert.throws(() => issueFederationWsChannelAssertion({ ...claims, actionIds: [] }, key));
  assert.throws(() => issueFederationWsChannelAssertion({
    ...claims,
    actionIds: [...claims.actionIds].reverse(),
  }, key));
  assert.throws(() => issueFederationWsChannelAssertion({
    ...claims,
    actionIds: [claims.actionIds[0], claims.actionIds[0]],
  }, key));
});
