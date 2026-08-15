'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPid(pidFilePath) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await fs.readFile(pidFilePath, 'utf8')).trim());
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch {
      // Parent launcher is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('runner pid was not published');
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

test('runner survives stop of the API parent process tree', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meowbox-update-runner-'));
  const logFilePath = path.join(directory, 'update.log');
  const pidFilePath = path.join(directory, 'runner.pid');
  const harnessPath = path.join(directory, 'launch-parent.cjs');
  const runnerModulePath = path.resolve(__dirname, '../src/panel-update/update-runner.ts');
  const sourceRegisterPath = path.resolve(__dirname, '../../tools/register-shared-source.js');
  let pid = null;
  let parent = null;

  t.after(async () => {
    if (parent && parent.exitCode === null) parent.kill('SIGTERM');
    if (pid && isAlive(pid)) process.kill(pid, 'SIGTERM');
    await fs.rm(directory, { recursive: true, force: true });
  });

  await fs.writeFile(
    harnessPath,
    [
      "const { launchReparentedUpdateRunner } = require(process.argv[2]);",
      'const [directory, logFilePath, pidFilePath] = process.argv.slice(3);',
      'launchReparentedUpdateRunner({',
      "  command: 'bash',",
      "  args: ['-c', 'printf runner-started; sleep 30'],",
      '  cwd: directory,',
      '  env: process.env,',
      '  logFilePath,',
      '  pidFilePath,',
      '}).then(() => setInterval(() => {}, 1_000));',
    ].join('\n'),
    'utf8',
  );

  parent = spawn(
    process.execPath,
    ['-r', 'ts-node/register', '-r', sourceRegisterPath, harnessPath, runnerModulePath, directory, logFilePath, pidFilePath],
    {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1' },
      stdio: 'ignore',
    },
  );
  pid = await waitForPid(pidFilePath);

  assert.equal(await fs.readFile(pidFilePath, 'utf8'), `${pid}\n`);
  assert.match(await fs.readFile(logFilePath, 'utf8'), /runner-started/);
  const parentPid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
  assert.notEqual(parentPid, parent.pid);

  parent.kill('SIGTERM');
  await waitForExit(parent);

  assert.ok(isAlive(pid));
});
