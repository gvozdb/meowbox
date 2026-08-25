'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const masterKey = require('../src/common/crypto/master-key');
const {
  canonicalizeFederationHeaders,
  sha256Body,
  validateGenericControlRequest,
} = require('../src/federation/delegation-headers');
const {
  encodeDelegationAssertion,
  newDelegationNonce,
  verifyDelegationAssertion,
} = require('../src/federation/delegation-envelope');
const {
  generateFederationRelationshipKey,
} = require('../src/federation/federation-key-material');

const ISSUER_ID = '11111111-2222-4333-8444-555555555555';
const TARGET_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function withMasterKey(t) {
  const previous = process.env.MEOWBOX_MASTER_KEY;
  process.env.MEOWBOX_MASTER_KEY = Buffer.alloc(32, 9).toString('base64');
  masterKey._resetMasterKeyCacheForTests();
  t.after(() => {
    if (previous === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previous;
    masterKey._resetMasterKeyCacheForTests();
  });
}

test('allowlisted headers and exact request bytes are signature-bound', (t) => {
  withMasterKey(t);
  const relationship = generateFederationRelationshipKey(ISSUER_ID, TARGET_ID);
  const body = Buffer.from('{"name":"site"}', 'utf8');
  const headers = canonicalizeFederationHeaders([
    ['Accept', 'application/json'],
    ['Content-Type', 'application/json; charset=utf-8'],
    ['Idempotency-Key', 'request-1234'],
    ['Authorization', 'browser-token-is-stripped'],
    ['Cookie', 'browser-cookie-is-stripped'],
  ]);
  const control = validateGenericControlRequest('POST', headers, body);
  const now = 1_788_000_000;
  const claims = {
    keyId: relationship.kid,
    issuedAt: now,
    expiresAt: now + 60,
    nonce: newDelegationNonce(),
    requestId: randomUUID(),
    targetInstallationId: TARGET_ID,
    actionId: 'sites.create',
    actorKind: 'OPERATOR',
    issuerInstallationId: ISSUER_ID,
    subject: 'user-1234',
    browserIp: '198.51.100.24',
    role: 'ADMIN',
    permissions: ['sites.create'],
    principalVersion: 1,
    operationId: null,
    idempotencyId: control.idempotencyKey,
  };
  const binding = {
    method: 'POST',
    targetPathAndQuery: '/api/sites?source=a+b&source=%2b',
    headers,
    bodySha256: control.bodySha256,
  };
  const encoded = encodeDelegationAssertion(claims, binding, relationship);
  const context = {
    expectedIssuerInstallationId: ISSUER_ID,
    expectedTargetInstallationId: TARGET_ID,
    expectedKeyId: relationship.kid,
    publicKeySpki: relationship.publicKeySpki,
    nowSeconds: now + 30,
  };
  assert.deepEqual(verifyDelegationAssertion(encoded, binding, context), claims);

  for (const changed of [
    { ...binding, method: 'PUT' },
    { ...binding, targetPathAndQuery: '/api/sites?source=%2b&source=a+b' },
    { ...binding, bodySha256: sha256Body(Buffer.from('{}')) },
    { ...binding, headers: headers.filter((header) => header.name !== 'accept') },
  ]) {
    assert.throws(
      () => verifyDelegationAssertion(encoded, changed, context),
      (error) => error?.code === 'INVALID_SIGNATURE',
    );
  }
});

test('generic control request rejects duplicate headers, compression and unsafe mutations', () => {
  assert.throws(
    () => canonicalizeFederationHeaders([['Accept', 'a'], ['accept', 'b']]),
    (error) => error?.code === 'DUPLICATE_HEADER',
  );
  assert.throws(
    () => canonicalizeFederationHeaders([['Content-Encoding', 'gzip']]),
    (error) => error?.code === 'COMPRESSED_BODY_UNSUPPORTED',
  );
  assert.throws(
    () => validateGenericControlRequest('POST', [], Buffer.from('{}')),
    (error) => error?.code === 'INVALID_CONTENT_TYPE',
  );
  const jsonHeader = canonicalizeFederationHeaders([
    ['Content-Type', 'application/json'],
  ]);
  assert.throws(
    () => validateGenericControlRequest('POST', jsonHeader, Buffer.from('{}')),
    (error) => error?.code === 'IDEMPOTENCY_KEY_REQUIRED',
  );
  assert.throws(
    () => validateGenericControlRequest('GET', [], Buffer.from('{}')),
    (error) => error?.code === 'BODY_NOT_ALLOWED',
  );
});

test('assertion time window and relationship binding fail closed', (t) => {
  withMasterKey(t);
  const relationship = generateFederationRelationshipKey(ISSUER_ID, TARGET_ID);
  const now = 1_788_000_000;
  const claims = {
    keyId: relationship.kid,
    issuedAt: now,
    expiresAt: now + 60,
    nonce: newDelegationNonce(),
    requestId: randomUUID(),
    targetInstallationId: TARGET_ID,
    actionId: 'dashboard.overview',
    actorKind: 'OPERATOR',
    issuerInstallationId: ISSUER_ID,
    subject: 'user-1234',
    browserIp: '198.51.100.24',
    role: 'MANAGER',
    permissions: ['dashboard.read'],
    principalVersion: 1,
    operationId: null,
    idempotencyId: null,
  };
  const binding = {
    method: 'GET',
    targetPathAndQuery: '/api/dashboard/overview',
    headers: [],
    bodySha256: sha256Body(Buffer.alloc(0)),
  };
  const encoded = encodeDelegationAssertion(claims, binding, relationship);
  assert.throws(
    () => verifyDelegationAssertion(encoded, binding, {
      expectedIssuerInstallationId: ISSUER_ID,
      expectedTargetInstallationId: TARGET_ID,
      expectedKeyId: relationship.kid,
      publicKeySpki: relationship.publicKeySpki,
      nowSeconds: now + 91,
    }),
    (error) => error?.code === 'ASSERTION_EXPIRED',
  );
  assert.throws(
    () => verifyDelegationAssertion(encoded, binding, {
      expectedIssuerInstallationId: ISSUER_ID,
      expectedTargetInstallationId: ISSUER_ID,
      expectedKeyId: relationship.kid,
      publicKeySpki: relationship.publicKeySpki,
      nowSeconds: now,
    }),
    (error) => error?.code === 'ASSERTION_BINDING_MISMATCH',
  );
});
