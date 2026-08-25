'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PrismaClient } = require('@prisma/client');
const masterKey = require('../src/common/crypto/master-key');
const { IpAllowlistGuard } = require('../src/admin-security/ip-allowlist.guard');
const {
  FederationActionCatalogueService,
} = require('../src/federation/federation-action-catalogue.service');
const {
  ENROLLMENT_PROOF_HEADER,
} = require('../src/federation/federation-enrollment-bootstrap');
const {
  FederationEnrollmentBootstrapGuard,
} = require('../src/federation/federation-enrollment-bootstrap.guard');
const {
  FederationEnrollmentService,
} = require('../src/federation/federation-enrollment.service');
const {
  generateFederationRelationshipKey,
} = require('../src/federation/federation-key-material');
const {
  FederationManifestAccessGuard,
} = require('../src/federation/federation-manifest-access.guard');
const {
  PanelIdentityService,
} = require('../src/federation/panel-identity.service');

function executionContext(request) {
  return { switchToHttp: () => ({ getRequest: () => request }) };
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-enrollment-'));
  const databaseUrl = `file:${path.join(root, 'fixture.db')}`;
  execFileSync(path.resolve(__dirname, '../node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'ignore',
  });
  const previous = process.env.MEOWBOX_MASTER_KEY;
  process.env.MEOWBOX_MASTER_KEY = Buffer.alloc(32, 51).toString('base64');
  masterKey._resetMasterKeyCacheForTests();
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  t.after(async () => {
    await prisma.$disconnect();
    if (previous === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previous;
    masterKey._resetMasterKeyCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const identity = new PanelIdentityService(prisma, { get: () => 'TARGET' });
  const catalogue = new FederationActionCatalogueService();
  return {
    prisma,
    identity,
    catalogue,
    service: new FederationEnrollmentService(prisma, identity, catalogue),
    bootstrapGuard: new FederationEnrollmentBootstrapGuard(prisma),
    manifestGuard: new FederationManifestAccessGuard(prisma),
  };
}

async function prepare(f, proof, fingerprint) {
  return f.service.prepareTargetBootstrap({
    requestedDisplayName: 'Fixture target',
    sshHost: 'target.example',
    sshPort: 2222,
    sshFingerprint: fingerprint,
    proof,
    expiresAt: new Date(Date.now() + 5 * 60_000),
  });
}

test('T-PROV-001 target bootstrap is hash-only, bounded and idempotent before consume', async (t) => {
  const f = await fixture(t);
  const proof = randomBytes(32);
  const fingerprint = `SHA256:${Buffer.alloc(32, 3).toString('base64')}`;
  const first = await prepare(f, proof, fingerprint);
  const second = await prepare(f, proof, fingerprint);
  assert.deepEqual(second, first);
  const row = await f.prisma.federationEnrollment.findUniqueOrThrow({ where: { id: first.id } });
  assert.equal(row.state, 'SSH_VERIFIED');
  assert.match(row.bootstrapHash, /^[0-9a-f]{64}$/);
  assert.equal(row.bootstrapHash.includes(proof.toString('base64url')), false);
  assert.equal(JSON.stringify(row).includes(proof.toString('base64url')), false);
  assert.equal(await f.prisma.user.count(), 0);
});

test('T-IP-001 only verified bootstrap proof bypasses IP allowlist for establish', async (t) => {
  const f = await fixture(t);
  const proof = randomBytes(32);
  const encoded = proof.toString('base64url');
  const fingerprint = `SHA256:${Buffer.alloc(32, 4).toString('base64')}`;
  await prepare(f, proof, fingerprint);
  const request = {
    method: 'POST',
    originalUrl: '/api/federation/v1/enrollments/establish',
    headers: { [ENROLLMENT_PROOF_HEADER]: encoded },
    ip: '203.0.113.42',
  };
  assert.equal(await f.bootstrapGuard.canActivate(executionContext(request)), true);
  assert.equal(request.federationBootstrapContext.verified, true);
  const ipGuard = new IpAllowlistGuard({
    getConfig: () => ({ enabled: true }),
    isAllowed: () => false,
  });
  assert.equal(ipGuard.canActivate(executionContext(request)), true);

  const forged = {
    ...request,
    headers: { [ENROLLMENT_PROOF_HEADER]: randomBytes(32).toString('base64url') },
    federationBootstrapContext: undefined,
  };
  await f.bootstrapGuard.canActivate(executionContext(forged));
  assert.equal(forged.federationBootstrapContext, undefined);
  assert.throws(() => ipGuard.canActivate(executionContext(forged)), (error) => error?.status === 403);
});

test('T-AUTH-005 enrollment has one effect, reconciles exact retry, and stores only master public key', async (t) => {
  const f = await fixture(t);
  const proof = randomBytes(32);
  const encoded = proof.toString('base64url');
  const fingerprint = `SHA256:${Buffer.alloc(32, 5).toString('base64')}`;
  await prepare(f, proof, fingerprint);
  const request = {
    method: 'POST',
    originalUrl: '/api/federation/v1/enrollments/establish',
    headers: { [ENROLLMENT_PROOF_HEADER]: encoded },
  };
  await f.bootstrapGuard.canActivate(executionContext(request));
  const issuerInstallationId = randomUUID();
  const target = await f.identity.getLocalIdentity();
  const relationship = generateFederationRelationshipKey(
    issuerInstallationId,
    target.installationId,
  );
  const permissions = f.catalogue.activeActions()
    .flatMap((action) => action.authorization.permissions);
  const input = {
    issuerInstallationId,
    keyId: relationship.kid,
    publicKeySpki: relationship.publicKeySpki,
    maxRole: 'ADMIN',
    permissions,
    principalVersion: 1,
    sshFingerprint: fingerprint,
  };
  const result = await f.service.establishTrust(
    request.federationBootstrapContext.enrollmentId,
    proof,
    input,
  );
  assert.equal(result.state, 'MANIFEST_PENDING');
  assert.equal(result.target.installationId, target.installationId);
  assert.equal(Object.hasOwn(result.target, 'manifestPrivateKeyEnc'), false);
  const issuer = await f.prisma.federationIssuer.findFirstOrThrow({ include: { keys: true } });
  assert.equal(issuer.state, 'ACTIVE');
  assert.deepEqual(JSON.parse(issuer.permissionPolicyJson), [...permissions].sort());
  assert.equal(issuer.keys.length, 1);
  assert.equal(issuer.keys[0].encryptedPrivateKey, null);
  assert.equal(issuer.keys[0].publicKeySpki, relationship.publicKeySpki);
  const vpnServicePrincipal = await f.prisma.servicePrincipal.findFirstOrThrow({
    where: { issuerId: issuer.id, subject: 'vpn-subscription-gateway' },
  });
  assert.equal(
    vpnServicePrincipal.purposeNamespace,
    'http.get.federation-v1-vpn-fragments-vpn-user-id',
  );
  assert.deepEqual(
    JSON.parse(vpnServicePrincipal.permissionsJson),
    ['http.get.federation-v1-vpn-fragments-vpn-user-id'],
  );
  const webhookServicePrincipal = await f.prisma.servicePrincipal.findFirstOrThrow({
    where: { issuerId: issuer.id, subject: 'webhook-delivery-gateway' },
  });
  assert.equal(
    webhookServicePrincipal.purposeNamespace,
    'http.post.federation-v1-webhooks-deliveries-delivery-id',
  );
  assert.deepEqual(
    JSON.parse(webhookServicePrincipal.permissionsJson),
    ['http.post.federation-v1-webhooks-deliveries-delivery-id'],
  );
  const enrollment = await f.prisma.federationEnrollment.findFirstOrThrow();
  assert.equal(enrollment.state, 'MANIFEST_PENDING');
  assert.equal(await f.manifestGuard.canActivate(executionContext({
    headers: { [ENROLLMENT_PROOF_HEADER]: encoded },
  })), true);

  const reconciled = await f.service.establishTrust(enrollment.id, proof, input);
  assert.equal(reconciled.state, 'MANIFEST_PENDING');
  assert.equal(await f.prisma.federationIssuer.count(), 1);
  assert.equal(await f.prisma.servicePrincipal.count(), 2);

  const completed = await f.service.completeTargetBootstrap(
    enrollment.id,
    proof,
    enrollment.id,
  );
  assert.equal(completed.state, 'COMPLETED');
  assert.equal((await f.prisma.federationEnrollment.findUniqueOrThrow({
    where: { id: enrollment.id },
  })).state, 'COMPLETED');
});

test('target bootstrap cancellation revokes established issuer and key', async (t) => {
  const f = await fixture(t);
  const proof = randomBytes(32);
  const fingerprint = `SHA256:${Buffer.alloc(32, 8).toString('base64')}`;
  const prepared = await prepare(f, proof, fingerprint);
  const target = await f.identity.getLocalIdentity();
  const relationship = generateFederationRelationshipKey(randomUUID(), target.installationId);
  await f.service.establishTrust(prepared.id, proof, {
    issuerInstallationId: relationship.issuerInstallationId,
    keyId: relationship.kid,
    publicKeySpki: relationship.publicKeySpki,
    maxRole: 'MANAGER',
    permissions: f.catalogue.activeActions().flatMap((action) => action.authorization.permissions),
    principalVersion: 1,
    sshFingerprint: fingerprint,
  });

  assert.equal((await f.service.cancelTargetBootstrap(
    prepared.id,
    proof,
    prepared.id,
  )).state, 'CANCELLED');
  const issuer = await f.prisma.federationIssuer.findFirstOrThrow({ include: { keys: true } });
  assert.equal(issuer.state, 'REVOKED');
  assert.ok(issuer.revokedAt);
  assert.equal(issuer.keys[0].state, 'REVOKED');
  assert.ok(issuer.keys[0].revokedAt);
});

test('expired/lost-response recovery rotates proof over SSH without duplicating target trust', async (t) => {
  const f = await fixture(t);
  const enrollmentId = randomUUID();
  const firstProof = randomBytes(32);
  const secondProof = randomBytes(32);
  const fingerprint = `SHA256:${Buffer.alloc(32, 9).toString('base64')}`;
  const prepared = await f.service.prepareTargetBootstrap({
    enrollmentId,
    requestedDisplayName: 'Recoverable target',
    sshHost: 'target.example',
    sshPort: 2222,
    sshFingerprint: fingerprint,
    proof: firstProof,
    expiresAt: new Date(Date.now() + 5 * 60_000),
  });
  const target = await f.identity.getLocalIdentity();
  const relationship = generateFederationRelationshipKey(randomUUID(), target.installationId);
  const input = {
    issuerInstallationId: relationship.issuerInstallationId,
    keyId: relationship.kid,
    publicKeySpki: relationship.publicKeySpki,
    maxRole: 'ADMIN',
    permissions: f.catalogue.activeActions().flatMap((action) => action.authorization.permissions),
    principalVersion: 1,
    sshFingerprint: fingerprint,
  };
  await f.service.establishTrust(prepared.id, firstProof, input);
  const rotated = await f.service.prepareTargetBootstrap({
    enrollmentId,
    requestedDisplayName: 'Recoverable target',
    sshHost: 'target.example',
    sshPort: 2222,
    sshFingerprint: fingerprint,
    proof: secondProof,
    expiresAt: new Date(Date.now() + 5 * 60_000),
  });
  assert.equal(rotated.id, enrollmentId);
  assert.equal(rotated.state, 'MANIFEST_PENDING');
  await f.service.establishTrust(enrollmentId, secondProof, input);
  assert.equal(await f.prisma.federationIssuer.count(), 1);

  const request = {
    method: 'POST',
    originalUrl: `/api/federation/v1/enrollments/${enrollmentId}/complete`,
    headers: { [ENROLLMENT_PROOF_HEADER]: secondProof.toString('base64url') },
  };
  await f.bootstrapGuard.canActivate(executionContext(request));
  assert.equal(request.federationBootstrapContext.enrollmentId, enrollmentId);
  await f.service.completeTargetBootstrap(enrollmentId, secondProof, enrollmentId);
});

test('fingerprint or key mismatch leaves bootstrap and trust unchanged', async (t) => {
  const f = await fixture(t);
  const proof = randomBytes(32);
  const fingerprint = `SHA256:${Buffer.alloc(32, 6).toString('base64')}`;
  const prepared = await prepare(f, proof, fingerprint);
  const issuerInstallationId = randomUUID();
  const target = await f.identity.getLocalIdentity();
  const relationship = generateFederationRelationshipKey(issuerInstallationId, target.installationId);
  await assert.rejects(
    () => f.service.establishTrust(prepared.id, proof, {
      issuerInstallationId,
      keyId: relationship.kid,
      publicKeySpki: relationship.publicKeySpki,
      maxRole: 'MANAGER',
      permissions: f.catalogue.activeActions().flatMap((action) => action.authorization.permissions),
      principalVersion: 1,
      sshFingerprint: `SHA256:${Buffer.alloc(32, 7).toString('base64')}`,
    }),
    (error) => error?.status === 401,
  );
  assert.equal(await f.prisma.federationIssuer.count(), 0);
  assert.equal((await f.prisma.federationEnrollment.findUniqueOrThrow({
    where: { id: prepared.id },
  })).state, 'SSH_VERIFIED');
});
