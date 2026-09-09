'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = require(
  '../dist/system/2026-09-09-002-adminer-http-handoff-runtime',
).default;

const SOURCE_PATH = '/release/tools/adminer-src/lib/sso.php';
const RUNTIME_PATH = '/state/adminer/lib/sso.php';
const POOL_PATH = '/etc/php/8.4/fpm/pool.d/meowbox-adminer.conf';
const SOCKET_PATH = '/run/php/meowbox-adminer.sock';

function fixture(sourceOverride) {
  const source = sourceOverride ?? fs.readFileSync(
    path.resolve(__dirname, '../../tools/adminer-src/lib/sso.php'),
    'utf8',
  );
  const files = new Map([
    [SOURCE_PATH, source],
    ['/state/adminer/adminer.php', '<?php // Adminer'],
    [RUNTIME_PATH, '<?php // legacy single-cookie runtime'],
    [POOL_PATH, '[meowbox-adminer]'],
    [SOCKET_PATH, 'socket'],
  ]);
  const commands = [];
  const writes = [];
  const ctx = {
    prisma: {},
    exec: {
      run: async (command, args) => {
        commands.push([command, args]);
        return command === 'php'
          ? { stdout: 'No syntax errors detected', stderr: '' }
          : { stdout: '', stderr: '' };
      },
      runShell: async () => ({ stdout: '', stderr: '' }),
    },
    exists: async (file) => files.has(file),
    readFile: async (file) => {
      if (!files.has(file)) throw new Error(`missing fixture file: ${file}`);
      return files.get(file);
    },
    writeFile: async (file, content, mode) => {
      files.set(file, content);
      writes.push([file, mode]);
    },
    checkpoints: {
      read: async () => null,
      write: async () => {},
      remove: async () => {},
      pathFor: () => '/checkpoint',
    },
    log: () => {},
    config: {
      panelDir: '/panel',
      currentDir: '/release',
      stateDir: '/state',
      migrationStateDir: '/state/data/migrations',
      releaseLockFile: '/state/data/migrations/release-update.lock',
      sitesBasePath: '/var/www',
      nodeEnv: 'production',
    },
    dryRun: false,
  };
  return { ctx, files, commands, writes, source };
}

test('Adminer HTTP handoff migration plans and synchronizes the dual-cookie runtime', async () => {
  const state = fixture();
  assert.deepEqual(await migration.preflight(state.ctx), { ok: true });
  const plan = await migration.plan(state.ctx);
  assert.equal(plan.details.runtimeNeedsSync, true);
  assert.deepEqual(plan.details.phpVersions, ['8.4']);

  await migration.up(state.ctx);
  assert.equal(state.files.get(RUNTIME_PATH), state.source);
  assert.deepEqual(state.writes, [[RUNTIME_PATH, 0o640]]);
  assert.equal(
    state.commands.some(([command, args]) =>
      command === 'systemctl' && args.join(' ') === 'restart php8.4-fpm.service'),
    true,
  );

  await migration.up(state.ctx);
  assert.deepEqual(state.writes, [[RUNTIME_PATH, 0o640]]);
  assert.equal(
    state.commands.filter(([command]) => command === 'systemctl').length,
    2,
  );
});

test('Adminer HTTP handoff migration rejects a source without both cookie transports', async () => {
  const state = fixture("<?php const MEOWBOX_SECURE_COOKIE_NAME = '__Secure-meowbox_adminer_session';");
  assert.deepEqual(await migration.preflight(state.ctx), {
    ok: false,
    reason: 'Adminer HTTP handoff source lacks the dual-cookie contract',
  });
  await assert.rejects(
    migration.plan(state.ctx),
    /lacks the dual-cookie contract/,
  );
});
