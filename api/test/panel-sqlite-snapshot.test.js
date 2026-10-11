'use strict';

require('reflect-metadata');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createPanelSqliteSnapshot } = require('../src/backups/panel-sqlite-snapshot');

test('online panel snapshot is consistent, private, and leaves no partial files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-sqlite-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = path.join(root, 'panel.db');
  const snapshots = path.join(root, 'snapshots');
  execFileSync('sqlite3', [db, 'CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES (\'before\');']);
  const snapshot = await createPanelSqliteSnapshot(db, snapshots);
  execFileSync('sqlite3', [db, "INSERT INTO sample VALUES ('after');"]);
  assert.equal(execFileSync('sqlite3', [snapshot, 'SELECT group_concat(value) FROM sample;']).toString().trim(), 'before');
  assert.equal(fs.statSync(snapshot).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(snapshots), [path.basename(snapshot)]);
});

test('snapshot busy failure is bounded and removes partial output', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-sqlite-busy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = path.join(root, 'panel.db');
  const snapshots = path.join(root, 'snapshots');
  execFileSync('sqlite3', [db, 'CREATE TABLE sample(value TEXT);']);
  const lock = spawn('sqlite3', [db], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { lock.stdin.end(); lock.kill(); });
  const ready = new Promise((resolve, reject) => {
    lock.stdout.once('data', resolve);
    lock.once('error', reject);
  });
  lock.stdin.write("BEGIN EXCLUSIVE; INSERT INTO sample VALUES ('locked'); .print ready\n".replace(' .print', '\n.print'));
  await ready;
  const started = Date.now();
  await assert.rejects(createPanelSqliteSnapshot(db, snapshots), /locked|busy|deadline|killed/i);
  assert.ok(Date.now() - started < 16_000);
  assert.deepEqual(fs.readdirSync(snapshots), []);
});

test('concurrent snapshots share the disk budget including retained files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-sqlite-budget-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = path.join(root, 'panel.db');
  const snapshots = path.join(root, 'snapshots');
  fs.mkdirSync(snapshots);
  execFileSync('sqlite3', [db, 'CREATE TABLE sample(value TEXT);']);
  const size = fs.statSync(db).size;
  const retained = path.join(snapshots, 'panel-run-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.db');
  const fd = fs.openSync(retained, 'wx', 0o600);
  fs.ftruncateSync(fd, 512 * 1024 * 1024 - size);
  fs.closeSync(fd);
  const results = await Promise.allSettled([
    createPanelSqliteSnapshot(db, snapshots), createPanelSqliteSnapshot(db, snapshots),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.match(results.find((r) => r.status === 'rejected').reason.message, /512 MiB total budget/);
  assert.equal(fs.readdirSync(snapshots).length, 2);
});
