'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PrismaClient } = require('@prisma/client');
const { FederatedPrincipalService } = require('../src/federation/federated-principal.service');
const { ServicePrincipalService } = require('../src/federation/service-principal.service');
const { UsersService } = require('../src/users/users.service');
const { SetupController } = require('../src/auth/setup.controller');

const ISSUER_INSTALLATION_ID = '11111111-2222-4333-8444-555555555555';
const TARGET_INSTALLATION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-principal-'));
  const databaseUrl = `file:${path.join(root, 'fixture.db')}`;
  execFileSync(path.resolve(__dirname, '../node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'ignore',
  });
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  t.after(async () => {
    await prisma.$disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const issuer = await prisma.federationIssuer.create({
    data: {
      issuerInstallationId: ISSUER_INSTALLATION_ID,
      targetInstallationId: TARGET_INSTALLATION_ID,
      state: 'ACTIVE',
      principalVersion: 3,
      permissionPolicyJson: JSON.stringify(['webhook.deliver', 'webhook.redrive']),
    },
  });
  return { issuer, prisma };
}

function operatorInput() {
  return {
    issuerInstallationId: ISSUER_INSTALLATION_ID,
    targetInstallationId: TARGET_INSTALLATION_ID,
    subject: 'master-user:42',
    principalVersion: 3,
    displayLabel: 'Operator 42',
  };
}

test('T-AUTH-001 JIT operator is stable, hidden and cannot enter local auth paths', async (t) => {
  const { issuer, prisma } = await fixture(t);
  const principals = new FederatedPrincipalService(prisma);
  const first = await principals.resolveVerifiedOperator(operatorInput());
  const second = await principals.resolveVerifiedOperator(operatorInput());
  assert.deepEqual(second, first);
  assert.equal(await prisma.federatedPrincipal.count(), 1);
  assert.equal(await prisma.user.count(), 1);

  const shadow = await prisma.user.findUnique({ where: { id: first.userId } });
  assert.equal(shadow.identityKind, 'FEDERATED');
  assert.equal(shadow.role, 'MANAGER');
  assert.match(shadow.username, /^__meowbox_federated_/);

  const users = new UsersService(prisma, {
    cleanupArtifactsForUser: async () => undefined,
  });
  assert.equal(await users.findByUsername(shadow.username), null);
  assert.equal(await users.findById(shadow.id), null);
  assert.deepEqual(await users.findAll(), []);
  await assert.rejects(
    () => users.create({
      username: '__meowbox_federated_collision',
      email: 'local@example.test',
      password: 'not-used-because-name-is-reserved',
      role: 'ADMIN',
    }),
    /reserved/,
  );

  const setup = new SetupController(prisma, users);
  assert.equal((await setup.getSetupStatus()).data.needsSetup, true);

  await principals.tombstone(issuer.id, operatorInput().subject);
  await assert.rejects(
    () => principals.resolveVerifiedOperator(operatorInput()),
    (error) => error?.code === 'PRINCIPAL_TOMBSTONED',
  );
});

test('T-AUTH-002 stale or revoked issuer cannot resolve a shadow operator', async (t) => {
  const { issuer, prisma } = await fixture(t);
  const service = new FederatedPrincipalService(prisma);
  await assert.rejects(
    () => service.resolveVerifiedOperator({ ...operatorInput(), principalVersion: 2 }),
    (error) => error?.code === 'PRINCIPAL_VERSION_MISMATCH',
  );
  await prisma.federationIssuer.update({
    where: { id: issuer.id },
    data: { state: 'REVOKED', revokedAt: new Date() },
  });
  await assert.rejects(
    () => service.resolveVerifiedOperator(operatorInput()),
    (error) => error?.code === 'ISSUER_NOT_ACTIVE',
  );
  assert.equal(await prisma.user.count(), 0);
});

test('T-AUTH-003 service principal stays separate and is purpose/permission bounded', async (t) => {
  const { issuer, prisma } = await fixture(t);
  const principal = await prisma.servicePrincipal.create({
    data: {
      issuerId: issuer.id,
      subject: 'delivery:webhook-route-1',
      purposeNamespace: 'webhook',
      principalVersion: 3,
      permissionsJson: JSON.stringify(['webhook.deliver']),
    },
  });
  const service = new ServicePrincipalService(prisma);
  const resolved = await service.resolveVerifiedService({
    issuerInstallationId: ISSUER_INSTALLATION_ID,
    targetInstallationId: TARGET_INSTALLATION_ID,
    subject: principal.subject,
    principalVersion: 3,
    actionId: 'webhook.deliver',
    permissions: ['webhook.deliver', 'webhook.redrive'],
  });
  assert.deepEqual(resolved.effectivePermissions, ['webhook.deliver']);
  assert.equal(await prisma.user.count(), 0, 'service actor must not create User');
  await prisma.servicePrincipal.update({
    where: { id: principal.id },
    data: { purposeNamespace: 'webhook.deliver' },
  });
  assert.equal((await service.resolveVerifiedService({
    issuerInstallationId: ISSUER_INSTALLATION_ID,
    targetInstallationId: TARGET_INSTALLATION_ID,
    subject: principal.subject,
    principalVersion: 3,
    actionId: 'webhook.deliver',
    permissions: ['webhook.deliver'],
  })).purposeNamespace, 'webhook.deliver');
  await assert.rejects(
    () => service.resolveVerifiedService({
      issuerInstallationId: ISSUER_INSTALLATION_ID,
      targetInstallationId: TARGET_INSTALLATION_ID,
      subject: principal.subject,
      principalVersion: 3,
      actionId: 'vpn.fragment',
      permissions: ['webhook.deliver'],
    }),
    (error) => error?.code === 'SERVICE_SCOPE_DENIED',
  );
});

test('T-AUTH-004 local user administration preserves self and last-admin floors', async (t) => {
  const { prisma } = await fixture(t);
  const users = new UsersService(prisma, {
    cleanupArtifactsForUser: async () => undefined,
  });
  const first = await prisma.user.create({
    data: {
      username: 'admin-one',
      email: 'admin-one@example.test',
      passwordHash: 'fixture',
      identityKind: 'LOCAL',
      role: 'ADMIN',
    },
  });
  const manager = await prisma.user.create({
    data: {
      username: 'manager-one',
      email: 'manager-one@example.test',
      passwordHash: 'fixture',
      identityKind: 'LOCAL',
      role: 'MANAGER',
    },
  });
  await assert.rejects(() => users.delete(first.id, first.id), /current local user/);
  await assert.rejects(() => users.update(first.id, { role: 'MANAGER' }), /last local admin/);
  await assert.rejects(() => users.delete(first.id, manager.id), /last local admin/);

  const second = await prisma.user.create({
    data: {
      username: 'admin-two',
      email: 'admin-two@example.test',
      passwordHash: 'fixture',
      identityKind: 'LOCAL',
      role: 'ADMIN',
    },
  });
  await users.delete(first.id, second.id);
  assert.equal(await prisma.user.findUnique({ where: { id: first.id } }), null);
});
