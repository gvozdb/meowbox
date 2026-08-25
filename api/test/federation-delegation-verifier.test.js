'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const { PrismaClient } = require('@prisma/client');
const masterKey = require('../src/common/crypto/master-key');
const { IpAllowlistGuard } = require('../src/admin-security/ip-allowlist.guard');
const {
  canonicalizeFederationHeaders,
  sha256Body,
} = require('../src/federation/delegation-headers');
const {
  encodeDelegationAssertion,
  newDelegationNonce,
} = require('../src/federation/delegation-envelope');
const {
  FederationDelegationGuard,
} = require('../src/federation/federation-delegation.guard');
const {
  FederationDelegationVerifierService,
} = require('../src/federation/federation-delegation-verifier.service');
const {
  FederatedPrincipalService,
} = require('../src/federation/federated-principal.service');
const {
  FederationReplayService,
} = require('../src/federation/federation-replay.service');
const {
  FederationIdempotencyService,
} = require('../src/federation/federation-idempotency.service');
const {
  generateFederationRelationshipKey,
} = require('../src/federation/federation-key-material');
const {
  PanelIdentityService,
} = require('../src/federation/panel-identity.service');
const {
  ServicePrincipalService,
} = require('../src/federation/service-principal.service');

const descriptor = {
  actionId: 'http.get.sites',
  transport: { kind: 'http', method: 'GET', routeTemplate: '/api/sites' },
  owner: 'target',
  authorization: { roles: ['ADMIN', 'MANAGER'], permissions: ['sites.read'] },
  request: { schema: 'Empty', media: ['application/json'] },
  response: { schema: 'SiteList', media: ['application/json'] },
  execution: { mode: 'INTERACTIVE' },
  idempotency: { policy: 'NOT_DECLARED', currentBehavior: 'READ_ONLY' },
  cancellation: { policy: 'UNSUPPORTED', currentBehavior: 'BOUNDED_READ' },
  deadline: {
    connectMs: 5000,
    headersMs: 15000,
    idleMs: 30000,
    operationMs: 30000,
    currentTimeoutMs: 30000,
    currentTimeoutSource: 'FEDERATION_V1',
  },
  capability: 'sites-read-v1',
  legacy: { behavior: 'FEDERATION_V1', remoteActivation: 'ALLOW' },
  codeOwner: { file: 'api/src/sites/sites.controller.ts', symbol: 'SitesController.findAll' },
  sourceKey: 'http|sites|get',
  sourceBindings: ['http|sites|get'],
  traceability: { cf: [], a: ['A2', 'A3'], sp: ['SP2'], im: [], bn: [] },
  verification: {
    test: 'T-SIG-003',
    metric: { name: 'delegation-denials', comparator: 'EQ', threshold: 0, unit: 'requests' },
  },
};

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-verifier-'));
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
  t.after(async () => {
    await prisma.$disconnect();
    if (previous === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previous;
    masterKey._resetMasterKeyCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const identityService = new PanelIdentityService(prisma, {
    get: (key, fallback) => key === 'MEOWBOX_INSTALLATION_ROLE' ? 'TARGET' : fallback,
  });
  const target = await identityService.getLocalIdentity();
  const issuerInstallationId = randomUUID();
  const relationship = generateFederationRelationshipKey(
    issuerInstallationId,
    target.installationId,
  );
  const issuer = await prisma.federationIssuer.create({
    data: {
      issuerInstallationId,
      targetInstallationId: target.installationId,
      state: 'ACTIVE',
      maxRole: 'ADMIN',
      permissionPolicyJson: JSON.stringify(['sites.read']),
      principalVersion: 1,
      keys: {
        create: {
          kid: relationship.kid,
          publicKeySpki: relationship.publicKeySpki,
          encryptedPrivateKey: null,
          state: 'ACTIVE',
        },
      },
    },
  });
  const verifier = new FederationDelegationVerifierService(
    prisma,
    identityService,
    {
      resolveHttp: (actionId, method, concretePath) =>
        actionId === descriptor.actionId && method === 'GET' && concretePath === '/api/sites'
          ? descriptor
          : undefined,
    },
    new FederationReplayService(prisma, { get: (_key, fallback) => fallback }),
    new FederationIdempotencyService(prisma, { get: (_key, fallback) => fallback }),
    new FederatedPrincipalService(prisma),
    new ServicePrincipalService(prisma),
  );
  return { prisma, target, issuer, relationship, verifier };
}

function signedInput(target, relationship, overrides = {}) {
  const headers = canonicalizeFederationHeaders([
    ['Accept', 'application/json'],
  ]);
  const body = Buffer.alloc(0);
  const binding = {
    method: 'GET',
    targetPathAndQuery: '/api/sites?status=active&status=stopped',
    headers,
    bodySha256: sha256Body(body),
  };
  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims = {
    keyId: relationship.kid,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + 60,
    nonce: newDelegationNonce(),
    requestId: randomUUID(),
    targetInstallationId: target.installationId,
    actionId: descriptor.actionId,
    actorKind: 'OPERATOR',
    issuerInstallationId: relationship.issuerInstallationId,
    subject: randomUUID(),
    browserIp: '198.51.100.25',
    role: 'MANAGER',
    permissions: ['sites.read'],
    principalVersion: 1,
    operationId: null,
    idempotencyId: null,
    ...overrides,
  };
  return {
    encoded: encodeDelegationAssertion(claims, binding, relationship),
    binding,
    concretePath: '/api/sites',
    idempotencyKey: null,
  };
}

test('T-SIG-003 verified delegation creates one shadow operator and consumes replay', async (t) => {
  const state = await fixture(t);
  const input = signedInput(state.target, state.relationship);
  const result = await state.verifier.verify(input);
  assert.equal(result.verified, true);
  assert.equal(result.actorKind, 'OPERATOR');
  assert.deepEqual(result.effectivePermissions, ['sites.read']);
  const user = await state.prisma.user.findUniqueOrThrow({ where: { id: result.userId } });
  assert.equal(user.identityKind, 'FEDERATED');
  assert.equal(await state.prisma.federatedPrincipal.count(), 1);
  assert.equal(await state.prisma.federationReplay.count(), 1);

  await assert.rejects(
    () => state.verifier.verify(input),
    (error) => error?.code === 'REPLAY_DETECTED',
  );
  assert.equal(await state.prisma.federatedPrincipal.count(), 1);
});

test('T-AUTH-003 role ceiling and concrete action mismatch fail before JIT', async (t) => {
  const state = await fixture(t);
  await state.prisma.federationIssuer.update({
    where: { id: state.issuer.id },
    data: { maxRole: 'MANAGER' },
  });
  await assert.rejects(
    () => state.verifier.verify(signedInput(state.target, state.relationship, { role: 'ADMIN' })),
    (error) => error?.code === 'ROLE_CEILING_EXCEEDED',
  );
  const wrongAction = signedInput(state.target, state.relationship);
  wrongAction.concretePath = '/api/sites/other';
  await assert.rejects(
    () => state.verifier.verify(wrongAction),
    (error) => error?.code === 'ACTION_DENIED',
  );
  assert.equal(await state.prisma.federatedPrincipal.count(), 0);
  assert.equal(await state.prisma.federationReplay.count(), 0);
});

test('T-SIG-005 mutation idempotency is hash-only and blocks replay or conflicting reuse', async (t) => {
  const state = await fixture(t);
  const service = new FederationIdempotencyService(
    state.prisma,
    { get: (_key, fallback) => fallback },
  );
  const subject = randomUUID();
  const input = {
    issuerId: state.issuer.id,
    actorKind: 'OPERATOR',
    subject,
    actionId: 'http.post.sites',
    idempotencyKey: 'idempotency-fixture-1234',
    requestId: randomUUID(),
    requestHash: 'a'.repeat(64),
  };
  assert.match(await service.claim(input), /^[0-9a-f-]{36}$/);
  await assert.rejects(
    () => service.claim({ ...input, requestId: randomUUID() }),
    (error) => error?.code === 'IDEMPOTENCY_REPLAY',
  );
  await assert.rejects(
    () => service.claim({ ...input, requestId: randomUUID(), requestHash: 'b'.repeat(64) }),
    (error) => error?.code === 'IDEMPOTENCY_CONFLICT',
  );
  const row = await state.prisma.federationIdempotencyReceipt.findFirstOrThrow();
  assert.equal(JSON.stringify(row).includes(subject), false);
  assert.equal(JSON.stringify(row).includes(input.idempotencyKey), false);
});

test('T-IP-001 only a verified context bypasses target IP allowlist', () => {
  const guard = new IpAllowlistGuard({
    getConfig: () => ({ enabled: true }),
    isAllowed: () => false,
  });
  const context = (request) => ({
    switchToHttp: () => ({ getRequest: () => request }),
  });
  assert.equal(guard.canActivate(context({
    originalUrl: '/api/sites',
    ip: '203.0.113.10',
    headers: {},
    federationContext: { verified: true },
  })), true);
  assert.throws(
    () => guard.canActivate(context({
      originalUrl: '/api/proxy/not-a-proof/sites',
      ip: '203.0.113.10',
      headers: {},
    })),
    (error) => error?.status === 403,
  );
});

test('T-SIG-004 HTTP guard decodes JSON only after verifier success', async () => {
  let received;
  const guard = new FederationDelegationGuard({
    verify: async (input) => {
      received = input;
      return {
        verified: true,
        requestId: randomUUID(),
        actionId: descriptor.actionId,
        targetInstallationId: randomUUID(),
        issuerInstallationId: randomUUID(),
        issuerId: randomUUID(),
        keyId: 'ed25519-test',
        actorKind: 'OPERATOR',
        subject: randomUUID(),
        browserIp: '198.51.100.25',
        role: 'MANAGER',
        principalVersion: 1,
        effectivePermissions: ['sites.read'],
        descriptor,
        userId: randomUUID(),
        principalId: randomUUID(),
        operationId: null,
        idempotencyKey: 'request-1234',
        idempotencyReceiptId: randomUUID(),
        replayHash: 'a'.repeat(64),
      };
    },
  });
  const body = Buffer.from('{"name":"fixture"}', 'utf8');
  const nowSeconds = Math.floor(Date.now() / 1000);
  const assertion = Buffer.from(canonicalJson({
    keyId: `ed25519-${'A'.repeat(22)}`,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + 60,
    nonce: 'A'.repeat(22),
    requestId: randomUUID(),
    targetInstallationId: randomUUID(),
    actionId: descriptor.actionId,
    actorKind: 'OPERATOR',
    issuerInstallationId: randomUUID(),
    subject: randomUUID(),
    browserIp: '198.51.100.25',
    role: 'MANAGER',
    permissions: ['sites.read'],
    principalVersion: 1,
    operationId: null,
    idempotencyId: 'request-1234',
  }), 'utf8').toString('base64url');
  const request = {
    method: 'POST',
    originalUrl: '/api/sites',
    headers: {
      'x-meowbox-assertion': assertion,
      'x-meowbox-signature': 'signature',
      'content-type': 'application/json',
      'idempotency-key': 'request-1234',
    },
    rawHeaders: [
      'Host', 'target.example',
      'X-Meowbox-Assertion', assertion,
      'X-Meowbox-Signature', 'signature',
      'Content-Type', 'application/json',
      'Idempotency-Key', 'request-1234',
    ],
    body,
  };
  assert.equal(await guard.canActivate({
    switchToHttp: () => ({ getRequest: () => request }),
  }), true);
  assert.equal(received.binding.bodySha256, sha256Body(body));
  assert.deepEqual(request.body, { name: 'fixture' });
  assert.equal(request.user.role, 'MANAGER');
});
