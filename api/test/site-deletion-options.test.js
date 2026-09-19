'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const { plainToInstance } = require('class-transformer');
const { validate } = require('class-validator');

const {
  BackupArtifactCleanupService,
} = require('../src/backups/backup-artifact-cleanup.service');
const { DeleteSiteOptionsDto } = require('../src/sites/sites.dto');
const { SitesService } = require('../src/sites/sites.service');
const {
  OperationFailedError,
} = require('../src/operations/operation-errors');

const cleanupFlags = {
  removeSslCertificate: false,
  removeBackupsLocal: true,
  removeBackupsRestic: false,
  removeBackupsRemote: true,
  removeDatabases: false,
  removeFiles: true,
  removeMinioData: false,
  removeSystemUser: false,
  removeNginxConfig: false,
  removePhpPool: false,
};

test('site deletion DTO fails closed unless every artifact choice is explicit', async () => {
  const incomplete = plainToInstance(DeleteSiteOptionsDto, {
    confirmSiteName: 'demo',
    confirmDataDeletion: true,
  });
  const incompleteErrors = await validate(incomplete);
  assert.ok(incompleteErrors.length >= Object.keys(cleanupFlags).length);

  const complete = plainToInstance(DeleteSiteOptionsDto, {
    confirmSiteName: 'demo',
    confirmDataDeletion: true,
    ...cleanupFlags,
  });
  assert.deepEqual(await validate(complete), []);
});

test('site deletion executes only selected runtime artifacts', async () => {
  const events = [];
  const jobs = [];
  const deletedMetadata = [];
  let backupOptions = null;
  const site = {
    id: 'site-1',
    userId: 'user-1',
    name: 'demo',
    rootPath: '/var/www/demo',
    systemUser: 'demo',
    domains: [
      {
        id: 'domain-1',
        domain: 'demo.test',
        position: 0,
        appStatus: 'RUNNING',
        appErrorMessage: null,
        filesRelPath: '.',
        runtimeKey: 'runtime-1',
        phpVersion: '8.3',
        sslCertificate: { status: 'ACTIVE' },
        databases: [
          {
            id: 'database-1',
            name: 'demo_db',
            type: 'MARIADB',
            dbUser: 'demo_db',
          },
        ],
      },
    ],
  };
  const prisma = {
    site: {
      findUnique: async () => site,
      delete: async ({ where }) => deletedMetadata.push(['site', where.id]),
    },
    siteDomain: {
      updateMany: async () => ({ count: 1 }),
      findMany: async () => [],
    },
    database: {
      deleteMany: async ({ where }) => {
        deletedMetadata.push(['databases', where.siteId]);
        return { count: 1 };
      },
    },
    siteService: {
      findUnique: async () => {
        throw new Error('MinIO cleanup must not run when removeMinioData is false');
      },
    },
  };
  prisma.$transaction = async (callback) => callback(prisma);

  const agentRelay = {
    isAgentConnected: () => true,
    runAgentJob: async (input) => {
      jobs.push(input);
      if (input.actionId === 'agent.application.snapshot') {
        return { snapshotPath: '/snapshot/demo' };
      }
      return { removed: 1 };
    },
    emitToAgent: async (event, payload) => {
      events.push([event, payload]);
      return { success: true };
    },
    onAgentConnect: () => undefined,
  };
  const backupsService = {
    cleanupSiteBackupArtifacts: async (_siteId, _siteName, options) => {
      backupOptions = options;
      return { backups: 3, removedRecords: 2 };
    },
  };
  const service = new SitesService(
    prisma,
    agentRelay,
    {},
    {},
    {},
    {},
    {},
    {},
    backupsService,
  );

  const operationId = '10000000-0000-4000-8000-000000000001';
  await service.executeDelete(
    site.id,
    {
      confirmSiteName: site.name,
      confirmDataDeletion: true,
      ...cleanupFlags,
    },
    {
      operationId,
      attempt: 1,
      recovering: false,
      deadlineAt: new Date(Date.now() + 60_000),
      actor: { kind: 'OPERATOR', userId: site.userId, role: 'ADMIN' },
      heartbeat: async () => undefined,
      isCancellationRequested: async () => false,
      throwIfCancellationRequested: async () => undefined,
    },
  );

  assert.deepEqual(backupOptions, {
    removeLocal: true,
    removeRestic: false,
    removeRemote: true,
    strict: true,
  });
  assert.deepEqual(
    events.map(([event]) => event),
    ['site:remove-files'],
  );
  assert.deepEqual(
    jobs.map(({ actionId }) => actionId),
    [
      'agent.application.snapshot',
      'agent.application.cleanup_operation_snapshots',
    ],
  );
  assert.deepEqual(deletedMetadata, [
    ['databases', site.id],
    ['site', site.id],
  ]);
});

