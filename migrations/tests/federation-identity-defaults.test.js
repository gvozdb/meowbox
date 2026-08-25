'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const migration = require('../dist/system/2026-08-24-001-federation-identity-defaults').default;

async function context(initialContent) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'meowbox-federation-env-'));
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

test('adds only missing disabled federation defaults and is idempotent', async (t) => {
  const fixture = await context([
    'MEOWBOX_INSTALLATION_ROLE=TARGET',
    'FEDERATION_PROTOCOL_MODE=observe',
    '',
  ].join('\n'));
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const plan = await migration.plan(fixture.ctx);
  assert.deepEqual(plan.details.missingKeys, ['FEDERATION_MAX_ACTIVE_REPLAYS_PER_ISSUER']);
  await migration.up(fixture.ctx);
  const first = await readFile(fixture.envFile, 'utf8');
  assert.match(first, /^MEOWBOX_INSTALLATION_ROLE=TARGET$/m);
  assert.match(first, /^FEDERATION_PROTOCOL_MODE=observe$/m);
  assert.match(first, /^FEDERATION_MAX_ACTIVE_REPLAYS_PER_ISSUER=10000$/m);
  assert.doesNotMatch(first, /^MEOWBOX_INSTALLATION_ROLE=MASTER$/m);

  await migration.up(fixture.ctx);
  assert.equal(await readFile(fixture.envFile, 'utf8'), first);
});

test('missing env remains a safe no-op', async (t) => {
  const fixture = await context(null);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const plan = await migration.plan(fixture.ctx);
  assert.equal(plan.details.missingKeys.length, 3);
  await migration.up(fixture.ctx);
  assert.match(fixture.logs.join('\n'), /SKIP: panel \.env not found/);
});

test('installer defaults master/disabled and target bootstrap rejects a master installation', async () => {
  const root = path.resolve(__dirname, '..', '..');
  const installer = await readFile(path.join(root, 'install.sh'), 'utf8');
  const targetEnrollment = await readFile(
    path.join(root, 'api/src/federation/federation-enrollment.service.ts'),
    'utf8',
  );
  const sshBootstrap = await readFile(
    path.join(root, 'api/src/federation/federation-enrollment-ssh.service.ts'),
    'utf8',
  );
  assert.match(installer, /^MEOWBOX_INSTALLATION_ROLE="\$\{INSTALLATION_ROLE\}"$/m);
  assert.match(installer, /^FEDERATION_PROTOCOL_MODE=disabled$/m);
  assert.match(installer, /^FEDERATION_MAX_ACTIVE_REPLAYS_PER_ISSUER=10000$/m);
  assert.match(targetEnrollment, /identity\.installationRole !== 'TARGET'/);
  assert.match(sshBootstrap, /federation-enrollment-bootstrap\.cli\.js/);
});
