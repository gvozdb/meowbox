'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');

const { OperationsService } = require('../src/operations/operations.service');

function operationStore() {
  const operations = new Map();
  const locks = new Map();
  let activeBackup = null;
  let sequence = 0;

  const matchesStatus = (operation, where) => {
    if (!where?.status) return true;
    if (typeof where.status === 'string') return operation.status === where.status;
    return where.status.in.includes(operation.status);
  };
  const prisma = {
    operation: {
      findUnique: async ({ where }) => {
        if (where.id) return operations.get(where.id) || null;
        return (
          [...operations.values()].find(
            (operation) => operation.idempotencyKey === where.idempotencyKey,
          ) || null
        );
      },
      findFirst: async ({ where, select }) => {
        const operation = [...operations.values()].find(
          (candidate) =>
            (!where.id || candidate.id === where.id) &&
            (!where.parentOperationId ||
              candidate.parentOperationId === where.parentOperationId) &&
            matchesStatus(candidate, where),
        );
        if (!operation) return null;
        if (!select?.locks) return operation;
        const requested = new Set(select.locks.where.resourceKey.in);
        return {
          id: operation.id,
          locks: [...locks.values()].filter(
            (lock) =>
              lock.operationId === operation.id &&
              requested.has(lock.resourceKey),
          ),
        };
      },
      findMany: async ({ where }) =>
        [...operations.values()]
          .filter(
            (candidate) =>
              (!where.parentOperationId ||
                candidate.parentOperationId === where.parentOperationId) &&
              matchesStatus(candidate, where),
          )
          .map(({ id }) => ({ id })),
      create: async ({ data }) => {
        const id = `operation-${++sequence}`;
        const operation = {
          id,
          idempotencyKey: data.idempotencyKey,
          requestHash: data.requestHash,
          type: data.type,
          siteId: data.siteId,
          siteDomainId: data.siteDomainId,
          databaseId: data.databaseId,
          globalLockKey: data.globalLockKey,
          parentOperationId: data.parentOperationId,
          createdByUserId: data.createdByUserId,
          status: data.status,
          currentStep: null,
          result: null,
        };
        operations.set(id, operation);
        for (const lock of data.locks?.create || []) {
          assert.equal(locks.has(lock.resourceKey), false);
          locks.set(lock.resourceKey, { ...lock, operationId: id });
        }
        return operation;
      },
      updateMany: async ({ where, data }) => {
        const candidates =
          typeof where.id === 'string'
            ? [operations.get(where.id)].filter(Boolean)
            : where.id?.in
              ? where.id.in.map((id) => operations.get(id)).filter(Boolean)
              : [...operations.values()];
        let count = 0;
        for (const operation of candidates) {
          if (!matchesStatus(operation, where)) continue;
          Object.assign(operation, data);
          count += 1;
        }
        return { count };
      },
    },
    operationLock: {
      createMany: async ({ data }) => {
        for (const lock of data) {
          assert.equal(locks.has(lock.resourceKey), false);
          locks.set(lock.resourceKey, lock);
        }
        return { count: data.length };
      },
      deleteMany: async ({ where }) => {
        const operationIds = new Set(
          typeof where.operationId === 'string'
            ? [where.operationId]
            : where.operationId.in,
        );
        let count = 0;
        for (const [key, lock] of locks) {
          if (!operationIds.has(lock.operationId)) continue;
          locks.delete(key);
          count += 1;
        }
        return { count };
      },
      findUnique: async ({ where }) => {
        const lock = locks.get(where.resourceKey);
        if (!lock) return null;
        return {
          ...lock,
          operation: operations.get(lock.operationId),
        };
      },
      findFirst: async ({ where, select }) => {
        const lock = [...locks.values()].find((candidate) => {
          if (
            where.resourceKey?.in &&
            !where.resourceKey.in.includes(candidate.resourceKey)
          ) {
            return false;
          }
          if (where.kind?.in && !where.kind.in.includes(candidate.kind)) {
            return false;
          }
          if (
            where.operationId?.not &&
            candidate.operationId === where.operationId.not
          ) {
            return false;
          }
          const operation = operations.get(candidate.operationId);
          if (!operation) return false;
          if (
            where.operation?.siteId &&
            operation.siteId !== where.operation.siteId
          ) {
            return false;
          }
          return matchesStatus(operation, where.operation);
        });
        if (!lock) return null;
        if (select?.operation) {
          return { operation: operations.get(lock.operationId) };
        }
        return lock;
      },
    },
    backup: {
      findFirst: async ({ where }) => {
        if (!activeBackup || activeBackup.siteId !== where.siteId) return null;
        if (!where.status.in.includes(activeBackup.status)) return null;
        return activeBackup;
      },
    },
  };
  prisma.$transaction = async (callback) => callback(prisma);

  return {
    prisma,
    locks,
    operations,
    setActiveBackup: (backup) => {
      activeBackup = backup;
    },
  };
}

