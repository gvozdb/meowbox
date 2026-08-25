'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash, createHmac, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { PrismaClient } = require('@prisma/client');
const { FEDERATED_WEBHOOK_MAX_RAW_BYTES } = require('@meowbox/shared');
const masterKey = require('../src/common/crypto/master-key');
const { CustomThrottlerGuard } = require('../src/common/guards/throttler-tracker.guard');
const { WebhookDeliveryWorkerService } = require('../src/webhooks/webhook-delivery-worker.service');
const { WebhookIngressService } = require('../src/webhooks/webhook-ingress.service');
const {
  verifyWebhookProviderDelivery,
} = require('../src/webhooks/webhook-provider');
const { WebhookRouteService } = require('../src/webhooks/webhook-route.service');
const { WebhookSpoolService } = require('../src/webhooks/webhook-spool.service');
const { WebhookTargetDeliveryService } = require('../src/webhooks/webhook-target-delivery.service');

const MASTER_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
const SERVER_ID = '33333333-3333-4333-8333-333333333333';
const SITE_ID = '44444444-4444-4444-8444-444444444444';
const DOMAIN_ID = '55555555-5555-4555-8555-555555555555';
const SECRET = 'fixture-webhook-secret-with-entropy';

function githubHeaders(body, deliveryId = 'delivery-1', event = 'push', secret = SECRET) {
  return [
    'content-type', 'application/json; charset=utf-8',
    'x-github-event', event,
    'x-github-delivery', deliveryId,
    'x-hub-signature-256', `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
  ];
}

async function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-webhook-'));
  const databaseUrl = `file:${path.join(root, 'fixture.db')}`;
  execFileSync(path.resolve(__dirname, '../node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'ignore',
  });
  const previousKey = process.env.MEOWBOX_MASTER_KEY;
  process.env.MEOWBOX_MASTER_KEY = Buffer.alloc(32, 53).toString('base64');
  masterKey._resetMasterKeyCacheForTests();
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const user = await prisma.user.create({
    data: {
      username: `webhook-${randomUUID()}`,
      email: `webhook-${randomUUID()}@example.test`,
      passwordHash: 'not-used',
      identityKind: 'LOCAL',
      role: 'ADMIN',
    },
  });
  await prisma.remoteServer.create({
    data: {
      id: SERVER_ID,
      installationId: TARGET_ID,
      displayName: 'Webhook target',
      activationMode: 'V1_ENABLED',
      httpEnabled: true,
      publicEnabled: true,
    },
  });
  const values = {
    MEOWBOX_STATE_DIR: path.join(root, 'state'),
    PANEL_DOMAIN: 'master.example.test',
    PANEL_PORT: '443',
    WEBHOOK_SPOOL_RESERVE_BYTES: 1,
    WEBHOOK_SPOOL_RESERVE_PERCENT: 0,
    WEBHOOK_QUEUE_LIMIT: 1000,
    WEBHOOK_WORKER_CONCURRENCY: 1,
    ...overrides,
  };
  const config = { get: (key, fallback) => Object.hasOwn(values, key) ? values[key] : fallback };
  const identityState = { installationId: MASTER_ID, installationRole: 'MASTER' };
  const identity = { getLocalIdentity: async () => ({ ...identityState }) };
  const contexts = {
    getRemoteContext: async () => ({
      killSwitches: { publicDelivery: false },
      protocol: { mode: 'v1-enabled' },
      capabilities: {
        'http.post.federation-v1-webhooks-deliveries-delivery-id': { enabled: true },
      },
    }),
  };
  const origins = { browserPublicOrigin: () => 'https://master.example.test' };
  const routes = new WebhookRouteService(prisma, identity, contexts, origins);
  const spool = new WebhookSpoolService(config);
  await spool.onModuleInit();
  const ingress = new WebhookIngressService(prisma, routes, spool, config);
  t.after(async () => {
    await prisma.$disconnect();
    if (previousKey === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previousKey;
    masterKey._resetMasterKeyCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, prisma, user, config, identity, identityState, routes, spool, ingress };
}

async function createRoute(f) {
  const delivery = await f.routes.create({
    serverId: SERVER_ID,
    siteId: SITE_ID,
    domainId: DOMAIN_ID,
    domain: 'app.example.test',
    provider: 'GITHUB',
    secret: SECRET,
    actorUserId: f.user.id,
  });
  return { delivery, token: new URL(delivery.url).pathname.split('/').at(-1) };
}

test('T-WEB-001 provider HMAC binds exact raw bytes and rejects duplicate headers', () => {
  const body = Buffer.from('{ "ref":"refs/heads/main", "message":"Привет" }', 'utf8');
  const verified = verifyWebhookProviderDelivery('GITHUB', SECRET, githubHeaders(body), body);
  assert.equal(verified.event, 'push');
  assert.equal(verified.payload.message, 'Привет');
  assert.throws(
    () => verifyWebhookProviderDelivery('GITHUB', SECRET, githubHeaders(body), Buffer.from(JSON.stringify(verified.payload))),
    /signature/i,
  );
  assert.throws(
    () => verifyWebhookProviderDelivery('GITHUB', SECRET, [...githubHeaders(body), 'x-github-event', 'push'], body),
    /exactly once/,
  );

  const giteaBody = Buffer.from('{"ref":"refs/heads/main"}');
  const digest = createHmac('sha256', SECRET).update(giteaBody).digest('hex');
  const gitea = verifyWebhookProviderDelivery('GITEA', SECRET, [
    'content-type', 'application/json',
    'x-gitea-event', 'push',
    'x-gitea-delivery', randomUUID(),
    'x-gitea-signature', digest,
  ], giteaBody);
  assert.equal(gitea.provider, 'GITEA');

  const prefix = '{"ref":"refs/heads/main","padding":"';
  const suffix = '"}';
  const maxBody = Buffer.from(prefix + 'a'.repeat(FEDERATED_WEBHOOK_MAX_RAW_BYTES - prefix.length - suffix.length) + suffix);
  assert.equal(maxBody.length, FEDERATED_WEBHOOK_MAX_RAW_BYTES);
  assert.equal(verifyWebhookProviderDelivery('GITHUB', SECRET, githubHeaders(maxBody), maxBody).event, 'push');
  const oversizedBody = Buffer.concat([maxBody, Buffer.from(' ')]);
  assert.throws(
    () => verifyWebhookProviderDelivery('GITHUB', SECRET, githubHeaders(oversizedBody), oversizedBody),
    /64 KiB/,
  );
});

test('T-WEB-001 public rate keys bind source IP and opaque token without retaining either', async () => {
  const catalogue = { resolveHttpByConcretePath: () => undefined };
  const request = (surface, token) => ({
    headers: {},
    ip: '203.0.113.8',
    originalUrl: `/api/public/v1/${surface}/${token}`,
    params: { token },
  });
  const guard = Object.create(CustomThrottlerGuard.prototype);
  guard.catalogue = catalogue;
  const webhook = await guard.getTracker(request('webhooks', 'token-a'));
  assert.match(webhook, /^public:[0-9a-f]{24}:[0-9a-f]{24}$/);
  assert.equal(webhook.includes('203.0.113.8'), false);
  assert.equal(webhook.includes('token-a'), false);
  assert.notEqual(webhook, await guard.getTracker(request('webhooks', 'token-b')));
  assert.equal(webhook, await guard.getTracker(request('vpn/subscriptions', 'token-a')));
});

test('T-WEB-002 ingress stores hash-only route metadata and encrypted fsync spool', async (t) => {
  const f = await fixture(t);
  const { delivery, token } = await createRoute(f);
  const route = await f.prisma.webhookRoute.findFirstOrThrow();
  assert.equal(JSON.stringify(route).includes(SECRET), false);
  assert.equal(JSON.stringify(route).includes(token), false);
  assert.match(route.tokenHash, /^[0-9a-f]{64}$/);
  assert.equal(delivery.purpose, 'DEPLOY_WEBHOOK');
  await assert.rejects(
    f.routes.create({
      serverId: SERVER_ID,
      siteId: SITE_ID,
      domainId: DOMAIN_ID,
      domain: 'app.example.test',
      provider: 'GITHUB',
      secret: `${SECRET}-different`,
      actorUserId: f.user.id,
    }),
    /different verifier/,
  );

  const body = Buffer.from('{\n  "ref": "refs/heads/main", "message": "Привет"\n}', 'utf8');
  const accepted = await f.ingress.accept(token, githubHeaders(body), body);
  assert.equal(accepted.ignored, false);
  assert.equal(accepted.replayed, false);
  const row = await f.prisma.webhookDelivery.findFirstOrThrow();
  assert.equal(row.bodySha256, createHash('sha256').update(body).digest('hex'));
  const encrypted = fs.readFileSync(path.join(f.spool.queueRoot, row.spoolRelativePath));
  assert.equal(encrypted.includes(body), false);
  assert.equal(encrypted.includes(Buffer.from(SECRET)), false);
  const spooled = await f.spool.read({
    deliveryId: row.id,
    routeId: route.id,
    rawBodySha256: row.bodySha256,
  });
  assert.deepEqual(Buffer.from(spooled.rawBodyBase64, 'base64url'), body);

  const replay = await f.ingress.accept(token, githubHeaders(body), body);
  assert.equal(replay.deliveryId, row.id);
  assert.equal(replay.replayed, true);
  assert.equal(await f.prisma.webhookDelivery.count(), 1);

  const changed = Buffer.from('{"ref":"refs/heads/other"}');
  await assert.rejects(
    f.ingress.accept(token, githubHeaders(changed), changed),
    /different bytes/,
  );
  const ignored = Buffer.from('{"zen":"fixture"}');
  assert.deepEqual(
    await f.ingress.accept(token, githubHeaders(ignored, 'delivery-2', 'ping'), ignored),
    { ignored: true },
  );
});

test('T-WEB-002 queue admission is atomic under concurrent provider deliveries', async (t) => {
  const f = await fixture(t, { WEBHOOK_QUEUE_LIMIT: 1 });
  const { token } = await createRoute(f);
  const body = Buffer.from('{"ref":"refs/heads/main"}');
  const settled = await Promise.allSettled([
    f.ingress.accept(token, githubHeaders(body, 'capacity-a'), body),
    f.ingress.accept(token, githubHeaders(body, 'capacity-b'), body),
  ]);
  assert.equal(settled.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejected = settled.find(({ status }) => status === 'rejected');
  assert.equal(rejected?.status, 'rejected');
  assert.match(String(rejected.reason?.message), /queue is full/);
  assert.equal(await f.prisma.webhookDelivery.count(), 1);
  assert.equal(fs.readdirSync(f.spool.queueRoot).filter((name) => name.endsWith('.payload')).length, 1);
});

test('T-WEB-003 worker delivers with SERVICE assertion input and removes accepted spool', async (t) => {
  const f = await fixture(t);
  const { token } = await createRoute(f);
  const body = Buffer.from('{"ref":"refs/heads/main"}');
  const accepted = await f.ingress.accept(token, githubHeaders(body), body);
  const calls = [];
  const dispatcher = {
    dispatchService: async (input) => {
      calls.push(input);
      const payload = JSON.parse(input.body.toString('utf8'));
      return {
        requestId: '66666666-6666-4666-8666-666666666666',
        statusCode: 200,
        body: Readable.from([Buffer.from(JSON.stringify({
          success: true,
          data: {
            schemaVersion: 1,
            deliveryId: payload.deliveryId,
            status: 'DELIVERED',
            deployId: '77777777-7777-4777-8777-777777777777',
            duplicate: false,
          },
        }))]),
      };
    },
  };
  const worker = new WebhookDeliveryWorkerService(
    f.prisma,
    f.identity,
    dispatcher,
    { deliver: async () => { throw new Error('local target must not be used'); } },
    f.spool,
    f.config,
  );
  await worker.pollOnce(new Date());
  await worker.waitForIdle();
  const row = await f.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: accepted.deliveryId } });
  assert.equal(row.state, 'DELIVERED');
  assert.equal(row.attempt, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].serviceSubject, 'webhook-delivery-gateway');
  assert.match(calls[0].rawHeaders.join(':'), /idempotency-key:webhook-/);
  assert.equal(fs.existsSync(path.join(f.spool.queueRoot, row.spoolRelativePath)), false);
  worker.onModuleDestroy();
});

test('T-WEB-003 retry exhaustion enters DLQ and authorized redrive resets durable state', async (t) => {
  const f = await fixture(t);
  const { token } = await createRoute(f);
  const body = Buffer.from('{"ref":"refs/heads/main"}');
  const accepted = await f.ingress.accept(token, githubHeaders(body), body);
  const worker = new WebhookDeliveryWorkerService(
    f.prisma,
    f.identity,
    { dispatchService: async () => { throw new Error('target offline'); } },
    { deliver: async () => { throw new Error('local target must not be used'); } },
    f.spool,
    f.config,
  );
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    await f.prisma.webhookDelivery.update({
      where: { id: accepted.deliveryId },
      data: { availableAt: new Date(0) },
    });
    await worker.pollOnce(new Date());
    await worker.waitForIdle();
  }
  let row = await f.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: accepted.deliveryId } });
  assert.equal(row.state, 'DLQ');
  assert.equal(row.attempt, 6);
  assert.equal(fs.existsSync(path.join(f.spool.dlqRoot, row.spoolRelativePath)), true);
  await worker.redrive(row.id);
  row = await f.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(row.state, 'ACCEPTED');
  assert.equal(row.attempt, 0);
  assert.equal(fs.existsSync(path.join(f.spool.queueRoot, row.spoolRelativePath)), true);
  worker.onModuleDestroy();
});

test('T-WEB-003 target receipt deduplicates lost acknowledgements before deploy effect', async (t) => {
  const f = await fixture(t);
  f.identityState.installationId = TARGET_ID;
  f.identityState.installationRole = 'TARGET';
  let triggers = 0;
  const deployId = '88888888-8888-4888-8888-888888888888';
  const deploys = {
    findSiteByDomain: async () => ({
      id: DOMAIN_ID,
      domain: 'app.example.test',
      deployBranch: 'main',
      site: { id: SITE_ID, userId: f.user.id },
    }),
    triggerDeploy: async () => {
      triggers += 1;
      return { deployLog: { id: deployId } };
    },
  };
  const service = new WebhookTargetDeliveryService(f.prisma, f.identity, deploys);
  const raw = Buffer.from('{"ref":"refs/heads/main"}');
  const delivery = {
    schemaVersion: 1,
    deliveryId: '99999999-9999-4999-8999-999999999999',
    routeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    targetInstallationId: TARGET_ID,
    siteId: SITE_ID,
    domainId: DOMAIN_ID,
    domain: 'app.example.test',
    provider: 'GITHUB',
    providerDeliveryId: 'provider-target-1',
    event: 'push',
    receivedAt: new Date().toISOString(),
    rawBodyBase64: raw.toString('base64url'),
    rawBodySha256: createHash('sha256').update(raw).digest('hex'),
    providerSignature: `sha256=${'a'.repeat(64)}`,
  };
  const context = { issuerInstallationId: MASTER_ID };
  const first = await service.deliver(delivery, context);
  const replay = await service.deliver(delivery, context);
  assert.equal(first.deployId, deployId);
  assert.equal(replay.duplicate, true);
  assert.equal(triggers, 1);
  const receipt = await f.prisma.webhookDeliveryReceipt.findFirstOrThrow();
  assert.equal(receipt.state, 'DELIVERED');

  deploys.findSiteByDomain = async () => null;
  const failedDelivery = {
    ...delivery,
    deliveryId: randomUUID(),
    providerDeliveryId: 'provider-target-2',
  };
  await assert.rejects(service.deliver(failedDelivery, context), /target domain not found/);
  const failedReceipt = await f.prisma.webhookDeliveryReceipt.findUniqueOrThrow({
    where: {
      issuerInstallationId_deliveryId: {
        issuerInstallationId: MASTER_ID,
        deliveryId: failedDelivery.deliveryId,
      },
    },
  });
  assert.equal(failedReceipt.state, 'FAILED');
  assert.equal(failedReceipt.lastErrorCode, 'TARGET_DEPLOY_FAILED');
});
