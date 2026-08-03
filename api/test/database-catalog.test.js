'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');

const { DatabasesService } = require('../src/databases/databases.service');

test('database catalog lists only databases visible to the current user', async () => {
  const calls = [];
  const prisma = {
    database: {
      findMany: async (query) => {
        calls.push(['findMany', query]);
        return [];
      },
      count: async (query) => {
        calls.push(['count', query]);
        return 0;
      },
    },
  };
  const service = new DatabasesService(prisma, {}, {}, {});

  const result = await service.findAllAcrossSites({
    userId: 'user-1',
    role: 'MANAGER',
    type: 'MARIADB,MYSQL',
    search: 'demo',
    page: 2,
    perPage: 500,
  });

  assert.deepEqual(calls[0][1].where, {
    site: { userId: 'user-1' },
    type: { in: ['MARIADB', 'MYSQL'] },
    name: { contains: 'demo' },
  });
  assert.deepEqual(calls[1][1].where, calls[0][1].where);
  assert.equal(calls[0][1].take, 100);
  assert.equal(calls[0][1].skip, 100);
  assert.deepEqual(calls[0][1].include.siteDomain.select, {
    id: true,
    domain: true,
    preset: true,
  });
  assert.deepEqual(result.meta, {
    page: 2,
    perPage: 100,
    total: 0,
    totalPages: 0,
  });
});

test('database catalog does not apply an owner filter for admins', async () => {
  let where;
  const prisma = {
    database: {
      findMany: async (query) => {
        where = query.where;
        return [];
      },
      count: async () => 0,
    },
  };
  const service = new DatabasesService(prisma, {}, {}, {});

  await service.findAllAcrossSites({
    userId: 'admin-1',
    role: 'ADMIN',
  });

  assert.deepEqual(where, {});
});
