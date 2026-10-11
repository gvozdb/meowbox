'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-pg-stream-test-'));
const bin = path.join(fixture, 'bin');
const site = path.join(fixture, 'sites', 'example');
const backupRoot = path.join(fixture, 'backups');
fs.mkdirSync(bin);
fs.mkdirSync(site, { recursive: true });
fs.writeFileSync(path.join(site, 'index.txt'), 'site content');
fs.writeFileSync(path.join(bin, 'sudo'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const fixture = ${JSON.stringify(fixture)};
const args = process.argv.slice(2);
if (args.includes('pg_dump')) {
  process.stdout.write('SELECT 1;\\n');
  if (fs.existsSync(path.join(fixture, 'fail.flag'))) {
    process.stderr.write('simulated pg_dump failure');
    process.exit(9);
  }
} else if (args.includes('psql')) {
  if (!args.includes('-X') || !args.includes('ON_ERROR_STOP=1')) process.exit(8);
  let input = '';
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    fs.writeFileSync(path.join(fixture, 'restored.sql'), input);
    process.exit(input.includes('BROKEN') ? 3 : 0);
  });
} else process.exit(7);
`, { mode: 0o700 });

process.env.BACKUP_LOCAL_PATH = backupRoot;
process.env.ALLOWED_SITE_ROOT_PREFIXES = path.join(fixture, 'sites');
process.env.PATH = `${bin}:${process.env.PATH || ''}`;

const { ResticExecutor } = require('./restic.executor');
const { pgDumpToFile, pgRestoreFromFile } = require('./db-dump');
const storage = {
  type: 'LOCAL',
  config: { remotePath: path.join(fixture, 'repos') },
  password: 'fixture-password',
};
const repo = path.join(storage.config.remotePath, 'example');
const backupId = '10000000-0000-4000-8000-000000000001';

test.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

test('private PostgreSQL file dump publishes only after producer succeeds', async () => {
  const output = path.join(fixture, 'private.sql');
  await pgDumpToFile(null, 'example_db', output);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(output, 'utf8'), 'SELECT 1;\n');
  await pgRestoreFromFile(null, 'example_db', output);
  assert.equal(fs.readFileSync(path.join(fixture, 'restored.sql'), 'utf8'), 'BEGIN;\nSELECT 1;\n\nCOMMIT;\n');

  fs.writeFileSync(path.join(fixture, 'fail.flag'), '1');
  const failed = path.join(fixture, 'failed.sql');
  await assert.rejects(pgDumpToFile(null, 'example_db', failed), /pg_dump/);
  assert.equal(fs.existsSync(failed), false);
  assert.deepEqual(fs.readdirSync(fixture).filter((name) => name.includes('.partial')), []);
  fs.unlinkSync(path.join(fixture, 'fail.flag'));
});

test('Restic streams DB to a referenced snapshot and restores it through stdin', async () => {
  const executor = new ResticExecutor();
  const saved = await executor.backup({
    backupId, siteName: 'example', rootPath: site, excludePaths: [],
    type: 'FULL', storage,
    databases: [{ name: 'example_db', type: 'POSTGRESQL' }],
  }, () => undefined);
  assert.equal(saved.success, true, saved.error);
  assert.equal(fs.existsSync(path.join(backupRoot, 'restic-tmp', backupId, 'example_db.sql')), false);
  const dbSnapshots = JSON.parse(execFileSync('restic', [
    '--no-cache', '-r', repo, 'snapshots', '--json', '--tag', 'site-db:example',
  ], { env: { ...process.env, RESTIC_PASSWORD: storage.password } }).toString());
  assert.equal(dbSnapshots.length, 1);

  const restored = await executor.restore({
    backupId, restoreId: '20000000-0000-4000-8000-000000000001',
    siteName: 'example', snapshotId: saved.snapshotId,
    rootPath: site, scope: 'DB_ONLY',
    databases: [{ name: 'example_db', type: 'POSTGRESQL' }], storage,
  }, () => undefined);
  assert.equal(restored.success, true, restored.error);
  assert.equal(fs.readFileSync(path.join(fixture, 'restored.sql'), 'utf8'), 'BEGIN;\nSELECT 1;\n\nCOMMIT;\n');

  // A detached old DB snapshot must be reclaimed without touching the one
  // referenced by the retained site snapshot.
  const oldTime = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  execFileSync('restic', [
    '--no-cache', '-r', repo, 'backup', '--stdin', '--stdin-filename', 'orphan.sql',
    '--tag', 'site-db:example', '--time', oldTime,
  ], { env: { ...process.env, RESTIC_PASSWORD: storage.password }, input: 'ORPHAN' });
  const retention = await executor.forget('example', storage, { keepDaily: 1 });
  assert.equal(retention.success, true, retention.error);
  const retainedDb = JSON.parse(execFileSync('restic', [
    '--no-cache', '-r', repo, 'snapshots', '--json', '--tag', 'site-db:example',
  ], { env: { ...process.env, RESTIC_PASSWORD: storage.password } }).toString());
  assert.deepEqual(retainedDb.map((snapshot) => snapshot.id), [dbSnapshots[0].id]);

  fs.writeFileSync(path.join(fixture, 'fail.flag'), '1');
  const failed = await executor.backup({
    backupId: '10000000-0000-4000-8000-000000000002',
    siteName: 'example', rootPath: site, excludePaths: [],
    type: 'DB_ONLY', storage,
    databases: [{ name: 'example_db', type: 'POSTGRESQL' }],
  }, () => undefined);
  fs.unlinkSync(path.join(fixture, 'fail.flag'));
  assert.equal(failed.success, false);
  assert.match(failed.error, /pg_dump|PostgreSQL stream/);
  const afterFailure = JSON.parse(execFileSync('restic', [
    '--no-cache', '-r', repo, 'snapshots', '--json', '--tag', 'site-db:example',
  ], { env: { ...process.env, RESTIC_PASSWORD: storage.password } }).toString());
  assert.deepEqual(afterFailure.map((snapshot) => snapshot.id), [dbSnapshots[0].id]);
});
