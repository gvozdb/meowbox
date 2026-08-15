'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const databaseCipher = require('../src/common/crypto/database-cipher');

databaseCipher.decryptDbPassword = () => 'rollback-password';

const { SiteDomainsService } = require('../src/sites/site-domains.service');

function operations(log) {
  return {
    begin: async (input) => {
      log.push(['operation.begin', input]);
      return {
        id: 'operation-id',
        replayed: false,
        status: 'PENDING',
        result: null,
      };
    },
    start: async (id, step) => log.push(['operation.start', { id, step }]),
    step: async (id, step, progress) =>
      log.push(['operation.step', { id, step, progress }]),
    succeed: async (id, result) =>
      log.push(['operation.succeed', { id, result }]),
    fail: async (id, error) =>
      log.push(['operation.fail', { id, message: error.message }]),
  };
}

function domain(overrides = {}) {
  return {
    id: 'domain-secondary',
    siteId: 'site-id',
    domain: 'app.example.test',
    aliases: '[]',
    isPrimary: false,
    position: 1,
    runtimeKey: 'domain-secondary',
    preset: 'CUSTOM',
    appStatus: 'ACTIVE',
    appErrorMessage: null,
    filesRelPath: 'apps/app',
    phpVersion: '8.2',
    phpPoolCustom: null,
    gitRepository: null,
    deployBranch: 'main',
    envVars: '{}',
    httpsRedirect: true,
    sslCertificate: null,
    databases: [],
    ...overrides,
  };
}

function site(domains) {
  return {
    id: 'site-id',
    userId: 'user-id',
    name: 'site-name',
    status: 'ACTIVE',
    systemUser: 'site-user',
    rootPath: '/var/www/site-name',
    domains,
  };
}

test('make-primary restores exact ordering when runtime regeneration fails', async () => {
  const log = [];
  const primary = domain({
    id: 'domain-primary',
    domain: 'primary.example.test',
    isPrimary: true,
    position: 0,
    filesRelPath: 'www',
  });
  const target = domain();
  const transactions = [];
  const prisma = {
    site: { findUnique: async () => site([primary, target]) },
    $transaction: async (callback) => {
      const writes = [];
      transactions.push(writes);
      return callback({
        siteDomain: {
          update: async (query) => writes.push(query),
        },
      });
    },
  };
  const service = new SiteDomainsService(
    prisma,
    { isAgentConnected: () => true },
    operations(log),
  );
  service.syncPrimaryPhpCliShim = async () => undefined;
  service.regenerateGlobalZones = async () => undefined;
  let nginxAttempts = 0;
  service.regenerateNginx = async () => {
    nginxAttempts += 1;
    if (nginxAttempts === 1) throw new Error('nginx test failed');
  };

  await assert.rejects(
    service.makePrimary('site-id', target.id, 'user-id', 'ADMIN'),
    /nginx test failed/,
  );

  assert.equal(transactions.length, 2);
  assert.deepEqual(
    transactions[0].slice(-2).map(({ where, data }) => ({
      id: where.id,
      ...data,
    })),
    [
      { id: target.id, isPrimary: true, position: 0 },
      { id: primary.id, isPrimary: false, position: 1 },
    ],
  );
  assert.deepEqual(
    transactions[1].slice(-2).map(({ where, data }) => ({
      id: where.id,
      ...data,
    })),
    [
      { id: primary.id, isPrimary: true, position: 0 },
      { id: target.id, isPrimary: false, position: 1 },
    ],
  );
  assert.equal(nginxAttempts, 2);
  assert.ok(log.some(([event]) => event === 'operation.fail'));
});

