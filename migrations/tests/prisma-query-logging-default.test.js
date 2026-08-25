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
  require('../dist/system/2026-08-20-001-prisma-query-logging-default').default;

async function context(initialContent) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'meowbox-prisma-log-migration-'));
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

test('adds the disabled Prisma query logging default once and preserves an operator override', async (t) => {
  const fixture = await context('PRISMA_LOG_QUERIES=true\n');
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const configured = await migration.plan(fixture.ctx);
  assert.deepEqual(configured.details.missingKeys, []);
  await migration.up(fixture.ctx);
  assert.equal(await readFile(fixture.envFile, 'utf8'), 'PRISMA_LOG_QUERIES=true\n');

  await writeFile(fixture.envFile, 'NODE_ENV=production\n', 'utf8');
  const missing = await migration.plan(fixture.ctx);
  assert.deepEqual(missing.details.missingKeys, ['PRISMA_LOG_QUERIES']);
  await migration.up(fixture.ctx);
  const afterFirst = await readFile(fixture.envFile, 'utf8');
  assert.match(afterFirst, /^PRISMA_LOG_QUERIES=false$/m);

  await migration.up(fixture.ctx);
  assert.equal(await readFile(fixture.envFile, 'utf8'), afterFirst);
});

test('missing env is a safe no-op represented by the dry-run plan', async (t) => {
  const fixture = await context(null);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const plan = await migration.plan(fixture.ctx);
  assert.deepEqual(plan.details.missingKeys, ['PRISMA_LOG_QUERIES']);
  assert.match(plan.summary, /installation will provide/);

  await migration.up(fixture.ctx);
  assert.match(fixture.logs.join('\n'), /SKIP: panel \.env not found/);
});

test('fresh installer disables Prisma query stdout logging', async () => {
  const installer = path.resolve(__dirname, '..', '..', 'install.sh');
  const content = await readFile(installer, 'utf8');
  assert.match(content, /^PRISMA_LOG_QUERIES=false$/m);
});
