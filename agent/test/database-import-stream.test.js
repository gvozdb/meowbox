'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { gzipSync } = require('node:zlib');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-agent-db-import-'));
const previousStateDir = process.env.MEOWBOX_STATE_DIR;
process.env.MEOWBOX_STATE_DIR = root;
const artifactsRoot = path.join(root, 'data', 'transfers', 'artifacts');
fs.mkdirSync(artifactsRoot, { recursive: true });

const { CommandExecutor } = require('../src/command-executor');
const { DatabaseManager } = require('../src/database/database.manager');

test.after(() => {
  if (previousStateDir === undefined) delete process.env.MEOWBOX_STATE_DIR;
  else process.env.MEOWBOX_STATE_DIR = previousStateDir;
  fs.rmSync(root, { recursive: true, force: true });
});

function managerWithCapture() {
  const manager = new DatabaseManager();
  const calls = [];
  manager.executor = {
    executeWithInput: async (command, args, input) => {
      const chunks = [];
      for await (const chunk of input) chunks.push(Buffer.from(chunk));
      calls.push({ command, args, body: Buffer.concat(chunks) });
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  return { manager, calls };
}

test('T-XFER-002 database import streams plain staged artifact into client stdin', async () => {
  const payload = Buffer.from('CREATE TABLE fixture(id INT);\n');
  const artifact = path.join(artifactsRoot, '11111111-1111-4111-8111-111111111111.artifact');
  fs.writeFileSync(artifact, payload, { mode: 0o600 });
  const { manager, calls } = managerWithCapture();
  const result = await manager.importDatabase('fixture_db', 'MARIADB', artifact, 'fixture.sql');
  assert.equal(result.success, true);
  assert.equal(calls[0].command, 'mariadb');
  assert.deepEqual(calls[0].args, ['-u', 'root', 'fixture_db']);
  assert.deepEqual(calls[0].body, payload);
});

test('T-XFER-002 database import validates and streams gzip without whole-file buffering', async () => {
  const payload = Buffer.from('INSERT INTO fixture VALUES (1);\n');
  const artifact = path.join(artifactsRoot, '22222222-2222-4222-8222-222222222222.artifact');
  fs.writeFileSync(artifact, gzipSync(payload), { mode: 0o600 });
  const { manager, calls } = managerWithCapture();
  const result = await manager.importDatabase('fixture_db', 'POSTGRESQL', artifact, 'fixture.sql.gz');
  assert.equal(result.success, true);
  assert.equal(calls[0].command, 'sudo');
  assert.deepEqual(calls[0].args, ['-u', 'postgres', 'psql', '-d', 'fixture_db']);
  assert.deepEqual(calls[0].body, payload);
});

test('T-XFER-002 database import rejects path escape, symlink, and compression mismatch', async () => {
  const outside = '/etc/hosts';
  const symlink = path.join(artifactsRoot, '33333333-3333-4333-8333-333333333333.artifact');
  fs.symlinkSync(outside, symlink);
  const mismatch = path.join(artifactsRoot, '44444444-4444-4444-8444-444444444444.artifact');
  fs.writeFileSync(mismatch, 'SELECT 1');
  const { manager } = managerWithCapture();
  assert.equal((await manager.importDatabase('fixture_db', 'MYSQL', outside, 'outside.sql')).success, false);
  assert.equal((await manager.importDatabase('fixture_db', 'MYSQL', symlink, 'fixture.sql')).success, false);
  assert.match(
    (await manager.importDatabase('fixture_db', 'MYSQL', mismatch, 'fixture.sql.gz')).error,
    /compression does not match/,
  );
});

test('T-OPS-004 CommandExecutor pipes stdin with process ownership and bounded output', async () => {
  const executor = new CommandExecutor();
  const result = await executor.executeWithInput('cat', [], Readable.from(['fixture-input']));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'fixture-input');
});
