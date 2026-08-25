'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const migration = require('../dist/system/2026-08-24-002-federation-endpoint-defaults').default;

async function context(initialContent) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'meowbox-federation-endpoint-env-'));
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

test('adds only missing fail-closed endpoint defaults and is idempotent', async (t) => {
  const fixture = await context([
    'FEDERATION_API_ORIGIN=https://api.target.example',
    'FEDERATION_WS_PATH=/federated-socket',
    '',
  ].join('\n'));
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const plan = await migration.plan(fixture.ctx);
  assert.deepEqual(plan.details.missingKeys, [
    'FEDERATION_WS_ORIGIN',
    'FEDERATION_BROWSER_PUBLIC_ORIGIN',
    'FEDERATION_DIRECT_TRANSFER_ORIGIN',
  ]);
  await migration.up(fixture.ctx);
  const first = await readFile(fixture.envFile, 'utf8');
  assert.match(first, /^FEDERATION_API_ORIGIN=https:\/\/api\.target\.example$/m);
  assert.match(first, /^FEDERATION_WS_ORIGIN=$/m);
  assert.match(first, /^FEDERATION_BROWSER_PUBLIC_ORIGIN=$/m);
  assert.match(first, /^FEDERATION_DIRECT_TRANSFER_ORIGIN=$/m);
  assert.match(first, /^FEDERATION_WS_PATH=\/federated-socket$/m);

  await migration.up(fixture.ctx);
  assert.equal(await readFile(fixture.envFile, 'utf8'), first);
});

test('missing env is a safe no-op and installer keeps endpoints disabled', async (t) => {
  const fixture = await context(null);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const plan = await migration.plan(fixture.ctx);
  assert.equal(plan.details.missingKeys.length, 5);
  await migration.up(fixture.ctx);
  assert.match(fixture.logs.join('\n'), /SKIP: panel \.env not found/);

  const installer = await readFile(path.resolve(__dirname, '..', '..', 'install.sh'), 'utf8');
  assert.match(installer, /^FEDERATION_API_ORIGIN=$/m);
  assert.match(installer, /^FEDERATION_WS_ORIGIN=$/m);
  assert.match(installer, /^FEDERATION_BROWSER_PUBLIC_ORIGIN=$/m);
  assert.match(installer, /^FEDERATION_DIRECT_TRANSFER_ORIGIN=$/m);
  assert.match(installer, /^FEDERATION_WS_PATH=\/socket\.io$/m);
});