test('operation keeps source and attached target locks until success', async () => {
  const { prisma, locks } = operationStore();
  const service = new OperationsService(prisma);
  const request = {
    idempotencyKey: 'duplicate-lock-test-0001',
    type: 'DOMAIN_APPLICATION_DUPLICATE',
    siteId: 'source-site',
    siteDomainId: 'source-domain',
    globalLockKey: 'hostname-registry',
    userId: 'user-id',
    request: { source: 'source-domain' },
  };
  const operation = await service.begin(request);

  await service.start(operation.id, 'preflight');
  await service.attachScope(operation.id, {
    siteId: 'target-site',
    siteDomainId: 'target-domain',
  });

  assert.deepEqual(
    [...locks.keys()].sort(),
    [
      'domain:source-domain',
      'domain:target-domain',
      'global:hostname-registry',
      'site:source-site',
      'site:target-site',
    ],
  );
  const replay = await service.begin(request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.siteId, 'target-site');
  assert.equal(replay.siteDomainId, 'target-domain');

  await service.succeed(operation.id, { targetSiteId: 'target-site' });
  assert.equal(locks.size, 0);
});

test('domain child inherits parent Site lock without reacquiring it', async () => {
  const { prisma, locks } = operationStore();
  const service = new OperationsService(prisma);
  const parent = await service.begin({
    idempotencyKey: 'site-create-parent-0001',
    type: 'SITE_CREATE',
    siteId: 'target-site',
    userId: 'user-id',
    request: { name: 'target' },
  });
  await service.start(parent.id, 'provision');

  const child = await service.begin({
    idempotencyKey: 'site-create-child-0001',
    type: 'DOMAIN_PROVISION',
    siteId: 'target-site',
    siteDomainId: 'target-domain',
    parentOperationId: parent.id,
    userId: 'user-id',
    request: { domain: 'target.example.test' },
  });

  assert.equal(child.replayed, false);
  assert.deepEqual(
    [...locks.keys()].sort(),
    ['domain:target-domain', 'site:target-site'],
  );
  await assert.rejects(
    () => service.succeed(parent.id, { siteId: 'target-site' }),
    /Child operation is still active/,
  );
  await service.start(child.id, 'provision');
  await service.succeed(child.id, { siteDomainId: 'target-domain' });
  await service.succeed(parent.id, { siteId: 'target-site' });
  assert.equal(locks.size, 0);
});

test('scoped child requires its parent to own the same Site scope', async () => {
  const { prisma } = operationStore();
  const service = new OperationsService(prisma);
  const parent = await service.begin({
    idempotencyKey: 'unscoped-parent-test-0001',
    type: 'SITE_CREATE',
    userId: 'user-id',
    request: { name: 'target' },
  });
  await service.start(parent.id, 'reserve');

  await assert.rejects(
    () =>
      service.begin({
        idempotencyKey: 'unscoped-child-test-0001',
        type: 'DOMAIN_PROVISION',
        siteId: 'target-site',
        siteDomainId: 'target-domain',
        parentOperationId: parent.id,
        userId: 'user-id',
        request: { domain: 'target.example.test' },
      }),
    /Parent operation is not active or compatible/,
  );
});

