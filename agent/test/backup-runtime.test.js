'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BackupRuntime } = require('../src/backup/backup-runtime');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-receipts-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, runtime: new BackupRuntime(dir) };
}
test('backups execute sequentially and a failed acknowledgement survives restart', async (t) => {
  const { dir, runtime } = fixture(t);
  let running = 0, maximum = 0;
  const run = (id) => runtime.run(id, 'backup:complete', async () => {
    maximum = Math.max(maximum, ++running);
    await new Promise((r) => setTimeout(r, 5));
    runtime.complete('backup:complete', { backupId: id, success: true, snapshotId: 'a'.repeat(64) });
    running--;
  });
  await Promise.all([run('one'), run('two'), run('three')]);
  assert.equal(maximum, 1);
  await runtime.deliver(async () => false);
  const restarted = new BackupRuntime(dir);
  assert.equal(restarted.activity().length, 3);
  const delivered = [];
  await restarted.deliver(async (event, result) => { delivered.push(result); return true; });
  assert.equal(delivered.length, 3);
  assert.ok(delivered.every((r) => r.success));
  assert.equal(restarted.activity().length, 0);
  assert.equal(fs.statSync(path.join(dir, 'receipts.json')).mode & 0o777, 0o600);
});
test('unacknowledged receipts impose backpressure without deleting old results', async (t) => {
  const { runtime, dir } = fixture(t);
  for (let n = 0; n < 128; n++) {
    await runtime.run(`run-${n}`, 'backup:complete', async () => {
      runtime.complete('backup:complete', { backupId: `run-${n}`, success: false, error: 'x'.repeat(10000) });
    });
  }
  assert.throws(() => runtime.run('overflow', 'backup:complete', async () => {}), /full/);
  assert.equal(runtime.activity().length, 128);
  assert.ok(fs.statSync(path.join(dir, 'receipts.json')).size <= 512 * 1024);
});
test('thrown backup errors become durable failures and maintenance cannot overlap a backup', async (t) => {
  const { runtime } = fixture(t);
  let active = false;
  const run = runtime.run('failed', 'backup:complete', async () => {
    active = true;
    await new Promise((r) => setTimeout(r, 5));
    active = false;
    throw new Error('producer exited');
  });
  const maintenance = runtime.exclusive(async () => assert.equal(active, false));
  await assert.rejects(run, /producer exited/);
  await maintenance;
  await runtime.deliver(async (_event, result) => {
    assert.equal(result.success, false);
    assert.match(result.error, /producer exited/);
    return true;
  });
});

test('background maintenance rejects busy and unacknowledged work without entering its queue', async (t) => {
  const { runtime } = fixture(t);
  await runtime.run('run', 'backup:complete', async () => {
    runtime.complete('backup:complete', { backupId: 'run', success: true });
  });
  let calls = 0;
  await assert.rejects(runtime.exclusive(async () => { calls++; }, true), /busy/);
  await runtime.deliver(async () => true);
  let release;
  const work = runtime.exclusive(() => new Promise((resolve) => { release = resolve; }), true);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(runtime.exclusive(async () => { calls++; }, true), /busy/);
  release();
  await work;
  await runtime.exclusive(async () => { calls++; }, true);
  assert.equal(calls, 1);
});
