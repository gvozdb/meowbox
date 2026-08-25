'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  ChildProcessRegistry,
  spawnOwned,
} = require('../src/process-registry');
const { runInAgentJobContext } = require('../src/job-context');

test('T-OPS-005 process registry binds children to job and cancels process group', async () => {
  const registry = new ChildProcessRegistry();
  let proc;
  await runInAgentJobContext(
    {
      jobId: '11111111-2222-4333-8444-555555555555',
      operationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      cancelSafe: true,
    },
    async () => {
      const { spawn } = require('node:child_process');
      proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
      });
      registry.track(proc, 'test-child', { processGroup: true });
    },
  );
  assert.equal(registry.list()[0].jobId, '11111111-2222-4333-8444-555555555555');
  const result = await registry.cancelJob('11111111-2222-4333-8444-555555555555', 100);
  assert.equal(result.outcome, 'CANCELLED');
  if (proc.exitCode === null && proc.signalCode === null) {
    await Promise.race([
      new Promise((resolve) => proc.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
  }
  assert.equal(registry.list().length, 0);
});

test('T-OPS-006 source inventory fails on unowned child_process spawn', () => {
  const sourceRoot = path.resolve(__dirname, '../src');
  const allowed = new Set([
    'backup/restic.executor.ts',
    'command-executor.ts',
    'process-registry.ts',
  ]);
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) files.push(full);
    }
  };
  walk(sourceRoot);
  const direct = files
    .filter((file) => /\bspawn\(/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(sourceRoot, file).replaceAll('\\', '/'))
    .filter((file) => file !== 'terminal/terminal.manager.ts')
    .sort();
  assert.deepEqual(direct, [...allowed].sort());
  for (const relative of direct) {
    const source = fs.readFileSync(path.join(sourceRoot, relative), 'utf8');
    assert.match(source, /childProcessRegistry\.track|function spawnOwned/);
  }
  assert.equal(typeof spawnOwned, 'function');
});
