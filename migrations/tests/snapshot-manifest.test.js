'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const snapshotScript = path.join(root, 'tools', 'snapshot.sh');
const releaseLib = path.join(root, 'tools', 'release-lib.sh');
const updater = path.join(root, 'tools', 'update.sh');

test('SQLite fingerprints ignore transient SHM lock state', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-fingerprint-'));
  try {
    const database = path.join(temp, 'meowbox.db');
    fs.writeFileSync(database, 'main');
    fs.writeFileSync(`${database}-wal`, 'wal');
    fs.writeFileSync(`${database}-shm`, 'shm-before');

    const fingerprint = () => execFileSync(
      'bash',
      [
        '-c',
        'source "$1"; mb_sqlite_file_fingerprint "$2"',
        'fingerprint-test',
        releaseLib,
        database,
      ],
      { encoding: 'utf8' },
    ).trim();

    const before = fingerprint();
    fs.writeFileSync(`${database}-shm`, 'shm-after');
    assert.equal(fingerprint(), before);

    fs.writeFileSync(`${database}-wal`, 'wal-after');
    assert.notEqual(fingerprint(), before);

    assert.doesNotMatch(fs.readFileSync(updater, 'utf8'), /DB_FILE-shm/);
    assert.doesNotMatch(fs.readFileSync(snapshotScript, 'utf8'), /DB_FILE-shm/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('snapshot manifest records redacted PM2 state without pipefail', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-snapshot-'));
  try {
    const stateDir = path.join(temp, 'state');
    const dataDir = path.join(stateDir, 'data');
    const snapshotRoot = path.join(dataDir, 'snapshots');
    const envFile = path.join(stateDir, '.env');
    const pathsFile = path.join(temp, 'managed-paths.txt');

    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(envFile, 'TEST_ONLY=1\n', { mode: 0o600 });
    fs.writeFileSync(pathsFile, '');

    const output = execFileSync(
      'bash',
      [snapshotScript, '--paths-file', pathsFile, '--no-rotate'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          MEOWBOX_STATE_DIR: stateDir,
          MEOWBOX_DATABASE_FILE: path.join(dataDir, 'missing.db'),
          MEOWBOX_ENV_FILE: envFile,
          MEOWBOX_SNAPSHOT_ROOT: snapshotRoot,
        },
      },
    );
    const snapshotDir = output.trim().split('\n').at(-1);
    const manifestText = fs.readFileSync(
      path.join(snapshotDir, 'manifest.json'),
      'utf8',
    );
    const manifest = JSON.parse(manifestText);

    const allowedKeys = [
      'cwd',
      'execPath',
      'name',
      'namespace',
      'pid',
      'pmId',
      'restartTime',
      'status',
    ];
    assert.ok(Array.isArray(manifest.pm2));
    for (const process of manifest.pm2) {
      assert.deepEqual(Object.keys(process).sort(), allowedKeys);
    }
    assert.doesNotMatch(
      manifestText,
      /pm2_env|INTERNAL_TOKEN|AGENT_SECRET|MEOWBOX_MASTER_KEY/,
    );

    const source = fs.readFileSync(snapshotScript, 'utf8');
    assert.doesNotMatch(source, /printf[^\n]*PM2_STATE[^\n]*\|[^\n]*python3/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
