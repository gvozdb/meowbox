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
const { OperationAdmissionService } = require('../src/operations/operation-admission.service');
const { OperationsService } = require('../src/operations/operations.service');
const { OperationsWorkerService } = require('../src/operations/operations-worker.service');
const { MigrationHostpanelService } = require('../src/migration-hostpanel/migration-hostpanel.service');

function plan(name) {
  return {
    sourceSiteId: 7,
    sourceUser: 'legacy',
    sourceDomain: 'legacy.example.test',
    sourceWebroot: '/var/www/legacy/www',
    sourceCms: null,
    sourceCmsVersion: '',
    sourcePhpVersion: '8.4',
    sourceMysqlPrefix: '',
    preset: 'CUSTOM',
    newName: name,
    newDomain: `${name}.example.test`,
    newAliases: [],
    phpVersion: '8.4',
    homeIncludes: [],
    rsyncExtraExcludes: [],
    dbExcludeDataTables: [],
    cronJobs: [],
    ssl: null,
    manticore: { enable: false },
    modxPaths: { connectorsDir: 'connectors', managerDir: 'manager' },
    phpFpm: {
      pm: 'ondemand',
      pmMaxChildren: 5,
      uploadMaxFilesize: '64M',
      postMaxSize: '64M',
      memoryLimit: '256M',
      custom: '',
    },
    nginxCustomConfig: '',
    fsBytes: 0,
    dbBytes: 0,
    warnings: [],
  };
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-hostpanel-cleanup-'));
  const databaseUrl = `file:${path.join(root, 'fixture.db')}`;
  execFileSync(path.resolve(__dirname, '../node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'ignore',
  });
  const previousMasterKey = process.env.MEOWBOX_MASTER_KEY;
  const previousMigrationSecret = process.env.MIGRATION_SECRET;
  process.env.MEOWBOX_MASTER_KEY = crypto.randomBytes(32).toString('base64');
  process.env.MIGRATION_SECRET = crypto.randomBytes(32).toString('base64');
  masterKey._resetMasterKeyCacheForTests();
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = crypto.randomBytes(5).toString('hex');
  const user = await prisma.user.create({
    data: {
      username: `hostpanel-${suffix}`,
      email: `hostpanel-${suffix}@example.test`,
      passwordHash: 'not-used',
      identityKind: 'LOCAL',
      role: 'ADMIN',
    },
  });
  const migration = await prisma.hostpanelMigration.create({
    data: {
      status: 'FAILED',
      source: '{}',
      createdBy: user.id,
      totalSites: 1,
    },
  });
  const item = await prisma.hostpanelMigrationItem.create({
    data: {
      migrationId: migration.id,
      sourceSiteId: 7,
      sourceData: '{}',
      plan: JSON.stringify(plan(`hp_${suffix}`)),
      status: 'FAILED',
      errorMsg: 'fixture interrupted run',
    },
  });
  const operations = new OperationsService(prisma);
  const worker = new OperationsWorkerService(operations);
  const admission = new OperationAdmissionService(operations, {
    getLocalIdentity: async () => ({ installationId: '11111111-2222-4333-8444-555555555555' }),
  });
  let leaksPresent = true;
  const calls = [];
  const relay = {
    isAgentConnected: () => true,
    emitToAgent: async (event, payload) => {
      calls.push({ kind: 'rpc', event, payload });
      if (event !== 'migrate:hostpanel:check-leak') {
        throw new Error(`unexpected RPC ${event}`);
      }
      return {
        success: true,
        data: {
          userExists: leaksPresent,
          homeExists: leaksPresent,
          dbExists: leaksPresent,
        },
      };
    },
    runAgentJob: async (input) => {
      calls.push({ kind: 'job', input });
      assert.equal(input.actionId, 'agent.hostpanel.force_cleanup_name');
      leaksPresent = false;
      return { log: ['crontab cleared', 'runtime artifacts removed'] };
    },
  };
  const service = new MigrationHostpanelService(
    prisma,
    relay,
    {},
    {},
    admission,
    worker,
  );
  service.onModuleInit();
  t.after(async () => {
    service.onModuleDestroy();
    worker.onModuleDestroy();
    await prisma.$disconnect();
    if (previousMasterKey === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previousMasterKey;
    if (previousMigrationSecret === undefined) delete process.env.MIGRATION_SECRET;
    else process.env.MIGRATION_SECRET = previousMigrationSecret;
    masterKey._resetMasterKeyCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    calls,
    get leaksPresent() { return leaksPresent; },
    set leaksPresent(value) { leaksPresent = value; },
    item,
    migration,
    prisma,
    service,
    user,
    worker,
  };
}

async function complete(state, operationId) {
  await state.worker.pollOnce();
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const row = await state.prisma.operation.findUnique({ where: { id: operationId } });
    if (row?.status === 'SUCCEEDED') return JSON.parse(row.result);
    if (['FAILED', 'NEEDS_ATTENTION'].includes(row?.status)) {
      assert.fail(`operation ${operationId} ended in ${row.status}: ${row.errorMessage}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`operation ${operationId} did not complete`);
}

test('T-OPS-004 hostpanel force cleanup is idempotent durable work and confirms postcondition', async (t) => {
  const state = await fixture(t);
  const idempotencyKey = `hostpanel-force-${crypto.randomUUID()}`;
  const accepted = await state.service.forceRetryItem(
    state.migration.id,
    state.item.id,
    state.user.id,
    'ADMIN',
    idempotencyKey,
  );
  const replay = await state.service.forceRetryItem(
    state.migration.id,
    state.item.id,
    state.user.id,
    'ADMIN',
    idempotencyKey,
  );
  assert.equal(replay.operationId, accepted.operationId);
  assert.equal(replay.replayed, true);
  assert.deepEqual(await complete(state, accepted.operationId), {
    migrationId: state.migration.id,
    itemId: state.item.id,
    cleaned: true,
    steps: 2,
  });
  assert.equal(state.leaksPresent, false);
  const jobs = state.calls.filter((call) => call.kind === 'job');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].input.cancelSafe, false);
  assert.equal(jobs[0].input.payload.name, JSON.parse(state.item.plan).newName);
  const operation = await state.prisma.operation.findUnique({ where: { id: accepted.operationId } });
  const agentJob = await state.prisma.agentJob.findFirst({ where: { operationId: accepted.operationId } });
  assert.equal(JSON.stringify(operation).includes(JSON.parse(state.item.plan).newDomain), false);
  assert.equal(JSON.stringify(agentJob).includes(JSON.parse(state.item.plan).newDomain), false);
});

test('T-OPS-004 hostpanel cleanup recovery accepts already-cleaned artifacts without repeating deletion', async (t) => {
  const state = await fixture(t);
  const accepted = await state.service.forceRetryItem(
    state.migration.id,
    state.item.id,
    state.user.id,
    'ADMIN',
    `hostpanel-reconcile-${crypto.randomUUID()}`,
  );
  state.leaksPresent = false;
  assert.deepEqual(await complete(state, accepted.operationId), {
    migrationId: state.migration.id,
    itemId: state.item.id,
    cleaned: true,
    steps: 0,
  });
  assert.equal(state.calls.filter((call) => call.kind === 'job').length, 0);
});
