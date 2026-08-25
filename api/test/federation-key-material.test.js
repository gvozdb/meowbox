'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const masterKey = require('../src/common/crypto/master-key');
const {
  generateFederationRelationshipKey,
  openFederationPrivateKey,
  signFederationPayload,
  verifyFederationPayload,
} = require('../src/federation/federation-key-material');

const ISSUER_ID = '11111111-2222-4333-8444-555555555555';
const TARGET_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

test('relationship key is target-bound, encrypted and signs with Ed25519', (t) => {
  const previous = process.env.MEOWBOX_MASTER_KEY;
  process.env.MEOWBOX_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
  masterKey._resetMasterKeyCacheForTests();
  t.after(() => {
    if (previous === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previous;
    masterKey._resetMasterKeyCacheForTests();
  });

  const relationship = generateFederationRelationshipKey(ISSUER_ID, TARGET_ID);
  assert.match(relationship.kid, /^ed25519-/);
  assert.equal(relationship.encryptedPrivateKey.includes('PRIVATE KEY'), false);
  assert.equal(
    openFederationPrivateKey(relationship.encryptedPrivateKey, relationship)
      .asymmetricKeyType,
    'ed25519',
  );

  const payload = Buffer.from('MEOWBOX-EDDSA-V1\nrequest');
  const signature = signFederationPayload(payload, relationship);
  assert.equal(
    verifyFederationPayload(payload, signature, relationship.publicKeySpki),
    true,
  );
  assert.equal(
    verifyFederationPayload(
      Buffer.from('MEOWBOX-EDDSA-V1\ndifferent'),
      signature,
      relationship.publicKeySpki,
    ),
    false,
  );

  assert.throws(() =>
    openFederationPrivateKey(relationship.encryptedPrivateKey, {
      ...relationship,
      targetInstallationId: ISSUER_ID,
    }),
  );
});

test('relationship key rejects non-canonical or self relationship IDs', () => {
  assert.throws(() => generateFederationRelationshipKey('issuer', TARGET_ID));
  assert.throws(() => generateFederationRelationshipKey(ISSUER_ID, ISSUER_ID));
  assert.equal(verifyFederationPayload(Buffer.from('x'), 'bad', 'bad'), false);
});

test('Ed25519 verification rejects non-canonical base64url aliases', (t) => {
  const previous = process.env.MEOWBOX_MASTER_KEY;
  process.env.MEOWBOX_MASTER_KEY = Buffer.alloc(32, 8).toString('base64');
  masterKey._resetMasterKeyCacheForTests();
  t.after(() => {
    if (previous === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previous;
    masterKey._resetMasterKeyCacheForTests();
  });
  const issuer = '11111111-2222-4333-8444-555555555555';
  const target = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const key = generateFederationRelationshipKey(issuer, target);
  const payload = Buffer.from('canonical-signature-fixture');
  const signature = signFederationPayload(payload, key);
  const last = signature.at(-1);
  const aliases = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    .split('')
    .filter((candidate) => candidate !== last)
    .map((candidate) => `${signature.slice(0, -1)}${candidate}`)
    .filter((candidate) => Buffer.from(candidate, 'base64url').equals(Buffer.from(signature, 'base64url')));
  assert.ok(aliases.length > 0);
  assert.equal(verifyFederationPayload(payload, signature, key.publicKeySpki), true);
  assert.equal(verifyFederationPayload(payload, aliases[0], key.publicKeySpki), false);
});