test('alias update restores old aliases when nginx rejects new config', async () => {
  const log = [];
  const target = domain({
    aliases: '[{"domain":"old.example.test","redirect":false}]',
  });
  const writes = [];
  const prisma = {
    site: { findUnique: async () => site([target]) },
    siteDomain: {
      update: async (query) => writes.push(query),
    },
    hostnameClaim: {
      deleteMany: async () => ({ count: 1 }),
      createMany: async () => ({ count: 2 }),
    },
  };
  prisma.$transaction = async (callback) => callback(prisma);
  const service = new SiteDomainsService(
    prisma,
    { isAgentConnected: () => true },
    operations(log),
  );
  service.assertDomainFree = async () => undefined;
  service.ensureDomainFreeInNginx = async () => undefined;
  service.syncPrimaryPhpCliShim = async () => undefined;
  service.regenerateGlobalZones = async () => undefined;
  let nginxAttempts = 0;
  service.regenerateNginx = async () => {
    nginxAttempts += 1;
    if (nginxAttempts === 1) throw new Error('nginx test failed');
  };

  await assert.rejects(
    service.updateAliases(
      'site-id',
      target.id,
      { aliases: [{ domain: 'new.example.test', redirect: true }] },
      'user-id',
      'ADMIN',
    ),
    /nginx test failed/,
  );

  assert.equal(writes.length, 2);
  assert.equal(
    writes[0].data.aliases,
    '[{"domain":"new.example.test","redirect":true}]',
  );
  assert.equal(writes[1].data.aliases, target.aliases);
  assert.equal(nginxAttempts, 2);
  assert.ok(log.some(([event]) => event === 'operation.fail'));
});

test('domain runtime update restores metadata and PHP pool on nginx failure', async () => {
  const log = [];
  const target = domain();
  const writes = [];
  const agentEvents = [];
  const prisma = {
    site: { findUnique: async () => site([target]) },
    siteDomain: {
      update: async (query) => writes.push(query),
    },
    sslCertificate: {
      updateMany: async () => ({ count: 0 }),
    },
    hostnameClaim: {
      deleteMany: async () => ({ count: 0 }),
      createMany: async () => ({ count: 1 }),
    },
  };
  prisma.$transaction = async (callback) => callback(prisma);
  const service = new SiteDomainsService(
    prisma,
    {
      isAgentConnected: () => true,
      emitToAgent: async (event, payload) => {
        agentEvents.push([event, payload]);
        return { success: true };
      },
    },
    operations(log),
  );
  service.syncPrimaryPhpCliShim = async () => undefined;
  service.regenerateGlobalZones = async () => undefined;
  let nginxAttempts = 0;
  service.regenerateNginx = async () => {
    nginxAttempts += 1;
    if (nginxAttempts === 1) throw new Error('nginx test failed');
  };

  await assert.rejects(
    service.updateDomain(
      'site-id',
      target.id,
      { phpVersion: '8.3', filesRelPath: 'apps/new-app' },
      'user-id',
      'ADMIN',
    ),
    /nginx test failed/,
  );

  assert.equal(writes.length, 2);
  assert.equal(writes[0].data.phpVersion, '8.3');
  assert.equal(writes[1].data.phpVersion, '8.2');
  assert.equal(writes[1].data.filesRelPath, target.filesRelPath);
  assert.deepEqual(
    agentEvents.map(([event]) => event),
    ['php:create-pool', 'php:create-pool', 'php:remove-pool'],
  );
  assert.equal(nginxAttempts, 2);
  assert.ok(log.some(([event]) => event === 'operation.fail'));
});

test('installer preflight race never trashes a root it did not mutate', async () => {
  const log = [];
  const target = domain({ phpVersion: null });
  const agentEvents = [];
  const service = new SiteDomainsService(
    {
      siteDomain: {
        findFirst: async () => ({
          ...target,
          site: site([target]),
          databases: [],
        }),
      },
    },
    {
      isAgentConnected: () => true,
      emitToAgent: async (event, payload) => {
        agentEvents.push([event, payload]);
        if (event === 'application:preflight-create-root') {
          return { success: true, data: { exists: false } };
        }
        if (event === 'site:install') {
          return {
            success: false,
            error: 'Application root preflight failed: root is no longer empty',
            data: { mutationStarted: false },
          };
        }
        return { success: true };
      },
    },
    operations(log),
  );
  service.regenerateNginx = async () => undefined;

  await assert.rejects(
    () =>
      service.provisionDomainApplication(
        'site-id',
        target.id,
        undefined,
        'operation-id',
      ),
    /root preflight failed/i,
  );

  assert.equal(
    agentEvents.some(([event]) => event === 'application:delete-files'),
    false,
  );
});

