'use strict';

const assert = require('node:assert/strict');
const {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const migration =
  require('../dist/system/2026-07-31-002-release-env-defaults').default;

async function context(initialContent) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'meowbox-env-migration-'));
  const stateDir = path.join(root, 'state');
  const envFile = path.join(stateDir, '.env');
  await mkdir(stateDir, { recursive: true });
  if (initialContent !== null) await writeFile(envFile, initialContent, 'utf8');
  const logs = [];
  return {
    root,
    envFile,
    logs,
    ctx: {
      exists: async (candidate) => {
        try {
          await readFile(candidate);
          return true;
        } catch {
          return false;
        }
      },
      readFile: (candidate) => readFile(candidate, 'utf8'),
      writeFile: (candidate, content) => writeFile(candidate, content, 'utf8'),
      log: (message) => logs.push(message),
      config: {
        panelDir: root,
        currentDir: root,
        stateDir,
        migrationStateDir: path.join(stateDir, 'data', 'migrations'),
        releaseLockFile: path.join(stateDir, 'data', 'migrations', 'lock'),
        sitesBasePath: '/var/www',
        nodeEnv: 'production',
      },
    },
  };
}

test('appends missing release defaults once and preserves custom values', async (t) => {
  const fixture = await context('MEOWBOX_QUIESCE_TIMEOUT=300\n');
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const plan = await migration.plan(fixture.ctx);
  assert.deepEqual(plan.details.missingKeys, ['MEOWBOX_RELEASE_MIN_FREE_KB']);

  await migration.up(fixture.ctx);
  const afterFirst = await readFile(fixture.envFile, 'utf8');
  assert.match(afterFirst, /^MEOWBOX_QUIESCE_TIMEOUT=300$/m);
  assert.match(afterFirst, /^MEOWBOX_RELEASE_MIN_FREE_KB=524288$/m);

  await migration.up(fixture.ctx);
  assert.equal(await readFile(fixture.envFile, 'utf8'), afterFirst);
});

test('missing env is a safe no-op represented by the dry-run plan', async (t) => {
  const fixture = await context(null);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const plan = await migration.plan(fixture.ctx);
  assert.deepEqual(plan.details.missingKeys, [
    'MEOWBOX_QUIESCE_TIMEOUT',
    'MEOWBOX_RELEASE_MIN_FREE_KB',
  ]);
  assert.match(plan.summary, /installation will provide/);

  await migration.up(fixture.ctx);
  assert.match(fixture.logs.join('\n'), /SKIP: panel .env not found/);
});
