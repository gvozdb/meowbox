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
  PanelIdentityService,
} = require('../src/federation/panel-identity.service');

async function fixture(t, role = 'TARGET') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-identity-'));
  const databaseUrl = `file:${path.join(root, 'fixture.db')}`;
  execFileSync(path.resolve(__dirname, '../node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'ignore',
  });
  const previous = process.env.MEOWBOX_MASTER_KEY;
  process.env.MEOWBOX_MASTER_KEY = Buffer.alloc(32, 11).toString('base64');
  masterKey._resetMasterKeyCacheForTests();
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  t.after(async () => {
    await prisma.$disconnect();
    if (previous === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previous;
    masterKey._resetMasterKeyCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    prisma,
    service: new PanelIdentityService(prisma, {
      get: (_key, fallback) => role ?? fallback,
    }),
  };
}

test('panel identity is stable, target-bound and browser DTO omits key material', async (t) => {
  const { prisma, service } = await fixture(t, 'MASTER');
  const secondService = new PanelIdentityService(prisma, { get: () => 'MASTER' });
  const [first, second] = await Promise.all([
    service.getLocalIdentity(),
    secondService.getLocalIdentity(),
  ]);
  assert.deepEqual(second, first);
  assert.equal(first.installationRole, 'MASTER');
  assert.equal(await prisma.panelIdentity.count(), 1);
  const changedConfig = new PanelIdentityService(prisma, { get: () => 'TARGET' });
  assert.equal((await changedConfig.getLocalIdentity()).installationRole, 'MASTER');
  assert.deepEqual(Object.keys(service.browserSafeIdentity(first)).sort(), [
    'installationId',
    'installationRole',
    'manifestKid',
  ]);
});

test('partially initialized identity fails closed', async (t) => {
  const { prisma, service } = await fixture(t);
  await prisma.panelIdentity.create({
    data: {
      id: '_',
      installationId: '11111111-2222-4333-8444-555555555555',
      installationRole: 'TARGET',
      manifestKid: 'ed25519-abcdefghijklmnopqrstuv',
    },
  });
  await assert.rejects(
    () => service.getLocalIdentity(),
    /partially initialized/,
  );
});