test('site deletion restores domain status and cleans snapshots when snapshot creation fails', async () => {
  const operationId = '60000000-0000-4000-8000-000000000006';
  const updates = [];
  const jobs = [];
  const site = {
    id: 'site-1',
    userId: 'user-1',
    name: 'demo',
    rootPath: '/var/www/demo',
    systemUser: 'demo',
    domains: [
      {
        id: 'domain-1',
        domain: 'demo.test',
        position: 0,
        appStatus: 'RUNNING',
        appErrorMessage: 'previous warning',
        filesRelPath: 'www',
        runtimeKey: 'runtime-1',
        phpVersion: null,
        sslCertificate: null,
        databases: [],
      },
    ],
  };
  const service = new SitesService(
    {
      site: { findUnique: async () => site },
      siteDomain: {
        updateMany: async (input) => {
          updates.push(input);
          return { count: 1 };
        },
      },
    },
    {
      isAgentConnected: () => true,
      runAgentJob: async (input) => {
        jobs.push(input);
        if (input.actionId === 'agent.application.snapshot') {
          throw new Error('tar failed');
        }
        return { removed: 1 };
      },
    },
    {},
    {},
    {},
    {},
    {},
    {},
    {
      cleanupSiteBackupArtifacts: async () => {
        throw new Error('destructive cleanup must not start');
      },
    },
  );

  await assert.rejects(
    () => service.executeDelete(
      site.id,
      {
        confirmSiteName: site.name,
        confirmDataDeletion: true,
        ...Object.fromEntries(
          Object.keys(cleanupFlags).map((key) => [key, false]),
        ),
      },
      {
        operationId,
        attempt: 1,
        recovering: false,
        deadlineAt: new Date(Date.now() + 60_000),
        actor: { kind: 'OPERATOR', userId: site.userId, role: 'ADMIN' },
        heartbeat: async () => undefined,
        isCancellationRequested: async () => false,
        throwIfCancellationRequested: async () => undefined,
      },
    ),
    OperationFailedError,
  );

  assert.deepEqual(
    jobs.map(({ actionId }) => actionId),
    [
      'agent.application.snapshot',
      'agent.application.cleanup_operation_snapshots',
    ],
  );
  assert.deepEqual(updates, [
    {
      where: { siteId: site.id },
      data: { appStatus: 'UPDATING', appErrorMessage: null },
    },
    {
      where: { id: 'domain-1', siteId: site.id },
      data: {
        appStatus: 'RUNNING',
        appErrorMessage: 'previous warning',
      },
    },
  ]);
});

test('MinIO tenant cleanup is called only by an explicit removal choice', async () => {
  const events = [];
  const prisma = {
    siteService: {
      findUnique: async () => ({ id: 'minio-site-service' }),
    },
  };
  const agentRelay = {
    emitToAgent: async (event, payload) => {
      events.push([event, payload]);
      return { success: true };
    },
  };
  const service = new SitesService(
    prisma,
    agentRelay,
    {},
    {},
    {},
    {},
    {},
    {},
    {},
  );

  await service.cleanupMinioTenantBeforeSiteRemoval({
    id: 'site-1',
    name: 'demo',
    rootPath: '/var/www/demo',
  });

  assert.deepEqual(events, [[
    'minio:site-disable',
    { siteId: 'site-1', siteName: 'demo', rootPath: '/var/www/demo' },
  ]]);
});

test('backup cleanup removes selected artifact classes and preserves unchecked Restic', async () => {
  const events = [];
  const deletedRecords = [];
  const cleanedExports = [];
  const backups = [
    {
      id: 'local-1',
      engine: 'TAR',
      filePath: '/var/backups/local-1.tar.gz',
      storageType: 'LOCAL',
      resticSnapshotId: null,
      storageLocationId: null,
      storageLocation: null,
      config: null,
    },
    {
      id: 'restic-1',
      engine: 'RESTIC',
      filePath: '',
      storageType: null,
      resticSnapshotId: 'abcdef1234',
      storageLocationId: 'storage-restic',
      storageLocation: { id: 'storage-restic', type: 'S3' },
      config: null,
    },
    {
      id: 'remote-1',
      engine: 'TAR',
      filePath: 'yandex-disk:/demo/remote-1.tar.gz',
      storageType: 'YANDEX_DISK',
      resticSnapshotId: null,
      storageLocationId: 'storage-remote',
      storageLocation: { id: 'storage-remote', type: 'YANDEX_DISK' },
      config: null,
    },
  ];
  const prisma = {
    backup: {
      findMany: async () => backups,
      delete: async ({ where }) => deletedRecords.push(where.id),
    },
  };
  const agentRelay = {
    isAgentConnected: () => true,
    emitToAgent: async (event, payload) => {
      events.push([event, payload]);
      return { success: true };
    },
  };
  const storageLocations = {
    getFullConfigForAgent: async (id) => ({
      id,
      name: id,
      type: id === 'storage-restic' ? 'S3' : 'YANDEX_DISK',
      config: id === 'storage-restic' ? { bucket: 'backups' } : { oauthToken: 'test' },
      resticPassword: id === 'storage-restic' ? 'password' : null,
    }),
  };
  const backupExports = {
    cleanupArtifactsForBackups: async (ids) => cleanedExports.push(...ids),
  };
  const service = new BackupArtifactCleanupService(
    prisma,
    agentRelay,
    storageLocations,
    backupExports,
  );

  const result = await service.cleanupSiteBackupArtifacts('site-1', 'demo', {
    removeLocal: true,
    removeRestic: false,
    removeRemote: true,
    strict: true,
  });

  assert.deepEqual(
    events.map(([event]) => event),
    ['backup:delete-file', 'backup:delete-remote'],
  );
  assert.deepEqual(cleanedExports, ['local-1', 'restic-1', 'remote-1']);
  assert.deepEqual(deletedRecords, ['local-1', 'remote-1']);
  assert.deepEqual(result, { backups: 3, removedRecords: 2 });
});
