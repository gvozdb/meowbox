'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const {
  patchFederationTargetEnv,
  prepareFederationTargetConfiguration,
} = require('../src/federation/federation-target-bootstrap-config');

const ENDPOINTS = Object.freeze({
  apiOrigin: 'https://8.8.8.8',
  wsOrigin: 'https://8.8.8.8',
  wsPath: '/socket.io',
  browserPublicOrigin: 'https://8.8.8.8',
  directTransferOrigin: 'https://8.8.8.8',
});

function migrate(databaseUrl) {
  execFileSync(path.resolve(__dirname, '../node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'ignore',
  });
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-target-config-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(stateDir, 'data'), { recursive: true });
  const envFile = path.join(stateDir, '.env');
  const originalEnv = [
    'DATABASE_URL="file:fixture.db"',
    'MEOWBOX_INSTALLATION_ROLE="MASTER"',
    'UNRELATED_FIXTURE_VALUE="preserved"',
    '',
  ].join('\n');
  fs.writeFileSync(envFile, originalEnv, { mode: 0o640 });
  fs.writeFileSync(path.join(stateDir, 'data', 'servers.json'), '[]\n', { mode: 0o600 });
  const databaseUrl = `file:${path.join(root, 'fixture.db')}`;
  migrate(databaseUrl);
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.panelIdentity.create({
    data: { id: '_', installationId: randomUUID(), installationRole: 'MASTER' },
  });
  const config = {
    get: (key, fallback) => key === 'MEOWBOX_STATE_DIR' ? stateDir : fallback,
  };
  const managedKeys = [
    'MEOWBOX_INSTALLATION_ROLE',
    'FEDERATION_API_ORIGIN',
    'FEDERATION_WS_ORIGIN',
    'FEDERATION_WS_PATH',
    'FEDERATION_BROWSER_PUBLIC_ORIGIN',
    'FEDERATION_DIRECT_TRANSFER_ORIGIN',
  ];
  const previous = Object.fromEntries(managedKeys.map((key) => [key, process.env[key]]));
  t.after(async () => {
    await prisma.$disconnect();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { config, envFile, originalEnv, prisma, root, stateDir };
}

test('T-PROV-002 target env patch is deterministic and rejects ambiguous input', () => {
  const source = [
    '# existing target config',
    'MEOWBOX_INSTALLATION_ROLE="MASTER"',
    'FEDERATION_API_ORIGIN=https://1.1.1.1',
    'UNRELATED_FIXTURE_VALUE="preserved exactly"',
    '',
  ].join('\n');
  const patched = patchFederationTargetEnv(source, ENDPOINTS);
  assert.equal(patchFederationTargetEnv(patched, ENDPOINTS), patched);
  assert.match(patched, /^MEOWBOX_INSTALLATION_ROLE=TARGET$/m);
  assert.match(patched, /^FEDERATION_API_ORIGIN=https:\/\/8\.8\.8\.8$/m);
  assert.match(patched, /^UNRELATED_FIXTURE_VALUE="preserved exactly"$/m);
  assert.throws(
    () => patchFederationTargetEnv(`${source}MEOWBOX_INSTALLATION_ROLE=TARGET\n`, ENDPOINTS),
    /duplicate MEOWBOX_INSTALLATION_ROLE/,
  );
  assert.throws(
    () => patchFederationTargetEnv(source, { ...ENDPOINTS, wsOrigin: 'https://1.1.1.1' }),
    /one canonical public target origin/,
  );
});

test('T-PROV-002 standalone MASTER converts once while preserving existing env', async (t) => {
  const f = await fixture(t);
  const first = await prepareFederationTargetConfiguration(f.prisma, f.config, ENDPOINTS);
  const second = await prepareFederationTargetConfiguration(f.prisma, f.config, ENDPOINTS);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal((await f.prisma.panelIdentity.findUniqueOrThrow({ where: { id: '_' } })).installationRole, 'TARGET');
  const patched = fs.readFileSync(f.envFile, 'utf8');
  assert.match(patched, /^UNRELATED_FIXTURE_VALUE="preserved"$/m);
  assert.match(patched, /^FEDERATION_DIRECT_TRANSFER_ORIGIN=https:\/\/8\.8\.8\.8$/m);
  assert.equal(fs.statSync(f.envFile).mode & 0o777, 0o600);
});

test('T-PROV-003 target conversion fails closed for dev-mode and nested fleet state', async (t) => {
  await t.test('dev-mode', async (t) => {
    const f = await fixture(t);
    fs.writeFileSync(path.join(f.root, '.dev-mode'), '1\n');
    await assert.rejects(
      () => prepareFederationTargetConfiguration(f.prisma, f.config, ENDPOINTS),
      /disabled in dev mode/,
    );
    assert.equal(fs.readFileSync(f.envFile, 'utf8'), f.originalEnv);
  });
  await t.test('legacy child registry', async (t) => {
    const f = await fixture(t);
    fs.writeFileSync(path.join(f.stateDir, 'data', 'servers.json'), `${JSON.stringify([{
      id: 'nested',
      name: 'Nested target',
      url: 'https://8.8.4.4',
      token: 'fixture-token-1234567890',
    }])}\n`, { mode: 0o600 });
    await assert.rejects(
      () => prepareFederationTargetConfiguration(f.prisma, f.config, ENDPOINTS),
      /blocked by control-plane state/,
    );
    assert.equal(fs.readFileSync(f.envFile, 'utf8'), f.originalEnv);
    assert.equal((await f.prisma.panelIdentity.findUniqueOrThrow({ where: { id: '_' } })).installationRole, 'MASTER');
  });
});
