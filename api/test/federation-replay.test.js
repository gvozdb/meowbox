'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PrismaClient } = require('@prisma/client');
const {
  FederationReplayService,
} = require('../src/federation/federation-replay.service');

async function fixture(t, maxActive = 10_000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-replay-'));
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
      issuerInstallationId: '11111111-2222-4333-8444-555555555555',
      targetInstallationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      state: 'ACTIVE',
    },
  });
  const service = new FederationReplayService(prisma, {
    get: (_key, fallback) => maxActive ?? fallback,
  });
  return { issuer, prisma, service };
}

function input(issuerId, requestId, now = new Date('2026-08-24T16:00:00.000Z')) {
  return {
    issuerId,
    kid: 'ed25519-abcdefghijklmnopqrstuv',
    requestId,
    actionId: 'sites.create',
    nonce: 'abcdefghijklmnopqrstuvwx',
    expiresAt: new Date(now.getTime() + 120_000),
    now,
  };
}

test('persistent replay consume is atomic under competing requests', async (t) => {
  const { issuer, prisma, service } = await fixture(t);
  const request = input(issuer.id, 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff');
  const results = await Promise.allSettled([
    service.consume(request),
    service.consume(request),
  ]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejected = results.find(({ status }) => status === 'rejected');
  assert.equal(rejected.reason.code, 'REPLAY_DETECTED');
  assert.equal(await prisma.federationReplay.count(), 1);
});

test('replay capacity fails closed and expired rows prune in bounded batches', async (t) => {
  const { issuer, prisma, service } = await fixture(t, 1);
  const now = new Date('2026-08-24T16:00:00.000Z');
  await service.consume(input(issuer.id, 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', now));
  await assert.rejects(
    () => service.consume(input(issuer.id, 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa', now)),
    (error) => error?.code === 'REPLAY_CAPACITY_EXCEEDED',
  );
  await prisma.federationReplay.updateMany({
    data: { expiresAt: new Date(now.getTime() - 1) },
  });
  assert.equal(await service.pruneExpired(now, 1), 1);
  assert.equal(await prisma.federationReplay.count(), 0);
});

