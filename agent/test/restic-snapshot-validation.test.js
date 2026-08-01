'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { ResticExecutor } = require('../src/backup/restic.executor');

function executorWithListing(lines) {
  const restic = new ResticExecutor();
  restic.executor = {
    async execute(command, args) {
      assert.equal(command, 'restic');
      assert.deepEqual(args.slice(-2), [
        '/var/meowbox/backups/site-manifests/backup.json',
        '/var/meowbox/backups/restic-tmp/backup/database.sql',
      ]);
      return {
        exitCode: 0,
        stderr: '',
        stdout: `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
      };
    },
  };
  return restic;
}

const requiredPaths = [
  '/var/meowbox/backups/site-manifests/backup.json',
  '/var/meowbox/backups/restic-tmp/backup/database.sql',
];

test('snapshot validation accepts node entries emitted by restic ls', async () => {
  const restic = executorWithListing([
    { struct_type: 'snapshot', paths: requiredPaths },
    { struct_type: 'node', path: requiredPaths[0] },
    { struct_type: 'node', path: requiredPaths[1] },
  ]);

  const result = await restic.snapshotContainsPaths(
    ['-r', 'repository'],
    {},
    'snapshot-id',
    requiredPaths,
  );

  assert.equal(result, true);
});

test('snapshot validation keeps compatibility with message_type output', async () => {
  const restic = executorWithListing([
    { message_type: 'node', path: path.normalize(requiredPaths[0]) },
    { message_type: 'node', path: path.normalize(requiredPaths[1]) },
  ]);

  const result = await restic.snapshotContainsPaths(
    ['-r', 'repository'],
    {},
    'snapshot-id',
    requiredPaths,
  );

  assert.equal(result, true);
});

test('snapshot validation fails closed when a required path is absent', async () => {
  const restic = executorWithListing([
    { struct_type: 'node', path: requiredPaths[0] },
  ]);

  const result = await restic.snapshotContainsPaths(
    ['-r', 'repository'],
    {},
    'snapshot-id',
    requiredPaths,
  );

  assert.equal(result, false);
});