test('shared application roots are reused without reinstalling files', async () => {
  const log = [];
  const existing = domain({
    id: 'domain-existing',
    domain: 'www.example.test',
    isPrimary: true,
    position: 0,
    filesRelPath: 'apps/monorepo',
    phpVersion: null,
  });
  const target = domain({
    filesRelPath: 'apps/monorepo',
    phpVersion: null,
  });
  const agentEvents = [];
  const statusWrites = [];
  const service = new SiteDomainsService(
    {
      siteDomain: {
        findFirst: async () => ({
          ...target,
          site: site([existing, target]),
          databases: [],
        }),
        update: async (query) => statusWrites.push(query),
      },
    },
    {
      isAgentConnected: () => true,
      emitToAgent: async (event, payload) => {
        agentEvents.push([event, payload]);
        if (event === 'application:preflight-create-root') {
          return {
            success: true,
            data: { exists: true, isNonEmpty: true },
          };
        }
        if (event === 'site:install') {
          return { success: true, data: { mutationStarted: false } };
        }
        if (event === 'site:health-check') {
          return {
            success: true,
            data: { reachable: true, statusCode: 200 },
          };
        }
        return { success: true };
      },
    },
    operations(log),
  );
  service.regenerateNginx = async () => undefined;

  await service.provisionDomainApplication(
    'site-id',
    target.id,
    undefined,
    'operation-id',
  );

  const preflight = agentEvents.find(
    ([event]) => event === 'application:preflight-create-root',
  );
  const install = agentEvents.find(([event]) => event === 'site:install');
  assert.equal(preflight[1].allowExistingRoot, true);
  assert.equal(install[1].reuseExistingRoot, true);
  assert.equal(
    agentEvents.some(([event]) => event === 'application:delete-files'),
    false,
  );
  assert.deepEqual(statusWrites.at(-1).data, {
    appStatus: 'RUNNING',
    appErrorMessage: null,
  });
});

test('destructive deletion restores databases, files, pool and route before commit', async () => {
  const log = [];
  const primary = domain({
    id: 'domain-primary',
    domain: 'primary.example.test',
    isPrimary: true,
    position: 0,
    filesRelPath: 'www',
  });
  const target = domain({
    databases: [
      {
        id: 'database-id',
        name: 'app_database',
        type: 'MARIADB',
        dbUser: 'app_user',
        dbPasswordEnc: 'encrypted',
      },
    ],
  });
  const agentEvents = [];
  const statusWrites = [];
  const service = new SiteDomainsService(
    {
      site: { findUnique: async () => site([primary, target]) },
      backup: { findFirst: async () => null },
      siteDomain: {
        update: async (query) => statusWrites.push(query),
        updateMany: async (query) => statusWrites.push(query),
      },
    },
    {
      isAgentConnected: () => true,
      emitToAgent: async (event, payload) => {
        agentEvents.push([event, payload]);
        if (event === 'application:snapshot') {
          return {
            success: true,
            data: { snapshotPath: '/var/meowbox/backups/app-snapshot' },
          };
        }
        if (event === 'application:delete-files') {
          return {
            success: true,
            data: { trashPath: '/var/www/site-name/.meowbox-trash/app' },
          };
        }
        return { success: true };
      },
    },
    operations(log),
  );
  const nginxCalls = [];
  service.regenerateNginx = async (_siteId, options = {}) => {
    nginxCalls.push(options);
  };
  service.regenerateGlobalZones = async () => undefined;
  service.commitDomainDeletionMetadata = async () => {
    throw new Error('metadata commit failed');
  };

  await assert.rejects(
    service.deleteDomain(
      'site-id',
      target.id,
      {
        confirmDomain: target.domain,
        deleteApplicationFiles: true,
        deleteOwnedDatabases: true,
      },
      'user-id',
      'ADMIN',
      'domain-delete-test-key',
    ),
    /metadata commit failed/,
  );

  assert.deepEqual(
    agentEvents.map(([event]) => event),
    [
      'application:snapshot',
      'php:remove-pool',
      'db:drop',
      'application:delete-files',
      'db:create',
      'application:restore-snapshot',
      'php:create-pool',
    ],
  );
  assert.deepEqual(nginxCalls, [
    { excludeSiteDomainId: target.id },
    {},
  ]);
  assert.equal(statusWrites.at(-1).data.appStatus, target.appStatus);
  assert.ok(log.some(([event]) => event === 'operation.fail'));
});
