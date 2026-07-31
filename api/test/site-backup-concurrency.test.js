'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');

const { BackupsService } = require('../src/backups/backups.service');

function serviceWithState(overrides = {}) {
  const created = [];
  let operationWhere = null;
  const prisma = {
    operation: {
      findFirst: async ({ where }) => {
        operationWhere = where;
        return overrides.activeOperation || null;
      },
    },
    backup: {
      updateMany: async () => ({ count: 0 }),
      findFirst: async () => overrides.activeBackup || null,
      createMany: async ({ data }) => {
        created.push(...data);
        return { count: data.length };
      },
    },
  };
  prisma.$transaction = overrides.transactionError
    ? async () => {
        throw overrides.transactionError;
      }
    : async (callback) => callback(prisma);

  return {
    created,
    operationWhere: () => operationWhere,
    service: new BackupsService(
      prisma,
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {},
    ),
  };
}

function prepared(id) {
  return {
    id,
    data: {
      id,
      siteId: 'site-1',
      type: 'FULL',
      status: 'PENDING',
      engine: 'TAR',
      storageType: 'LOCAL',
    },
  };
}

test('all backup destinations are reserved in one transaction', async () => {
  const { service, created } = serviceWithState();

  await service.reserveSiteBackupRows('site-1', [
    prepared('backup-1'),
    prepared('backup-2'),
  ]);

  assert.deepEqual(
    created.map(({ id }) => id),
    ['backup-1', 'backup-2'],
  );
});

test('active Site operation blocks backup reservation', async () => {
  const { service, created, operationWhere } = serviceWithState({
    activeOperation: {
      id: 'operation-1',
      type: 'MODX_UPDATE',
      status: 'RUNNING',
      currentStep: 'install',
    },
  });

  await assert.rejects(
    () => service.reserveSiteBackupRows('site-1', [prepared('backup-1')]),
    /Site operation is active/,
  );
  assert.equal(created.length, 0);
  assert.deepEqual(operationWhere().OR, [
    { siteId: 'site-1' },
    {
      locks: {
        some: { resourceKey: 'site:site-1' },
      },
    },
  ]);
});

test('active Site backup blocks another reservation', async () => {
  const { service, created } = serviceWithState({
    activeBackup: { id: 'backup-active', status: 'IN_PROGRESS' },
  });

  await assert.rejects(
    () => service.reserveSiteBackupRows('site-1', [prepared('backup-1')]),
    /A backup is already in progress/,
  );
  assert.equal(created.length, 0);
});

test('backup transaction contention fails closed', async () => {
  const { service } = serviceWithState({
    transactionError: Object.assign(new Error('write conflict'), {
      code: 'P2034',
    }),
  });

  await assert.rejects(
    () => service.reserveSiteBackupRows('site-1', [prepared('backup-1')]),
    /Site backup scope is busy/,
  );
});
