'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ResticExecutor } = require('../src/backup/restic.executor');

const storage = {
  type: 'S3',
  config: {
    bucket: 'backup-bucket',
    endpoint: 'https://s3.example.test',
    prefix: 'meowbox',
    accessKey: 'access-key',
    secretKey: 'secret-key',
  },
  password: 'restic-password',
};

test('repository retention groups by stable tags and applies configured keep policy', async () => {
  const calls = [];
  const restic = new ResticExecutor();
  restic.executor = {
    async execute(command, args, options) {
      calls.push({ command, args, options });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };

  const result = await restic.forgetRepository('panel-data', storage, {
    keepDaily: 25,
    keepWeekly: 4,
    keepMonthly: 0,
    keepYearly: 1,
  });

  assert.deepEqual(result, { success: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'restic');
  assert.deepEqual(calls[0].args.slice(2), [
    'forget',
    '--tag',
    'repo:panel-data',
    '--group-by',
    'tags',
    '--prune',
    '--keep-daily',
    '25',
    '--keep-weekly',
    '4',
    '--keep-yearly',
    '1',
  ]);
  assert.equal(calls[0].options.env.RESTIC_PASSWORD, storage.password);
});

test('repository retention with empty policy is a zero-write no-op', async () => {
  const restic = new ResticExecutor();
  let called = false;
  restic.executor = {
    async execute() {
      called = true;
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };

  assert.deepEqual(
    await restic.forgetRepository('panel-data', storage, {}),
    { success: true },
  );
  assert.equal(called, false);
});

test('repository snapshot listing filters by repo tag without initializing storage', async () => {
  const restic = new ResticExecutor();
  restic.executor = {
    async execute(command, args) {
      assert.equal(command, 'restic');
      assert.deepEqual(args.slice(2), [
        'snapshots',
        '--json',
        '--tag',
        'repo:panel-data',
      ]);
      return {
        exitCode: 0,
        stdout: JSON.stringify([{ id: 'snapshot-1' }]),
        stderr: '',
      };
    },
  };

  const result = await restic.listRepositorySnapshots('panel-data', storage);
  assert.equal(result.success, true);
  assert.deepEqual(result.snapshots, [{ id: 'snapshot-1' }]);
});
