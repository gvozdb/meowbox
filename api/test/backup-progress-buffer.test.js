'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BackupProgressBuffer } = require('../src/backups/backup-progress-buffer');
test('a flood of progress events is coalesced while one write is blocked', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const writes = [];
  const buffer = new BackupProgressBuffer(async (id, p) => { writes.push([id, p]); await gate; }, () => {}, 60000);
  buffer.push('one', 1);
  const flushing = buffer.flush();
  for (let i = 0; i < 100000; i++) buffer.push('one', i % 100);
  assert.equal(writes.length, 1);
  assert.equal(buffer.pending.size, 1);
  release();
  await flushing;
  await buffer.flush();
  assert.deepEqual(writes, [['one', 1], ['one', 99]]);
});
test('telemetry is bounded by run count and rejects invalid percentages', async () => {
  const writes = [];
  const buffer = new BackupProgressBuffer(async (id, p) => writes.push([id, p]), () => {}, 60000);
  for (let i = 0; i < 1000; i++) buffer.push(`id-${i}`, 20);
  buffer.push('nan', NaN);
  assert.equal(buffer.pending.size, 128);
  buffer.discard('id-0');
  await buffer.flush();
  assert.equal(writes.length, 127);
});
