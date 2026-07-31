'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const fixtureRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'meowbox-backup-restore-'),
);
const backupRoot = path.join(fixtureRoot, 'backups');
const sitesRoot = path.join(fixtureRoot, 'sites');
process.env.BACKUP_LOCAL_PATH = backupRoot;
process.env.ALLOWED_SITE_ROOT_PREFIXES = sitesRoot;

const originalLoad = Module._load;
Module._load = function loadWithSharedSource(request, parent, isMain) {
  if (request === '@meowbox/shared') {
    return require('../../shared/src/backup-restore');
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { BackupExecutor } = require('../src/backup/backup.executor');
Module._load = originalLoad;

test.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

test('TAR restore fails closed when a requested database dump is absent', async () => {
  const targetRoot = path.join(sitesRoot, 'example');
  const archive = path.join(fixtureRoot, 'backup.tar.gz');
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.writeFileSync(path.join(targetRoot, 'index.txt'), 'original');
  execFileSync('tar', [
    '-czf',
    archive,
    '-C',
    '/',
    targetRoot.replace(/^\/+/, ''),
  ]);

  const executor = new BackupExecutor();
  const result = await executor.restore(
    {
      backupId: '10000000-0000-4000-8000-000000000001',
      restoreId: '20000000-0000-4000-8000-000000000001',
      siteId: '30000000-0000-4000-8000-000000000001',
      siteName: 'example',
      rootPath: targetRoot,
      filePath: archive,
      storageType: 'LOCAL',
      storageConfig: {},
      databases: [{ name: 'example_db', type: 'MARIADB' }],
      scope: 'FILES_AND_DB',
    },
    () => undefined,
  );

  assert.equal(result.success, false);
  assert.match(result.error, /Database dump is missing/);
  assert.equal(fs.readFileSync(path.join(targetRoot, 'index.txt'), 'utf8'), 'original');
  assert.deepEqual(
    fs.existsSync(backupRoot)
      ? fs.readdirSync(backupRoot).filter((name) => name.startsWith('restore-'))
      : [],
    [],
  );
});

test('TAR restore rejects invalid selective paths before extraction', async () => {
  const executor = new BackupExecutor();
  const result = await executor.restore(
    {
      backupId: '10000000-0000-4000-8000-000000000001',
      restoreId: '20000000-0000-4000-8000-000000000002',
      siteId: '30000000-0000-4000-8000-000000000001',
      siteName: 'example',
      rootPath: path.join(sitesRoot, 'example'),
      filePath: path.join(fixtureRoot, 'does-not-matter.tar.gz'),
      storageType: 'LOCAL',
      storageConfig: {},
      scope: 'FILES_ONLY',
      includePaths: ['../outside'],
    },
    () => undefined,
  );

  assert.equal(result.success, false);
  assert.match(result.error, /Invalid restore include path/);
});
