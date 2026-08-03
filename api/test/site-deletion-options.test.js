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

const cleanupFlags = {
  removeSslCertificate: false,
  removeBackupsLocal: true,
  removeBackupsRestic: false,
  removeBackupsRemote: true,
  removeDatabases: false,
  removeFiles: true,
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
  const deletedMetadata = [];
  let operationRequest = null;
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
  };
  prisma.$transaction = async (callback) => callback(prisma);

  const agentRelay = {
    isAgentConnected: () => true,
    emitToAgent: async (event, payload) => {
      events.push([event, payload]);
      if (event === 'application:snapshot') {
        return { success: true, data: { snapshotPath: '/snapshot/demo' } };
      }
      return { success: true };
    },
    onAgentConnect: () => undefined,
  };
  const operations = {
    begin: async ({ request }) => {
      operationRequest = request;
      return { id: 'operation-1', replayed: false };
    },
    start: async () => undefined,
    step: async () => undefined,
    succeed: async () => undefined,
    fail: async () => undefined,
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
    operations,
    {},
    backupsService,
  );

  await service.delete(
    site.id,
    site.userId,
    'ADMIN',
    {
      confirmSiteName: site.name,
      confirmDataDeletion: true,
      ...cleanupFlags,
    },
    'site-delete-test',
  );

  assert.deepEqual(backupOptions, {
    removeLocal: true,
    removeRestic: false,
    removeRemote: true,
    strict: true,
  });
  assert.deepEqual(operationRequest, {
    confirmSiteName: site.name,
    confirmDataDeletion: true,
    ...cleanupFlags,
  });
  assert.deepEqual(
    events.map(([event]) => event),
    ['application:snapshot', 'site:remove-files'],
  );
  assert.deepEqual(deletedMetadata, [
    ['databases', site.id],
    ['site', site.id],
  ]);
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
