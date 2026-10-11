'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const test = require('node:test');
const { ResticExecutor } = require('../src/backup/restic.executor');

const storage = {
  type: 'S3',
  config: {
    bucket: 'backup-bucket', endpoint: 'https://s3.example.test', prefix: 'meowbox',
    accessKey: 'access-key', secretKey: 'secret-key',
  },
  password: 'restic-password',
};

function mockRestic() {
  const calls = [];
  const restic = new ResticExecutor();
  restic.executor = {
    async execute(command, args, options) {
      calls.push({ command, args, options });
      // Site retention inventories DB snapshots even when there are none.
      return { exitCode: 0, stdout: args.includes('snapshots') ? '[]' : '', stderr: '' };
    },
  };
  return { restic, calls };
}

test('site retention filters this host, inventories DB snapshots, then prunes independently', async () => {
  const { restic, calls } = mockRestic();
  assert.deepEqual(await restic.forget('example-test', storage, {
    keepDaily: 7, keepWeekly: 0, keepMonthly: 2, keepYearly: 0,
  }), { success: true });

  assert.deepEqual(calls.map(({ args }) => args[2]), ['forget', 'snapshots', 'prune']);
  assert.deepEqual(calls[0].args.slice(2), [
    'forget', '--no-cache', '--tag', 'site:example-test', '--host', os.hostname(),
    '--group-by', 'host,tags', '--keep-daily', '7', '--keep-monthly', '2',
  ]);
  assert.deepEqual(calls[1].args.slice(2), ['snapshots', '--json', '--tag', 'site-db:example-test']);
  assert.deepEqual(calls[2].args.slice(2), ['prune', '--no-cache']);
  assert.ok(calls.every(({ command, options }) =>
    command === 'restic' && options.env.RESTIC_PASSWORD === storage.password));
});

test('site retention with all-zero policy makes no repository calls', async () => {
  const { restic, calls } = mockRestic();
  assert.deepEqual(await restic.forget('example-test', storage, {
    keepDaily: 0, keepWeekly: 0, keepMonthly: 0, keepYearly: 0,
  }), { success: true });
  assert.equal(calls.length, 0);
});

test('repository retention cannot select another host and prunes after zero removals', async () => {
  const { restic, calls } = mockRestic();
  assert.deepEqual(await restic.forgetRepository('panel-data', storage, {
    keepDaily: 25, keepWeekly: 4, keepMonthly: 0, keepYearly: 1,
  }), { success: true });

  assert.deepEqual(calls.map(({ args }) => args[2]), ['forget', 'prune']);
  assert.deepEqual(calls[0].args.slice(2), [
    'forget', '--no-cache', '--tag', 'repo:panel-data', '--host', os.hostname(),
    '--group-by', 'host,tags', '--keep-daily', '25', '--keep-weekly', '4', '--keep-yearly', '1',
  ]);
  assert.deepEqual(calls[1].args.slice(2), ['prune', '--no-cache']);
  assert.ok(calls.every(({ command, options }) =>
    command === 'restic' && options.env.RESTIC_PASSWORD === storage.password));
});

test('repository retention with empty policy makes no repository calls', async () => {
  const { restic, calls } = mockRestic();
  assert.deepEqual(await restic.forgetRepository('panel-data', storage, {}), { success: true });
  assert.equal(calls.length, 0);
});

test('repository snapshot listing filters by repo tag without initializing storage', async () => {
  const restic = new ResticExecutor();
  restic.executor = {
    async execute(command, args) {
      assert.equal(command, 'restic');
      assert.deepEqual(args.slice(2), ['snapshots', '--json', '--tag', 'repo:panel-data']);
      return { exitCode: 0, stdout: JSON.stringify([{ id: 'snapshot-1' }]), stderr: '' };
    },
  };

  const result = await restic.listRepositorySnapshots('panel-data', storage);
  assert.equal(result.success, true);
  assert.deepEqual(result.snapshots, [{ id: 'snapshot-1' }]);
});
