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
const { DomainContextService } = require('../src/sites/domain-context.service');
const {
  OperationAdmissionService,
} = require('../src/operations/operation-admission.service');
const { OperationsService } = require('../src/operations/operations.service');
const {
  OperationsWorkerService,
} = require('../src/operations/operations-worker.service');
const { SiteNodeService } = require('../src/site-node/site-node.service');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-node-command-'));
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
      username: `node-${suffix}`,
      email: `node-${suffix}@example.test`,
      passwordHash: 'not-used',
      identityKind: 'LOCAL',
      role: 'ADMIN',
    },
  });
  const siteRoot = path.join(root, `site-${suffix}`);
  const commandRoot = path.join(siteRoot, 'www');
  fs.mkdirSync(commandRoot, { recursive: true });
  const site = await prisma.site.create({
    data: {
      name: `node${suffix}`,
      rootPath: siteRoot,
      nginxConfigPath: `/etc/nginx/sites/node${suffix}.conf`,
      systemUser: `nd${suffix}`,
      userId: user.id,
    },
  });
  const domain = await prisma.siteDomain.create({
    data: {
      siteId: site.id,
      domain: `${suffix}.example.test`,
      isPrimary: true,
      filesRelPath: 'www',
      preset: 'CUSTOM',
      runtimeKey: `node_${suffix}`,
    },
  });
  const command = await prisma.siteQuickCommand.create({
    data: {
      siteId: site.id,
      label: 'Build',
      source: 'npm',
      target: 'build',
      cwd: commandRoot,
      sortOrder: 0,
    },
  });
  const operations = new OperationsService(prisma);
  const worker = new OperationsWorkerService(operations);
  const admission = new OperationAdmissionService(operations, {
    getLocalIdentity: async () => ({
      installationId: '11111111-2222-4333-8444-555555555555',
    }),
  });
  const calls = [];
  let agentResult = {
    exitCode: 0,
    output: 'build complete',
    durationMs: 1250,
    truncated: false,
  };
  const agent = {
    runAgentJob: async (input) => {
      calls.push(input);
      return agentResult;
    },
  };
  const service = new SiteNodeService(
    prisma,
    agent,
    new DomainContextService(prisma),
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
    masterKey._resetMasterKeyCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    calls,
    command,
    commandRoot,
    domain,
    prisma,
    service,
    setAgentResult(value) { agentResult = value; },
    site,
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

test('T-OPS-004 quick command snapshots input and completes through one AgentJob action', async (t) => {
  const state = await fixture(t);
  const key = `node-command-${crypto.randomUUID()}`;
  const actor = { userId: state.user.id, role: 'ADMIN' };
  const accepted = await state.service.enqueueQuickCommand(
    state.site.id,
    state.domain.id,
    state.command.id,
    actor,
    key,
  );
  const replay = await state.service.enqueueQuickCommand(
    state.site.id,
    state.domain.id,
    state.command.id,
    actor,
    key,
  );
  assert.equal(replay.operationId, accepted.operationId);
  assert.equal(replay.replayed, true);

  await state.prisma.siteQuickCommand.update({
    where: { id: state.command.id },
    data: { target: 'changed-after-admission', cwd: '/tmp/changed' },
  });
  await state.worker.pollOnce();
  const completed = await waitForStatus(state.prisma, accepted.operationId, 'SUCCEEDED');
  assert.deepEqual(JSON.parse(completed.result), {
    exitCode: 0,
    output: 'build complete',
    durationMs: 1250,
    truncated: false,
  });
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].actionId, 'agent.node.quick_command');
  assert.equal(state.calls[0].payload.target, 'build');
  assert.equal(state.calls[0].payload.cwd, state.commandRoot);
  assert.equal(state.calls[0].cancelSafe, false);
});

test('T-OPS-006 malformed quick-command result needs attention instead of false success', async (t) => {
  const state = await fixture(t);
  state.setAgentResult({ exitCode: 0, output: 'missing metadata', durationMs: 1 });
  const accepted = await state.service.enqueueQuickCommand(
    state.site.id,
    state.domain.id,
    state.command.id,
    { userId: state.user.id, role: 'ADMIN' },
    `node-command-invalid-${crypto.randomUUID()}`,
  );
  await state.worker.pollOnce();
  const failed = await waitForStatus(state.prisma, accepted.operationId, 'NEEDS_ATTENTION');
  assert.match(failed.errorMessage, /invalid result/i);
});
