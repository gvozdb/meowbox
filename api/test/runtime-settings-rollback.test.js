'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const { DomainApplicationsService } = require(
  '../src/sites/domain-applications.service',
);
const { SitesNginxService } = require('../src/sites/sites-nginx.service');

function operationsMock() {
  const calls = [];
  return {
    calls,
    begin: async (input) => {
      calls.push(['begin', input]);
      return {
        id: 'operation-id',
        siteId: input.siteId || null,
        siteDomainId: input.siteDomainId || null,
        replayed: false,
        status: 'PENDING',
        result: null,
      };
    },
    start: async (...args) => calls.push(['start', ...args]),
    step: async (...args) => calls.push(['step', ...args]),
    succeed: async (...args) => calls.push(['succeed', ...args]),
    fail: async (...args) => calls.push(['fail', ...args]),
  };
}

function nginxDomain(overrides = {}) {
  return {
    id: 'domain-id',
    siteId: 'site-id',
    nginxCustomConfig: 'old custom',
    nginxGzip: false,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    site: {
      id: 'site-id',
      name: 'example',
      userId: 'user-id',
    },
    ...overrides,
  };
}

test('Nginx settings restore metadata and runtime after render failure', async () => {
  const updates = [];
  const prisma = {
    siteDomain: {
      findUnique: async () => nginxDomain(),
      update: async (query) => {
        updates.push(query);
        return nginxDomain(query.data);
      },
    },
  };
  let renderCalls = 0;
  const siteDomains = {
    regenerateNginx: async () => {
      renderCalls += 1;
      if (renderCalls === 1) throw new Error('nginx render failed');
    },
    regenerateGlobalZones: async () => undefined,
  };
  const operations = operationsMock();
  const service = new SitesNginxService(
    prisma,
    {},
    siteDomains,
    operations,
  );

  await assert.rejects(
    () =>
      service.updateSettings(
        'site-id',
        'domain-id',
        { gzip: true },
        'user-id',
        'MANAGER',
      ),
    /nginx render failed/,
  );

  assert.equal(renderCalls, 2);
  assert.deepEqual(updates.map((entry) => entry.data), [
    { nginxGzip: true },
    { nginxGzip: false },
  ]);
  assert.equal(
    operations.calls.some(([name]) => name === 'fail'),
    true,
  );
});

test('custom Nginx config restores disk when metadata write fails', async () => {
  const agentContents = [];
  const updates = [];
  const prisma = {
    siteDomain: {
      findUnique: async () => nginxDomain(),
      update: async (query) => {
        updates.push(query);
        if (updates.length === 1) throw new Error('metadata write failed');
        return nginxDomain(query.data);
      },
    },
  };
  const agent = {
    isAgentConnected: () => true,
    emitToAgent: async (_event, payload) => {
      agentContents.push(payload.content);
      return { success: true };
    },
  };
  const operations = operationsMock();
  const service = new SitesNginxService(
    prisma,
    agent,
    {},
    operations,
  );

  await assert.rejects(
    () =>
      service.updateCustomConfig(
        'site-id',
        'domain-id',
        { content: 'new custom' },
        'user-id',
        'MANAGER',
      ),
    /metadata write failed/,
  );

  assert.deepEqual(agentContents, ['new custom', 'old custom']);
  assert.equal(updates.at(-1).data.nginxCustomConfig, 'old custom');
});

test('PHP pool update restores old pool when metadata write fails', async () => {
  const poolConfigs = [];
  const updates = [];
  const context = {
    site: {
      id: 'site-id',
      name: 'example',
      rootPath: '/var/www/example',
      systemUser: 'example',
    },
    domain: {
      id: 'domain-id',
      domain: 'example.test',
      preset: 'CUSTOM',
      appStatus: 'RUNNING',
      appErrorMessage: null,
      filesRelPath: 'www',
      phpVersion: '8.2',
      phpPoolCustom: 'old pool config',
      runtimeKey: 'd12345678901234567890',
      gitRepository: null,
      deployBranch: null,
      cmsAdminUser: null,
      cmsAdminPasswordEnc: null,
      managerPath: null,
      connectorsPath: null,
      cmsTablePrefix: null,
      modxVersion: null,
      appPort: null,
      sslCertificate: null,
    },
    applicationRoot: '/var/www/example/www',
    isModx: false,
    phpEnabled: true,
    primaryDatabase: null,
  };
  const prisma = {
    siteDomain: {
      update: async (query) => {
        updates.push(query);
        if (updates.length === 1) throw new Error('metadata write failed');
        return context.domain;
      },
    },
  };
  const agent = {
    emitToAgent: async (_event, payload) => {
      poolConfigs.push(payload.customConfig);
      return { success: true };
    },
  };
  const operations = operationsMock();
  const service = new DomainApplicationsService(
    prisma,
    agent,
    { requireOwnedSiteDomain: async () => context },
    {},
    operations,
  );

  await assert.rejects(
    () =>
      service.updatePhpPoolConfig(
        'site-id',
        'domain-id',
        'user-id',
        'ADMIN',
        'new pool config',
      ),
    /metadata write failed/,
  );

  assert.deepEqual(poolConfigs, ['new pool config', 'old pool config']);
  assert.equal(updates.at(-1).data.phpPoolCustom, 'old pool config');
  assert.equal(
    operations.calls.find(([name]) => name === 'begin')[1].lockSite,
    false,
  );
});
