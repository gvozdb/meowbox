'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PrismaClient } = require('@prisma/client');
const masterKey = require('../src/common/crypto/master-key');
const {
  OperationAdmissionService,
} = require('../src/operations/operation-admission.service');
const { OperationsService } = require('../src/operations/operations.service');
const {
  OperationsWorkerService,
} = require('../src/operations/operations-worker.service');
const { SslService } = require('../src/ssl/ssl.service');

async function fixture(t, runAgentJob) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-ssl-operation-'));
  const databaseUrl = `file:${path.join(root, 'fixture.db')}`;
  execFileSync(path.resolve(__dirname, '../node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'ignore',
  });
  const previousMasterKey = process.env.MEOWBOX_MASTER_KEY;
  process.env.MEOWBOX_MASTER_KEY = crypto.randomBytes(32).toString('base64');
  masterKey._resetMasterKeyCacheForTests();
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = crypto.randomBytes(5).toString('hex');
  const user = await prisma.user.create({
    data: {
      username: `ssl-operation-${suffix}`,
      email: `ssl-operation-${suffix}@example.test`,
      passwordHash: 'not-used',
      identityKind: 'LOCAL',
      role: 'ADMIN',
    },
  });
  const site = await prisma.site.create({
    data: {
      name: `ssl${suffix}`,
      rootPath: `/var/www/ssl${suffix}`,
      nginxConfigPath: `/etc/nginx/sites-available/ssl${suffix}.conf`,
      systemUser: `ssl${suffix}`,
      userId: user.id,
    },
  });
  const domain = await prisma.siteDomain.create({
    data: {
      siteId: site.id,
      domain: `${suffix}.example.test`,
      isPrimary: true,
      aliases: JSON.stringify([
        { domain: `www-${suffix}.example.test`, redirect: true },
      ]),
      filesRelPath: 'www',
      preset: 'CUSTOM',
      runtimeKey: `ssl_${suffix}`,
    },
  });
  const operations = new OperationsService(prisma);
  const worker = new OperationsWorkerService(operations);
  const admission = new OperationAdmissionService(operations, {
    getLocalIdentity: async () => ({
      installationId: '11111111-2222-4333-8444-555555555555',
    }),
  });
  const agentCalls = [];
  const nginxCalls = [];
  const ssl = new SslService(
    prisma,
    {
      runAgentJob: async (input) => {
        agentCalls.push(input);
        return runAgentJob(input);
      },
    },
    { dispatch: async () => undefined },
    {
      regenerateNginx: async (siteId) => {
        nginxCalls.push(siteId);
      },
    },
    admission,
    worker,
  );
  ssl.onModuleInit();
  t.after(async () => {
    ssl.onModuleDestroy();
    worker.onModuleDestroy();
    await prisma.$disconnect();
    if (previousMasterKey === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previousMasterKey;
    masterKey._resetMasterKeyCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { prisma, user, site, domain, worker, ssl, agentCalls, nginxCalls };
}

async function waitForStatus(prisma, operationId, expected) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const row = await prisma.operation.findUnique({ where: { id: operationId } });
    if (row?.status === expected) return row;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`operation ${operationId} did not reach ${expected}`);
}

test('T-OPS-004 SSL issuance is idempotent and persists only a validated AgentJob result', async (t) => {
  const expiresAt = new Date(Date.now() + 80 * 24 * 60 * 60_000).toISOString();
  const data = await fixture(t, async (input) => ({
    certPath: `/etc/letsencrypt/live/${input.payload.domain}/fullchain.pem`,
    keyPath: `/etc/letsencrypt/live/${input.payload.domain}/privkey.pem`,
    expiresAt,
    domains: input.payload.domains,
  }));
  const { prisma, user, site, domain, worker, ssl, agentCalls, nginxCalls } = data;
  const key = `ssl-issue-${crypto.randomUUID()}`;
  const actor = { userId: user.id, role: 'ADMIN' };
  const accepted = await ssl.enqueueIssuance(site.id, domain.id, actor, key);
  const replay = await ssl.enqueueIssuance(site.id, domain.id, actor, key);
  assert.equal(replay.operationId, accepted.operationId);
  assert.equal(replay.requestId, accepted.requestId);
  assert.equal(replay.replayed, true);

  await worker.pollOnce();
  const operation = await waitForStatus(prisma, accepted.operationId, 'SUCCEEDED');
  assert.equal(operation.actionId, 'ssl.issue');
  assert.equal(agentCalls.length, 1);
  assert.equal(agentCalls[0].actionId, 'agent.ssl.issue');
  assert.equal(agentCalls[0].cancelSafe, false);
  assert.deepEqual(agentCalls[0].payload, {
    domain: domain.domain,
    domains: [domain.domain, `www-${domain.domain.split('.')[0]}.example.test`],
  });
  const cert = await prisma.sslCertificate.findUnique({ where: { domainId: domain.id } });
  assert.equal(cert.status, 'ACTIVE');
  assert.equal(cert.certPath, `/etc/letsencrypt/live/${domain.domain}/fullchain.pem`);
  assert.equal(cert.keyPath, `/etc/letsencrypt/live/${domain.domain}/privkey.pem`);
  assert.equal(cert.expiresAt.toISOString(), expiresAt);
  assert.deepEqual(nginxCalls, [site.id]);
});

