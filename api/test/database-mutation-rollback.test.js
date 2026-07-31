'use strict';

require('reflect-metadata');

process.env.MEOWBOX_MASTER_KEY =
  process.env.MEOWBOX_MASTER_KEY || Buffer.alloc(32, 7).toString('base64');

const assert = require('node:assert/strict');
const test = require('node:test');

const { encryptJson } = require('../src/common/crypto/credentials-cipher');
const { DatabasesService } = require('../src/databases/databases.service');

function databaseFixture() {
  return {
    id: 'database-id',
    name: 'example_db',
    type: 'MARIADB',
    dbUser: 'example_user',
    dbPasswordEnc: encryptJson({ password: 'rollback-password' }),
    purpose: 'AUXILIARY',
    siteId: 'site-id',
    siteDomainId: 'domain-id',
    site: {
      id: 'site-id',
      name: 'example',
      userId: 'user-id',
    },
    siteDomain: {
      id: 'domain-id',
      siteId: 'site-id',
      domain: 'example.test',
      preset: 'CUSTOM',
    },
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
    succeed: async (...args) => log.push(['succeed', ...args]),
    fail: async (...args) => log.push(['fail', ...args]),
  };
}

test('database deletion fails closed when physical drop is rejected', async () => {
  const db = databaseFixture();
  const log = [];
  let metadataDeletes = 0;
  const prisma = {
    database: {
      findUnique: async () => db,
      delete: async () => {
        metadataDeletes += 1;
      },
    },
  };
  const events = [];
  const service = new DatabasesService(
    prisma,
    {
      isAgentConnected: () => true,
      emitToAgent: async (event) => {
        events.push(event);
        if (event === 'db:export') {
          return { success: true, data: { filePath: '/tmp/snapshot.sql' } };
        }
        return { success: false, error: 'drop rejected' };
      },
    },
    {},
    operations(log),
  );

  await assert.rejects(
    () =>
      service.delete(
        'site-id',
        'domain-id',
        'database-id',
        'user-id',
        'ADMIN',
      ),
    /drop rejected/,
  );
  assert.deepEqual(events, ['db:export', 'db:drop']);
  assert.equal(metadataDeletes, 0);
  assert.ok(log.some(([event]) => event === 'fail'));
});

test('database deletion recreates content when metadata commit fails', async () => {
  const db = databaseFixture();
  const log = [];
  const events = [];
  const prisma = {
    database: {
      findUnique: async () => db,
    },
    $transaction: async (callback) =>
      callback({
        database: {
          delete: async () => {
            throw new Error('metadata commit failed');
          },
        },
        operation: { updateMany: async () => ({ count: 1 }) },
        operationLock: { deleteMany: async () => ({ count: 1 }) },
      }),
  };
  const service = new DatabasesService(
    prisma,
    {
      isAgentConnected: () => true,
      emitToAgent: async (event) => {
        events.push(event);
        if (event === 'db:export') {
          return { success: true, data: { filePath: '/tmp/snapshot.sql' } };
        }
        return { success: true };
      },
    },
    {},
    operations(log),
  );

  await assert.rejects(
    () =>
      service.delete(
        'site-id',
        'domain-id',
        'database-id',
        'user-id',
        'ADMIN',
      ),
    /metadata commit failed/,
  );
  assert.deepEqual(events, ['db:export', 'db:drop', 'db:create', 'db:import']);
  assert.ok(log.some(([event]) => event === 'fail'));
});

test('failed database import restores the pre-import snapshot', async () => {
  const db = databaseFixture();
  const log = [];
  const importPaths = [];
  const service = new DatabasesService(
    {
      database: { findUnique: async () => db },
    },
    {
      isAgentConnected: () => true,
      emitToAgent: async (event, payload) => {
        if (event === 'db:export') {
          return { success: true, data: { filePath: '/tmp/before.sql' } };
        }
        if (event === 'db:import') {
          importPaths.push(payload.filePath);
          return importPaths.length === 1
            ? { success: false, error: 'bad dump' }
            : { success: true };
        }
        throw new Error(`Unexpected event ${event}`);
      },
    },
    {},
    operations(log),
  );

  await assert.rejects(
    () =>
      service.importDatabase(
        'site-id',
        'domain-id',
        'database-id',
        'user-id',
        'ADMIN',
        '/tmp/requested.sql',
      ),
    /bad dump/,
  );
  assert.deepEqual(importPaths, ['/tmp/requested.sql', '/tmp/before.sql']);
  assert.ok(log.some(([event]) => event === 'fail'));
});
