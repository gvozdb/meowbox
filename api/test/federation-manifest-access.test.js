'use strict';

const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const test = require('node:test');
const {
  FederationManifestAccessGuard,
} = require('../src/federation/federation-manifest-access.guard');

function executionContext(request) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  };
}

test('verified delegation accesses manifest without enrollment proof', async () => {
  const guard = new FederationManifestAccessGuard({
    federationEnrollment: { findUnique: async () => assert.fail('DB lookup is not expected') },
  });
  assert.equal(await guard.canActivate(executionContext({
    headers: {},
    federationContext: { verified: true },
  })), true);
});

test('pending enrollment proof is hash-only, bounded and expiry checked', async () => {
  const proof = randomBytes(32);
  const encoded = proof.toString('base64url');
  const expectedHash = createHash('sha256').update(proof).digest('hex');
  const request = { headers: { 'x-meowbox-enrollment-proof': encoded } };
  const guard = new FederationManifestAccessGuard({
    federationEnrollment: {
      findUnique: async ({ where }) => {
        assert.equal(where.bootstrapHash, expectedHash);
        return {
          id: 'enrollment-1',
          enrollmentRole: 'TARGET_BOOTSTRAP',
          state: 'MANIFEST_PENDING',
          expiresAt: new Date(Date.now() + 60_000),
        };
      },
    },
  });
  assert.equal(await guard.canActivate(executionContext(request)), true);
  assert.equal(request.pendingFederationEnrollmentId, 'enrollment-1');

  for (const header of ['', 'short', `${encoded}=`, [encoded, encoded]]) {
    await assert.rejects(
      () => guard.canActivate(executionContext({
        headers: { 'x-meowbox-enrollment-proof': header },
      })),
      (error) => error?.status === 401,
    );
  }
});

test('unknown, stale, or wrong-state enrollment fails with the same boundary', async () => {
  const proof = randomBytes(32).toString('base64url');
  for (const enrollment of [
    null,
    { id: 'x', enrollmentRole: 'TARGET_BOOTSTRAP', state: 'PREPARED', expiresAt: new Date(Date.now() + 60_000) },
    { id: 'x', enrollmentRole: 'TARGET_BOOTSTRAP', state: 'MANIFEST_PENDING', expiresAt: new Date(Date.now() - 1) },
    { id: 'x', enrollmentRole: 'CONTROL_PLANE', state: 'MANIFEST_PENDING', expiresAt: new Date(Date.now() + 60_000) },
  ]) {
    const guard = new FederationManifestAccessGuard({
      federationEnrollment: { findUnique: async () => enrollment },
    });
    await assert.rejects(
      () => guard.canActivate(executionContext({
        headers: { 'x-meowbox-enrollment-proof': proof },
      })),
      (error) => error?.status === 401 && error.message === 'Federation manifest access denied',
    );
  }
});
