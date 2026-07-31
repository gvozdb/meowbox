'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { BackupExecutor } = require('../src/backup/backup.executor');

test('required backup metadata bypasses user excludes', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-archive-'));
  try {
    const root = path.join(temp, 'site');
    const manifest = path.join(temp, 'required-manifest.json');
    const archive = path.join(temp, 'site.tar.gz');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'index.txt'), 'site');
    fs.writeFileSync(manifest, '{"manifestVersion":2}');

    const executor = new BackupExecutor();
    await executor.createArchive(
      archive,
      [root],
      temp,
      ['*manifest*'],
      undefined,
      [manifest],
    );

    const members = execFileSync('tar', ['-tzf', archive], {
      encoding: 'utf8',
    }).trim().split('\n');
    assert.ok(members.includes('required-manifest.json'));
    assert.ok(members.includes('site/index.txt'));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
