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
const { CountryBlockService } = require('../src/country-block/country-block.service');
const {
  OperationAdmissionService,
} = require('../src/operations/operation-admission.service');
const { OperationsService } = require('../src/operations/operations.service');
const {
  OperationsWorkerService,
} = require('../src/operations/operations-worker.service');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-country-block-'));
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
  const user = await prisma.user.create({
    data: {
      username: `country-block-${crypto.randomUUID()}`,
      email: `country-block-${crypto.randomUUID()}@example.test`,
      passwordHash: 'not-used',
      identityKind: 'LOCAL',
      role: 'ADMIN',
    },
  });
  await prisma.countryBlock.create({
    data: {
      country: 'DE',
      ports: '80,443',
      protocol: 'TCP',
      enabled: true,
    },
  });
  const operations = new OperationsService(prisma);
  const worker = new OperationsWorkerService(operations);
  const admission = new OperationAdmissionService(operations, {
    getLocalIdentity: async () => ({
      installationId: '11111111-2222-4333-8444-555555555555',
    }),
  });
  let settings = {
    enabled: true,
    updateSchedule: '0 4 * * *',
    primarySource: 'IPDENY',
    lastUpdate: null,
    lastUpdateError: null,
  };
  const panelSettings = {
    get: async (key) => {
      assert.equal(key, 'country-block');
      return { ...settings };
    },
    set: async (key, value) => {
      assert.equal(key, 'country-block');
      settings = { ...value };
      return { ...settings };
    },
  };
  t.after(async () => {
    worker.onModuleDestroy();
    await prisma.$disconnect();
    if (previousMasterKey === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previousMasterKey;
    masterKey._resetMasterKeyCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    admission,
    getSettings: () => ({ ...settings }),
    panelSettings,
    prisma,
    user,
    worker,
  };
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

test('T-OPS-004 country database refresh is admitted once and reapplied through AgentJob', async (t) => {
  const state = await fixture(t);
  const calls = [];
  const service = new CountryBlockService(
    state.prisma,
    {
      runAgentJob: async (input) => {
        calls.push(input);
        return input.actionId === 'agent.country_block.refresh_db'
          ? { updated: ['DE'], errors: [] }
          : { applied: 1 };
      },
    },
    state.panelSettings,
    state.admission,
    state.worker,
  );
  service.onModuleInit();
  t.after(() => service.onModuleDestroy());

  const key = `country-refresh-${crypto.randomUUID()}`;
  const accepted = await service.enqueueRefreshDb(
    ['de', 'DE'],
    { userId: state.user.id, role: 'ADMIN' },
    key,
  );
  const replay = await service.enqueueRefreshDb(
    ['DE'],
    { userId: state.user.id, role: 'ADMIN' },
    key,
  );
  assert.equal(replay.operationId, accepted.operationId);
  assert.equal(replay.replayed, true);

  await state.worker.pollOnce();
  const row = await waitForStatus(state.prisma, accepted.operationId, 'SUCCEEDED');
  assert.deepEqual(JSON.parse(row.result), { updated: ['DE'], errors: [] });
  assert.deepEqual(calls.map((call) => call.actionId), [
    'agent.country_block.refresh_db',
    'agent.country_block.apply',
  ]);
  assert.deepEqual(calls[0].payload, {
    countries: ['DE'],
    sources: ['IPDENY', 'GITHUB_HERRBISCH'],
  });
  assert.deepEqual(calls[1].payload.rules, [{
    country: 'DE',
    ports: '80,443',
    protocol: 'TCP',
    enabled: true,
  }]);
  assert.equal(calls.every((call) => call.cancelSafe === false), true);
  assert.match(state.getSettings().lastUpdate, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(state.getSettings().lastUpdateError, null);
});

test('T-OPS-004 country sync requires idempotency and captures a bounded rule snapshot', async (t) => {
  const state = await fixture(t);
  const calls = [];
  const service = new CountryBlockService(
    state.prisma,
    { runAgentJob: async (input) => { calls.push(input); return { applied: 1 }; } },
    state.panelSettings,
    state.admission,
    state.worker,
  );
  service.onModuleInit();
  t.after(() => service.onModuleDestroy());

  await assert.rejects(
    () => service.enqueueSync({ userId: state.user.id, role: 'ADMIN' }),
    /Idempotency-Key/,
  );
  const accepted = await service.enqueueSync(
    { userId: state.user.id, role: 'ADMIN' },
    `country-sync-${crypto.randomUUID()}`,
  );
  await state.worker.pollOnce();
  await waitForStatus(state.prisma, accepted.operationId, 'SUCCEEDED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].actionId, 'agent.country_block.apply');
  assert.deepEqual(calls[0].payload.rules, [{
    country: 'DE',
    ports: '80,443',
    protocol: 'TCP',
    enabled: true,
  }]);
});