test('failing a parent also fails active children and releases their locks', async () => {
  const { prisma, locks, operations } = operationStore();
  const service = new OperationsService(prisma);
  const parent = await service.begin({
    idempotencyKey: 'failed-parent-test-0001',
    type: 'SITE_CREATE',
    siteId: 'target-site',
    userId: 'user-id',
    request: { name: 'target' },
  });
  await service.start(parent.id, 'provision');
  const child = await service.begin({
    idempotencyKey: 'failed-child-test-0001',
    type: 'DOMAIN_PROVISION',
    siteId: 'target-site',
    siteDomainId: 'target-domain',
    parentOperationId: parent.id,
    userId: 'user-id',
    request: { domain: 'target.example.test' },
  });
  await service.start(child.id, 'provision');

  await service.fail(parent.id, new Error('container failed'));

  assert.equal(operations.get(parent.id).status, 'FAILED');
  assert.equal(operations.get(child.id).status, 'FAILED');
  assert.equal(locks.size, 0);
});

test('independent domain operations do not serialize the whole Site', async () => {
  const { prisma, locks } = operationStore();
  const service = new OperationsService(prisma);

  await service.begin({
    idempotencyKey: 'domain-only-lock-test-0001',
    type: 'MODX_UPDATE',
    siteId: 'shared-site',
    siteDomainId: 'domain-a',
    lockSite: false,
    userId: 'user-id',
    request: { version: '3.1.0-pl' },
  });
  await service.begin({
    idempotencyKey: 'domain-only-lock-test-0002',
    type: 'MODX_UPDATE',
    siteId: 'shared-site',
    siteDomainId: 'domain-b',
    lockSite: false,
    userId: 'user-id',
    request: { version: '3.1.0-pl' },
  });

  assert.deepEqual(
    [...locks.keys()].sort(),
    ['domain:domain-a', 'domain:domain-b'],
  );
});

test('Site-wide and independent domain operations block each other', async () => {
  {
    const { prisma } = operationStore();
    const service = new OperationsService(prisma);
    await service.begin({
      idempotencyKey: 'site-exclusive-lock-test-0001',
      type: 'SITE_DELETE',
      siteId: 'shared-site',
      userId: 'user-id',
      request: { siteId: 'shared-site' },
    });
    await assert.rejects(
      () =>
        service.begin({
          idempotencyKey: 'domain-after-site-lock-0001',
          type: 'MODX_UPDATE',
          siteId: 'shared-site',
          siteDomainId: 'domain-a',
          lockSite: false,
          userId: 'user-id',
          request: { version: '3.1.0-pl' },
        }),
      /Operation scope is locked/,
    );
  }

  {
    const { prisma } = operationStore();
    const service = new OperationsService(prisma);
    await service.begin({
      idempotencyKey: 'domain-before-site-lock-0001',
      type: 'MODX_UPDATE',
      siteId: 'shared-site',
      siteDomainId: 'domain-a',
      lockSite: false,
      userId: 'user-id',
      request: { version: '3.1.0-pl' },
    });
    await assert.rejects(
      () =>
        service.begin({
          idempotencyKey: 'site-after-domain-lock-0001',
          type: 'SITE_DELETE',
          siteId: 'shared-site',
          userId: 'user-id',
          request: { siteId: 'shared-site' },
        }),
      /Operation scope is locked/,
    );
  }
});

test('active Site backup blocks new Site and domain operations', async () => {
  const { prisma, setActiveBackup } = operationStore();
  const service = new OperationsService(prisma);
  setActiveBackup({
    id: 'backup-1',
    siteId: 'shared-site',
    status: 'IN_PROGRESS',
  });

  await assert.rejects(
    () =>
      service.begin({
        idempotencyKey: 'operation-during-backup-0001',
        type: 'MODX_UPDATE',
        siteId: 'shared-site',
        siteDomainId: 'domain-a',
        lockSite: false,
        userId: 'user-id',
        request: { version: '3.1.0-pl' },
      }),
    /Site backup is active/,
  );
});

