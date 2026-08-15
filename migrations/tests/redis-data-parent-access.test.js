'use strict';

const assert = require('node:assert/strict');
const { chmod, mkdir, mkdtemp, rm, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const test = require('node:test');

const {
  createRedisDataParentAccessMigration,
} = require('../dist/system/2026-08-15-001-redis-data-parent-access');

function assertTemporaryPath(candidate) {
  assert.ok(
    resolve(candidate).startsWith(`${resolve(tmpdir())}/meowbox-redis-parent-test-`),
    `refusing test write outside a temporary fixture: ${candidate}`,
  );
}

function context() {
  return { dryRun: false, log: () => {} };
}

test('migration adds only traversal permission to an existing Redis parent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'meowbox-redis-parent-test-'));
  try {
    const dataBase = join(root, 'redis');
    await mkdir(dataBase);
    await chmod(dataBase, 0o750);
    const migration = createRedisDataParentAccessMigration(dataBase);

    const plan = await migration.plan(context());
    assert.equal(plan.details.needsTraversal, true);

    await migration.up(context());
    assert.equal((await stat(dataBase)).mode & 0o777, 0o751);

    await migration.up(context());
    assert.equal((await stat(dataBase)).mode & 0o777, 0o751);
  } finally {
    assertTemporaryPath(root);
    await rm(root, { recursive: true, force: true });
  }
});

test('migration skips a missing Redis parent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'meowbox-redis-parent-test-'));
  try {
    const dataBase = join(root, 'missing');
    const migration = createRedisDataParentAccessMigration(dataBase);
    const plan = await migration.plan(context());
    assert.equal(plan.details.needsTraversal, false);
    await migration.up(context());
  } finally {
    assertTemporaryPath(root);
    await rm(root, { recursive: true, force: true });
  }
});
