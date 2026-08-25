'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PrismaClient } = require('@prisma/client');
const { RemoteContextService } = require('../src/federation/remote-context.service');

const SERVER_ID = '11111111-2222-4333-8444-555555555555';
const TARGET_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-context-'));
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
  return { prisma, service: new RemoteContextService(prisma) };
}

function capability() {
  return {
    actionId: 'sites.list',
    schemaVersion: 1,
    enabled: true,
    roles: ['ADMIN', 'MANAGER'],
    permissions: ['sites.read'],
    requestMedia: ['application/json'],
    responseMedia: ['application/json'],
    executionMode: 'INTERACTIVE',
    idempotency: 'NOT_DECLARED',
    cancellation: 'UNSUPPORTED',
    connectMs: 5000,
    headersMs: 15000,
    idleMs: 30000,
    operationMs: 30000,
    legacySafe: false,
  };
}

async function createReadyRemote(prisma) {
  const validUntil = new Date('2026-08-24T18:00:00.000Z');
  await prisma.remoteServer.create({
    data: {
      id: SERVER_ID,
      installationId: TARGET_ID,
      displayName: 'Remote fixture',
      registryGeneration: 4,
      activationMode: 'V1_READ_ONLY',
      topologyMode: 'PUBLIC',
      protocolVersion: 1,
      productVersion: 'v0.8.0',
      transportState: 'ONLINE',
      trustState: 'ACTIVE',
      capabilityState: 'FRESH',
      browserState: 'REACHABLE',
      reasonCode: 'READY',
      statusCheckedAt: new Date('2026-08-24T16:00:00.000Z'),
      manifestFetchedAt: new Date('2026-08-24T16:00:00.000Z'),
      activeEndpointGeneration: 2,
      httpEnabled: true,
      wsEnabled: false,
      publicEnabled: true,
      legacyEnabled: false,
      endpoints: {
        create: {
          generation: 2,
          state: 'ACTIVE',
          apiOrigin: 'https://api.remote.test',
          wsOrigin: 'https://ws.remote.test',
          wsPath: '/socket.io',
          browserPublicOrigin: 'https://panel.remote.test',
          directTransferOrigin: 'https://transfer.remote.test',
          sshHost: 'remote.test',
          sshPort: 2222,
          spkiSha256: `sha256/${Buffer.alloc(32, 3).toString('base64')}`,
          normalizedHash: 'a'.repeat(64),
          verifiedAt: new Date('2026-08-24T16:00:00.000Z'),
        },
      },
      manifests: {
        create: {
          schemaVersion: 1,
          revision: 'fixture-r1',
          protocolMin: 1,
          protocolMax: 1,
          acceptedMasterRange: JSON.stringify({ min: 1, max: 1 }),
          capabilitiesJson: JSON.stringify({ 'sites.list': capability() }),
          endpointsJson: '{}',
          signingKid: 'ed25519-abcdefghijklmnopqrstuv',
          signature: 'fixture-signature',
          validationState: 'VALID',
          validUntil,
        },
      },
    },
  });
}

test('browser context exposes direct/public/SSH facts but omits control origins and keys', async (t) => {
  const { prisma, service } = await fixture(t);
  await createReadyRemote(prisma);
  const context = await service.getBrowserContext(SERVER_ID);
  assert.equal(context.serverId, SERVER_ID);
  assert.equal(context.sshHost, 'remote.test');
  assert.equal(context.sshPort, 2222);
  assert.equal(context.browserPublicOrigin, 'https://panel.remote.test');
  const serialized = JSON.stringify(context);
  assert.equal(serialized.includes('api.remote.test'), false);
  assert.equal(serialized.includes('ws.remote.test'), false);
  assert.equal(serialized.includes('spki'), false);
  assert.deepEqual(context.killSwitches, {
    http: false,
    ws: true,
    publicDelivery: false,
    legacy: true,
  });
});

test('missing verified endpoint and malformed capability snapshot fail closed', async (t) => {
  const { prisma, service } = await fixture(t);
  await createReadyRemote(prisma);
  await prisma.remoteEndpoint.updateMany({ data: { verifiedAt: null } });
  await assert.rejects(() => service.getRemoteContext(SERVER_ID), /verified canonical endpoint/);
  await prisma.remoteEndpoint.updateMany({ data: { verifiedAt: new Date() } });
  await prisma.remoteManifestSnapshot.updateMany({ data: { capabilitiesJson: '{"sites.list":{"enabled":true}}' } });
  await assert.rejects(() => service.getRemoteContext(SERVER_ID), /contract validation/);
});