test('active Site backup blocks attaching a newly created Site scope', async () => {
  const { prisma, setActiveBackup } = operationStore();
  const service = new OperationsService(prisma);
  const operation = await service.begin({
    idempotencyKey: 'attach-during-backup-0001',
    type: 'SITE_CREATE',
    userId: 'user-id',
    request: { name: 'target' },
  });
  await service.start(operation.id, 'reserve');
  setActiveBackup({
    id: 'backup-1',
    siteId: 'target-site',
    status: 'PENDING',
  });

  await assert.rejects(
    () =>
      service.attachScope(operation.id, {
        siteId: 'target-site',
      }),
    /Site backup is active/,
  );
});

test('created Site scope can be attached inside its creation transaction', async () => {
  const { prisma, locks, operations } = operationStore();
  const service = new OperationsService(prisma);
  const operation = await service.begin({
    idempotencyKey: 'atomic-created-site-0001',
    type: 'SITE_CREATE',
    userId: 'user-id',
    request: { name: 'target' },
  });
  await service.start(operation.id, 'reserve');

  await prisma.$transaction((tx) =>
    service.attachCreatedSiteScope(tx, operation.id, {
      siteId: 'target-site',
      siteDomainId: 'target-domain',
    }),
  );

  assert.equal(operations.get(operation.id).siteId, 'target-site');
  assert.equal(operations.get(operation.id).siteDomainId, 'target-domain');
  assert.deepEqual(
    [...locks.keys()].sort(),
    ['domain:target-domain', 'site:target-site'],
  );
});

test('transaction contention fails closed as an operation conflict', async () => {
  const prisma = {
    operation: {
      findUnique: async () => null,
    },
    $transaction: async () => {
      throw Object.assign(new Error('write conflict'), { code: 'P2034' });
    },
  };
  const service = new OperationsService(prisma);

  await assert.rejects(
    () =>
      service.begin({
        idempotencyKey: 'transaction-contention-0001',
        type: 'SITE_DELETE',
        siteId: 'shared-site',
        userId: 'user-id',
        request: { siteId: 'shared-site' },
      }),
    /Operation scope is busy/,
  );
  await assert.rejects(
    () =>
      service.attachScope('operation-1', {
        siteId: 'shared-site',
        siteDomainId: 'domain-a',
      }),
    /Operation scope is busy/,
  );
});

test('restart recovery requires attention and preserves conflicting locks', async () => {
  const calls = {};
  const prisma = {
    operation: {
      findMany: async () => [
        {
          id: 'operation-1',
          siteId: 'site-1',
          siteDomainId: 'domain-1',
        },
      ],
      updateMany: async (query) => {
        calls.operation = query;
        return { count: 1 };
      },
    },
    siteDomain: {
      updateMany: async (query) => {
        calls.siteDomain = query;
        return { count: 1 };
      },
    },
    site: {
      updateMany: async (query) => {
        calls.site = query;
        return { count: 1 };
      },
    },
    deployLog: {
      updateMany: async (query) => {
        calls.deployLog = query;
        return { count: 0 };
      },
    },
    operationLock: {
      deleteMany: async (query) => {
        calls.lock = query;
        return { count: 2 };
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };

  await new OperationsService(prisma).onModuleInit();

  assert.deepEqual(calls.site.where, {
    id: { in: ['site-1'] },
    status: 'DEPLOYING',
  });
  assert.equal(calls.site.data.status, 'ERROR');
  assert.match(calls.site.data.errorMessage, /API restart/);
  assert.deepEqual(calls.siteDomain.where.id, { in: ['domain-1'] });
  assert.equal(calls.siteDomain.data.appStatus, 'ERROR');
  assert.equal(calls.operation.data.status, 'NEEDS_ATTENTION');
  assert.equal(calls.operation.data.completedAt instanceof Date, true);
  assert.equal(calls.lock, undefined);
});
