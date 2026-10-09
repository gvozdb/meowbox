'use strict';
require('reflect-metadata');
const assert = require('node:assert/strict');
const test = require('node:test');
const { BackupsService } = require('../src/backups/backups.service');
const { BackupArtifactCleanupService } = require('../src/backups/backup-artifact-cleanup.service');

function fixture({ response = { success: true }, restic = false } = {}) {
  const events = [];
  const backup = {
    id: 'backup-1', site: { userId: 'owner', name: 'demo' },
    differentials: [{ id: 'diff-1' }], engine: restic ? 'RESTIC' : 'TAR',
    filePath: restic ? 'restic:abcdef' : 'yandex-disk:/backup.tar.gz',
    storageType: restic ? 'S3' : 'YANDEX_DISK',
    resticSnapshotId: restic ? 'abcdef' : null, storageLocationId: 'storage-1',
  };
  const prisma = {
    backup: {
      findUnique: async () => backup,
      updateMany: (args) => { events.push(['detach', args]); return { detach: args }; },
      delete: (args) => { events.push(['delete', args]); return { delete: args }; },
    },
    $transaction: async (writes) => { events.push(['transaction', writes]); },
  };
  const cleanup = new BackupArtifactCleanupService(prisma, {
    isAgentConnected: () => true,
    emitToAgent: async (name) => { events.push([name]); return response; },
  }, {
    getFullConfigForAgent: async () => ({ type: backup.storageType, config: {}, resticPassword: 'test-password' }),
  }, { cleanupArtifactsForBackup: async () => { events.push(['exports']); } });
  const service = new BackupsService(prisma, {}, {}, {}, {}, {}, cleanup, {}, {});
  return { service, events };
}

test('cloud deletion failure preserves backup and differential metadata', async () => {
  for (const response of [{ success: false, error: 'Cloud refused deletion' },
    { success: true, data: { success: false, error: 'Cloud refused deletion' } }]) {
    const { service, events } = fixture({ response });
    await assert.rejects(service.deleteBackup('backup-1', 'owner', 'USER'), /Cloud refused deletion/);
    assert.deepEqual(events.map(([name]) => name), ['backup:delete-remote']);
  }
});

test('successful cloud deletion precedes atomic panel metadata deletion', async () => {
  const { service, events } = fixture();
  await service.deleteBackup('backup-1', 'owner', 'USER');
  assert.deepEqual(events.map(([name]) => name), ['backup:delete-remote', 'exports', 'detach', 'delete', 'transaction']);
  const writes = events.at(-1)[1];
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].detach, { where: { baseBackupId: 'backup-1' }, data: { baseBackupId: null } });
  assert.deepEqual(writes[1].delete, { where: { id: 'backup-1' } });
});

test('Restic reference is deleted once as a snapshot, never as a cloud archive', async () => {
  const { service, events } = fixture({ restic: true });
  await service.deleteBackup('backup-1', 'owner', 'USER');
  assert.deepEqual(events.map(([name]) => name), ['restic:delete-snapshot', 'exports', 'detach', 'delete', 'transaction']);
});

test('unauthorized deletion makes no cloud or metadata writes', async () => {
  const { service, events } = fixture();
  await assert.rejects(service.deleteBackup('backup-1', 'someone-else', 'USER'), /Access denied/);
  assert.deepEqual(events, []);
});
