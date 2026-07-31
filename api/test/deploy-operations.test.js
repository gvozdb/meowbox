'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');

const { DeployService } = require('../src/deploy/deploy.service');

function domainContext() {
  return {
    requireOwnedSiteDomain: async () => ({
      site: {
        id: 'site-id',
        name: 'example',
        rootPath: '/var/www/example',
      },
      domain: {
        id: 'domain-id',
        domain: 'example.test',
        preset: 'CUSTOM',
        appStatus: 'RUNNING',
        gitRepository: 'https://example.test/repo.git',
        deployBranch: 'main',
        filesRelPath: 'www',
        phpVersion: null,
        appPort: null,
        runtimeKey: 'domain-runtime',
      },
      envVars: {},
    }),
  };
}

function operations(log) {
  return {
    begin: async (input) => {
      log.push(['begin', input]);
      return {
        id: 'operation-id',
        replayed: false,
        status: 'PENDING',
        result: null,
      };
    },
    start: async (...args) => log.push(['start', ...args]),
    step: async (...args) => log.push(['step', ...args]),
    fail: async (...args) => log.push(['fail', ...args]),
  };
}

test('deploy keeps durable domain operation active until agent callback', async () => {
  const operationLog = [];
  const agentEvents = [];
  const createdDeploys = [];
  const prisma = {
    deployLog: {
      findFirst: async () => null,
      findUnique: async () => null,
      updateMany: async () => ({ count: 0 }),
    },
    siteDomain: {
      updateMany: async () => ({ count: 1 }),
    },
  };
  prisma.$transaction = async (callback) =>
    callback({
      siteDomain: prisma.siteDomain,
      deployLog: {
        create: async ({ data }) => {
          const row = { id: 'deploy-id', ...data };
          createdDeploys.push(row);
          return row;
        },
      },
    });
  const service = new DeployService(
    prisma,
    {
      emitToAgentAsync: (event, payload) => agentEvents.push([event, payload]),
    },
    { dispatch: async () => undefined },
    domainContext(),
    operations(operationLog),
  );

  const result = await service.triggerDeploy(
    'site-id',
    'domain-id',
    'user-id',
    'ADMIN',
    'main',
    'domain-deploy-test-0001',
  );

  assert.equal(result.deployLog.id, 'deploy-id');
  assert.equal(createdDeploys[0].operationId, 'operation-id');
  assert.equal(agentEvents[0][1].operationId, 'operation-id');
  assert.ok(
    operationLog.some(
      ([event, , step]) => event === 'step' && step === 'await-agent',
    ),
  );
  assert.equal(operationLog.some(([event]) => event === 'fail'), false);
});

test('agent completion atomically releases deploy operation locks', async () => {
  const writes = [];
  const now = new Date(Date.now() - 1_000);
  const tx = {
    deployLog: {
      findUnique: async () => ({
        siteId: 'site-id',
        siteDomainId: 'domain-id',
        operationId: 'operation-id',
        startedAt: now,
      }),
      update: async (query) => writes.push(['deploy', query]),
    },
    operation: {
      updateMany: async (query) => {
        writes.push(['operation', query]);
        return { count: 1 };
      },
    },
    operationLock: {
      deleteMany: async (query) => writes.push(['locks', query]),
    },
    siteDomain: {
      update: async (query) => writes.push(['domain', query]),
    },
  };
  const prisma = {
    $transaction: async (callback) => callback(tx),
    site: { findUnique: async () => ({ name: 'example' }) },
  };
  const service = new DeployService(
    prisma,
    {},
    { dispatch: async () => undefined },
    {},
    {},
  );

  await service.completeDeploy('deploy-id', true, 'abcdef12', 'release');

  assert.equal(
    writes.find(([kind]) => kind === 'operation')[1].data.status,
    'SUCCEEDED',
  );
  assert.deepEqual(
    writes.find(([kind]) => kind === 'locks')[1].where,
    { operationId: 'operation-id' },
  );
  assert.equal(
    writes.find(([kind]) => kind === 'domain')[1].data.appStatus,
    'RUNNING',
  );
});
