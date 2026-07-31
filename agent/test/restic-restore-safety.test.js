'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const fixtureRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'meowbox-restic-restore-'),
);
const backupRoot = path.join(fixtureRoot, 'backups');
const sitesRoot = path.join(fixtureRoot, 'sites');
const fakeBin = path.join(fixtureRoot, 'bin');
fs.mkdirSync(fakeBin, { recursive: true });
fs.writeFileSync(
  path.join(fakeBin, 'restic'),
  `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const targetIndex = args.indexOf('--target');
if (!args.includes('restore') || targetIndex < 0 || !args[targetIndex + 1]) {
  process.exit(2);
}
const extractedRoot = path.join(
  args[targetIndex + 1],
  process.env.FAKE_RESTIC_ROOT_REL,
);
fs.mkdirSync(extractedRoot, { recursive: true });
fs.writeFileSync(path.join(extractedRoot, 'index.txt'), 'restored');
`,
  { mode: 0o700 },
);
fs.writeFileSync(
  path.join(fakeBin, 'cp'),
  '#!/usr/bin/env node\nprocess.stderr.write("forced cp failure"); process.exit(23);\n',
  { mode: 0o700 },
);

process.env.BACKUP_LOCAL_PATH = backupRoot;
process.env.ALLOWED_SITE_ROOT_PREFIXES = sitesRoot;
process.env.PATH = `${fakeBin}:${process.env.PATH || ''}`;

const originalLoad = Module._load;
Module._load = function loadWithSharedSource(request, parent, isMain) {
  if (request === '@meowbox/shared') {
    return require('../../shared/src/backup-restore');
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { ResticExecutor } = require('../src/backup/restic.executor');
Module._load = originalLoad;

const storage = {
  type: 'LOCAL',
  config: { remotePath: path.join(fixtureRoot, 'repo') },
  password: 'test-password',
};

test.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

function restoreParams(overrides = {}) {
  const targetRoot = path.join(sitesRoot, 'example');
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.writeFileSync(path.join(targetRoot, 'index.txt'), 'original');
  process.env.FAKE_RESTIC_ROOT_REL = targetRoot.replace(/^\/+/, '');
  return {
    backupId: '10000000-0000-4000-8000-000000000001',
    restoreId: '20000000-0000-4000-8000-000000000001',
    siteName: 'example',
    snapshotId: 'snapshot-id',
    rootPath: targetRoot,
    storage,
    ...overrides,
  };
}

test('Restic restore fails closed when a requested database dump is absent', async () => {
  const executor = new ResticExecutor();
  const params = restoreParams({
    databases: [{ name: 'example_db', type: 'MARIADB' }],
    scope: 'FILES_AND_DB',
  });
  const result = await executor.restore(params, () => undefined);

  assert.equal(result.success, false);
  assert.match(result.error, /Database dump is missing/);
  assert.equal(
    fs.readFileSync(path.join(params.rootPath, 'index.txt'), 'utf8'),
    'original',
  );
});

test('Restic restore propagates file-copy failure', async () => {
  const executor = new ResticExecutor();
  const params = restoreParams({
    restoreId: '20000000-0000-4000-8000-000000000002',
    scope: 'FILES_ONLY',
  });
  const result = await executor.restore(params, () => undefined);

  assert.equal(result.success, false);
  assert.match(result.error, /exited with code 23/);
  assert.equal(
    fs.readFileSync(path.join(params.rootPath, 'index.txt'), 'utf8'),
    'original',
  );
});
