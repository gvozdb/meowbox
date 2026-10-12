'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const test = require('node:test');

const { createRedisDataStatoverrideMigration } = require('../dist/system/2026-10-12-001-redis-data-statoverride');
const runFile = promisify(execFile);

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'meowbox-redis-statoverride-test-'));
  const dataBase = join(root, 'redis');
  const admin = join(root, 'dpkg');
  const overrideFile = join(admin, 'statoverride');
  await fs.mkdir(admin);
  const calls = [];
  const logs = [];
  const migration = createRedisDataStatoverrideMigration(dataBase, overrideFile);
  const context = (dryRun = false) => ({
    dryRun,
    log: (message) => logs.push(message),
    exec: {
      run: async (command, args) => {
        assert.equal(command, 'dpkg-statoverride');
        assert.equal(args[0], '--add');
        assert.equal(args.at(-1), dataBase);
        assert.ok(resolve(dataBase).startsWith(`${resolve(root)}/`));
        calls.push(args);
        return runFile('dpkg-statoverride', ['--admindir', admin, ...args]);
      },
    },
  });
  const addOverride = async (mode) => {
    const stat = await fs.stat(dataBase);
    await runFile('dpkg-statoverride', [
      '--admindir', admin, '--add', `#${stat.uid}`, `#${stat.gid}`, mode, dataBase,
    ]);
  };
  const cleanup = async () => {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}/meowbox-redis-statoverride-test-`));
    await fs.rm(root, { recursive: true, force: true });
  };
  return { root, dataBase, admin, overrideFile, calls, logs, migration, context, addOverride, cleanup };
}

test('records an override even when live parent is already 0751', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(f.dataBase, { mode: 0o751 });
    await fs.chmod(f.dataBase, 0o751);
    const before = await fs.stat(f.dataBase);
    const plan = await f.migration.plan(f.context());
    assert.equal(plan.details.needsOverride, true);
    assert.equal(plan.details.needsChmod, false);
    assert.deepEqual(f.calls, []);

    await f.migration.up(f.context());
    const listed = await runFile('dpkg-statoverride', ['--admindir', f.admin, '--list', f.dataBase]);
    assert.match(listed.stdout, / 751 /);
    assert.equal((await fs.stat(f.dataBase)).mode & 0o7777, 0o751);
    assert.equal((await fs.stat(f.dataBase)).uid, before.uid);
    assert.equal((await fs.stat(f.dataBase)).gid, before.gid);
    await f.migration.up(f.context());
    assert.equal(f.calls.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('records override first and adds only other-execute to 0750 parent', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(f.dataBase);
    await fs.chmod(f.dataBase, 0o750);
    await f.migration.up(f.context());
    assert.equal((await fs.stat(f.dataBase)).mode & 0o7777, 0o751);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0][3], '751');
    assert.match(await fs.readFile(f.overrideFile, 'utf8'), / 751 /);
  } finally {
    await f.cleanup();
  }
});

test('preserves special mode bits and ownership', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(f.dataBase);
    await fs.chmod(f.dataBase, 0o2750);
    const before = await fs.stat(f.dataBase);
    await f.migration.up(f.context());
    const after = await fs.stat(f.dataBase);
    assert.equal(after.mode & 0o7777, 0o2751);
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);
    assert.equal(f.calls[0][3], '2751');
  } finally {
    await f.cleanup();
  }
});

test('resumes after the override was added but chmod did not run', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(f.dataBase);
    await fs.chmod(f.dataBase, 0o750);
    await f.addOverride('751');
    await f.migration.up(f.context());
    assert.equal((await fs.stat(f.dataBase)).mode & 0o7777, 0o751);
    assert.deepEqual(f.calls, []);
  } finally {
    await f.cleanup();
  }
});

test('refuses conflicting override before changing live permissions', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(f.dataBase);
    await fs.chmod(f.dataBase, 0o750);
    await f.addOverride('750');
    assert.match((await f.migration.preflight(f.context())).reason, /Conflicting dpkg-statoverride/);
    await assert.rejects(f.migration.plan(f.context()), /Conflicting dpkg-statoverride/);
    await assert.rejects(f.migration.up(f.context()), /Conflicting dpkg-statoverride/);
    assert.equal((await fs.stat(f.dataBase)).mode & 0o7777, 0o750);
    assert.deepEqual(f.calls, []);
  } finally {
    await f.cleanup();
  }
});

test('skips absent parent and refuses a symlink parent', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.migration.plan(f.context())).details.needsOverride, false);
    await f.migration.up(f.context());
    assert.deepEqual(f.calls, []);
    const target = join(f.root, 'target');
    await fs.mkdir(target);
    await fs.symlink(target, f.dataBase);
    assert.match((await f.migration.preflight(f.context())).reason, /not a real directory/);
    await assert.rejects(f.migration.up(f.context()), /not a real directory/);
    assert.deepEqual(f.calls, []);
  } finally {
    await f.cleanup();
  }
});

test('dry-run plans without writing or executing commands', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(f.dataBase);
    await fs.chmod(f.dataBase, 0o750);
    await f.migration.plan(f.context(true));
    await f.migration.up(f.context(true));
    assert.equal((await fs.stat(f.dataBase)).mode & 0o7777, 0o750);
    await assert.rejects(fs.readFile(f.overrideFile), { code: 'ENOENT' });
    assert.deepEqual(f.calls, []);
  } finally {
    await f.cleanup();
  }
});

test('surfaces override file read errors without changing permissions', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(f.dataBase);
    await fs.chmod(f.dataBase, 0o750);
    await fs.mkdir(f.overrideFile);
    assert.match((await f.migration.preflight(f.context())).reason, /EISDIR/);
    await assert.rejects(f.migration.plan(f.context()), { code: 'EISDIR' });
    await assert.rejects(f.migration.up(f.context()), { code: 'EISDIR' });
    assert.equal((await fs.stat(f.dataBase)).mode & 0o7777, 0o750);
    assert.deepEqual(f.calls, []);
  } finally {
    await f.cleanup();
  }
});
