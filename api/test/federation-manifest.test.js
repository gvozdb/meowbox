'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PrismaClient } = require('@prisma/client');
const masterKey = require('../src/common/crypto/master-key');
const {
  canonicalFederationJson,
  FederationManifestService,
} = require('../src/federation/federation-manifest.service');
const {
  verifyFederationPayload,
} = require('../src/federation/federation-key-material');
const {
  PanelIdentityService,
} = require('../src/federation/panel-identity.service');
const {
  FederationActionCatalogueService,
} = require('../src/federation/federation-action-catalogue.service');
const {
  FederationLocalEndpointService,
} = require('../src/federation/federation-local-endpoint.service');

async function fixture(t, values = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-manifest-'));
  const databaseUrl = `file:${path.join(root, 'fixture.db')}`;
  execFileSync(path.resolve(__dirname, '../node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'ignore',
  });
  const previous = process.env.MEOWBOX_MASTER_KEY;
  process.env.MEOWBOX_MASTER_KEY = Buffer.alloc(32, 13).toString('base64');
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
  const config = {
    get: (key, fallback) => Object.hasOwn(values, key)
      ? values[key]
      : key === 'MEOWBOX_VERSION'
        ? 'v0.7.35'
        : fallback,
  };
  const catalogue = new FederationActionCatalogueService();
  return {
    identity,
    catalogue,
    service: new FederationManifestService(
      identity,
      config,
      catalogue,
      new FederationLocalEndpointService(config),
    ),
  };
}

test('health is lightweight and omits installation and endpoint details', async (t) => {
  const { service } = await fixture(t);
  assert.deepEqual(service.health(), {
    status: 'ok',
    protocolMin: 1,
    protocolMax: 1,
    manifestSchemaVersion: 1,
  });
});

test('manifest is separately signed, bounded and advertises no unready action', async (t) => {
  const { identity, service, catalogue } = await fixture(t);
  const now = new Date('2026-08-24T16:00:00.000Z');
  const manifest = await service.manifest(now);
  const local = await identity.getLocalIdentity();
  const { signature, ...unsigned } = manifest;
  assert.equal(manifest.endpointState, 'UNCONFIGURED');
  assert.deepEqual(manifest.endpoints, {});
  assert.match(manifest.catalogueSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    Object.keys(manifest.actions).sort(),
    catalogue.activeActions().map((action) => action.actionId).sort(),
  );
  assert.ok(Object.values(manifest.actions).every((action) => action.enabled === false));
  assert.equal(manifest.protocolMode, 'disabled');
  assert.equal(signature.kid, local.manifestKid);
  assert.equal(
    verifyFederationPayload(
      Buffer.from(canonicalFederationJson(unsigned), 'utf8'),
      signature.value,
      local.manifestPublicKeySpki,
    ),
    true,
  );
  assert.equal(await service.manifest(new Date(now.getTime() + 1_000)), manifest);
  assert.equal(JSON.stringify(manifest).includes('manifestPrivateKey'), false);
});

test('ready target advertises canonical endpoints and only read actions in read-only mode', async (t) => {
  const { service, catalogue } = await fixture(t, {
    FEDERATION_PROTOCOL_MODE: 'v1-read-only',
    FEDERATION_API_ORIGIN: 'https://api.target.test',
    FEDERATION_WS_ORIGIN: 'https://ws.target.test',
    FEDERATION_BROWSER_PUBLIC_ORIGIN: 'https://panel.target.test',
    FEDERATION_DIRECT_TRANSFER_ORIGIN: 'https://transfer.target.test',
    FEDERATION_WS_PATH: '/socket.io',
  });
  const manifest = await service.manifest(new Date('2026-08-24T16:00:00.000Z'));
  assert.equal(manifest.endpointState, 'READY');
  assert.deepEqual(manifest.endpoints, {
    apiOrigin: 'https://api.target.test',
    apiPath: '/api',
    wsOrigin: 'https://ws.target.test',
    socketPath: '/socket.io',
    browserPublicOrigin: 'https://panel.target.test',
    directTransferOrigin: 'https://transfer.target.test',
  });
  const enabled = Object.values(manifest.actions).filter((action) => action.enabled);
  assert.deepEqual(
    enabled.map((action) => action.actionId).sort(),
    catalogue.activeActions().filter((action) =>
      action.transport.kind === 'http' &&
      ['GET', 'HEAD'].includes(action.transport.method) &&
      !action.authorization.roles.includes('SERVICE'))
      .map((action) => action.actionId)
      .sort(),
  );
  assert.ok(Object.entries(manifest.actions).filter(([id]) => id.startsWith('ws.'))
    .every(([, action]) => action.enabled === false));
});

test('partial or non-canonical endpoint configuration fails closed', async (t) => {
  const partial = await fixture(t, {
    FEDERATION_API_ORIGIN: 'https://api.target.test',
  });
  await assert.rejects(() => partial.service.manifest(), /partially configured/);

  const unsafe = await fixture(t, {
    FEDERATION_API_ORIGIN: 'http://api.target.test',
    FEDERATION_WS_ORIGIN: 'https://ws.target.test',
    FEDERATION_BROWSER_PUBLIC_ORIGIN: 'https://panel.target.test',
    FEDERATION_DIRECT_TRANSFER_ORIGIN: 'https://transfer.target.test',
  });
  await assert.rejects(() => unsafe.service.manifest(), /must use HTTPS/);
});
