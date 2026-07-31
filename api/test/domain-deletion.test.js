'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const { SiteDomainsService } = require('../src/sites/site-domains.service');

function serviceWithTransaction(log) {
  const tx = {
    database: {
      updateMany: async (query) => {
        log.push(['database.updateMany', query]);
      },
      deleteMany: async (query) => {
        log.push(['database.deleteMany', query]);
      },
    },
    siteDomain: {
      findMany: async (query) => {
        log.push(['siteDomain.findMany', query]);
        return [{ id: 'primary-domain', isPrimary: true }];
      },
      update: async (query) => {
        log.push(['siteDomain.update', query]);
      },
      delete: async (query) => {
        log.push(['siteDomain.delete', query]);
      },
    },
    operation: {
      updateMany: async (query) => {
        log.push(['operation.updateMany', query]);
        return { count: 1 };
      },
    },
    operationLock: {
      deleteMany: async (query) => {
        log.push(['operationLock.deleteMany', query]);
      },
    },
  };
  return new SiteDomainsService(
    {
      $transaction: async (callback) => callback(tx),
    },
    {},
    {},
  );
}

test('domain deletion preserves databases by reassigning them as auxiliary', async () => {
  const log = [];
  const service = serviceWithTransaction(log);

  await service.commitDomainDeletionMetadata(
    'site-id',
    'deleted-domain',
    'primary-domain',
    false,
    'operation-id',
    { deletedDomainId: 'deleted-domain' },
  );

  assert.deepEqual(log.slice(0, 2), [
    ['database.updateMany', {
      where: { siteDomainId: 'deleted-domain' },
      data: {
        siteDomainId: 'primary-domain',
        purpose: 'AUXILIARY',
      },
    }],
    ['siteDomain.delete', { where: { id: 'deleted-domain' } }],
  ]);
  const operationWrite = log.find(([event]) => event === 'operation.updateMany');
  assert.equal(operationWrite[1].data.status, 'SUCCEEDED');
  assert.equal(
    operationWrite[1].data.result,
    JSON.stringify({ deletedDomainId: 'deleted-domain' }),
  );
  assert.deepEqual(log.at(-1), [
    'operationLock.deleteMany',
    { where: { operationId: 'operation-id' } },
  ]);
});

test('explicit destructive domain deletion removes owned database metadata', async () => {
  const log = [];
  const service = serviceWithTransaction(log);

  await service.commitDomainDeletionMetadata(
    'site-id',
    'deleted-domain',
    'primary-domain',
    true,
    'operation-id',
    { deletedDomainId: 'deleted-domain' },
  );

  assert.deepEqual(log.slice(0, 2), [
    ['database.deleteMany', { where: { siteDomainId: 'deleted-domain' } }],
    ['siteDomain.delete', { where: { id: 'deleted-domain' } }],
  ]);
  assert.equal(
    log.some(([event]) => event === 'operation.updateMany'),
    true,
  );
  assert.deepEqual(log.at(-1), [
    'operationLock.deleteMany',
    { where: { operationId: 'operation-id' } },
  ]);
});