test('T-OPS-006 mismatched SSL metadata fails closed without activating certificate', async (t) => {
  const data = await fixture(t, async (input) => ({
    certPath: `/etc/letsencrypt/live/${input.payload.domain}/fullchain.pem`,
    keyPath: `/etc/letsencrypt/live/${input.payload.domain}/privkey.pem`,
    expiresAt: new Date(Date.now() + 80 * 24 * 60 * 60_000).toISOString(),
    domains: [input.payload.domain],
  }));
  const { prisma, user, site, domain, worker, ssl, nginxCalls } = data;
  const accepted = await ssl.enqueueIssuance(
    site.id,
    domain.id,
    { userId: user.id, role: 'ADMIN' },
    `ssl-invalid-${crypto.randomUUID()}`,
  );

  await worker.pollOnce();
  await waitForStatus(prisma, accepted.operationId, 'NEEDS_ATTENTION');
  const cert = await prisma.sslCertificate.findUnique({ where: { domainId: domain.id } });
  assert.equal(cert.status, 'NONE');
  assert.equal(cert.certPath, null);
  assert.equal(await prisma.operationLock.count({ where: { operationId: accepted.operationId } }), 2);
  assert.deepEqual(nginxCalls, []);
});

test('T-OPS-004 SSL revoke separates local removal from unconfirmed ACME revoke', async (t) => {
  const data = await fixture(t, async () => ({ removed: true, revoked: false }));
  const { prisma, user, site, domain, worker, ssl, agentCalls, nginxCalls } = data;
  const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60_000);
  await prisma.sslCertificate.create({
    data: {
      siteId: site.id,
      domainId: domain.id,
      domains: JSON.stringify([domain.domain]),
      status: 'ACTIVE',
      issuer: "Let's Encrypt",
      certPath: `/etc/letsencrypt/live/${domain.domain}/fullchain.pem`,
      keyPath: `/etc/letsencrypt/live/${domain.domain}/privkey.pem`,
      issuedAt: new Date(),
      expiresAt,
      daysRemaining: 60,
    },
  });
  const key = `ssl-revoke-${crypto.randomUUID()}`;
  const actor = { userId: user.id, role: 'ADMIN' };
  const accepted = await ssl.enqueueRevoke(site.id, domain.id, actor, key);
  const replay = await ssl.enqueueRevoke(site.id, domain.id, actor, key);
  assert.equal(replay.operationId, accepted.operationId);
  assert.equal(replay.replayed, true);

  await worker.pollOnce();
  const operation = await waitForStatus(prisma, accepted.operationId, 'SUCCEEDED');
  const result = JSON.parse(operation.result);
  assert.equal(result.removed, true);
  assert.equal(result.revoked, false);
  assert.match(result.warning, /ACME revoke was not confirmed/);
  assert.equal(agentCalls.length, 1);
  assert.equal(agentCalls[0].actionId, 'agent.ssl.revoke');
  assert.deepEqual(agentCalls[0].payload, { domain: domain.domain });
  const cert = await prisma.sslCertificate.findUnique({ where: { domainId: domain.id } });
  assert.equal(cert.status, 'NONE');
  assert.equal(cert.certPath, null);
  assert.equal(cert.keyPath, null);
  assert.deepEqual(nginxCalls, [site.id]);
});

test('T-OPS-004 SSL issuance requires explicit idempotency before creating state', async (t) => {
  const { prisma, user, site, domain, ssl } = await fixture(t, async () => null);
  await assert.rejects(
    () => ssl.enqueueIssuance(
      site.id,
      domain.id,
      { userId: user.id, role: 'ADMIN' },
    ),
    /Idempotency-Key/,
  );
  assert.equal(await prisma.operation.count(), 0);
  assert.equal(await prisma.sslCertificate.count(), 0);
});
