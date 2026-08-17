'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PM2_SITE_AUTOSTART_UNIT_PATH,
  pm2SiteAutostartUnitContent,
} = require('@meowbox/shared');
const {
  createPm2SiteAutostartTemplateMigration,
} = require('../dist/system/2026-08-17-002-repair-pm2-site-autostart-template');

function fixture({ unit = null, pm2 = '/usr/local/bin/pm2', systemctl = true, dryRun = false } = {}) {
  const files = new Map();
  if (unit !== null) files.set(PM2_SITE_AUTOSTART_UNIT_PATH, unit);
  if (pm2) files.set(pm2, 'binary');
  if (systemctl) files.set('/usr/bin/systemctl', 'binary');
  const calls = [];
  const writes = [];
  const logs = [];
  return {
    calls,
    writes,
    logs,
    ctx: {
      dryRun,
      config: { sitesBasePath: '/var/www' },
      log: (message) => logs.push(message),
      exists: async (file) => files.has(file),
      readFile: async (file) => files.get(file),
      writeFile: async (file, content, mode) => {
        writes.push({ file, content, mode });
        files.set(file, content);
      },
      exec: {
        run: async (command, args) => {
          calls.push([command, args]);
          if (command === 'which' && args[0] === 'systemctl' && !systemctl) {
            throw new Error('missing systemctl');
          }
          if (command === 'which' && args[0] === 'pm2' && !pm2) {
            throw new Error('missing pm2');
          }
          return { stdout: command === 'which' && args[0] === 'pm2' ? `${pm2}\n` : '', stderr: '' };
        },
      },
    },
  };
}

test('migration installs the missing PM2 site unit and reloads systemd once', async () => {
  const data = fixture();
  const migration = createPm2SiteAutostartTemplateMigration();

  const plan = await migration.plan(data.ctx);
  assert.equal(plan.details.unit, 'missing');
  assert.equal(plan.details.pm2Bin, '/usr/local/bin/pm2');
  assert.deepEqual(data.calls, []);

  await migration.up(data.ctx);

  assert.deepEqual(data.writes, [{
    file: PM2_SITE_AUTOSTART_UNIT_PATH,
    content: pm2SiteAutostartUnitContent('/usr/local/bin/pm2', '/var/www'),
    mode: 0o644,
  }]);
  assert.deepEqual(
    data.calls.filter(([command]) => command === 'systemctl'),
    [['systemctl', ['daemon-reload']]],
  );

  await migration.up(data.ctx);
  assert.equal(data.writes.length, 1);
  assert.equal(data.calls.filter(([command]) => command === 'systemctl').length, 1);
});

test('migration replaces drifted unit, but leaves a current unit untouched', async () => {
  const drifted = fixture({ unit: 'old unit\n' });
  const current = fixture({ unit: pm2SiteAutostartUnitContent('/usr/local/bin/pm2', '/var/www') });
  const migration = createPm2SiteAutostartTemplateMigration();

  await migration.up(drifted.ctx);
  await migration.up(current.ctx);

  assert.equal(drifted.writes.length, 1);
  assert.equal(current.writes.length, 0);
  assert.equal(current.calls.some(([command]) => command === 'systemctl'), false);
});

test('migration fails closed when PM2 or systemd is unavailable', async () => {
  const noPm2 = fixture({ pm2: null });
  const noSystemctl = fixture({ systemctl: false });
  const migration = createPm2SiteAutostartTemplateMigration();

  await migration.up(noPm2.ctx);
  await migration.up(noSystemctl.ctx);

  assert.deepEqual(noPm2.writes, []);
  assert.deepEqual(noSystemctl.writes, []);
  assert.equal(noPm2.logs.some((line) => line.includes('PM2 binary is unavailable')), true);
  assert.equal(noSystemctl.logs.some((line) => line.includes('systemctl is unavailable')), true);
});

test('dry run plans the unit without writes or systemd reload', async () => {
  const data = fixture({ dryRun: true });
  const migration = createPm2SiteAutostartTemplateMigration();

  await migration.up(data.ctx);

  assert.deepEqual(data.writes, []);
  assert.equal(data.calls.some(([command]) => command === 'systemctl'), false);
});

test('unit renderer rejects unsafe executable and site paths', () => {
  assert.throws(
    () => pm2SiteAutostartUnitContent('/usr/bin/pm2\nExecStart=/bin/sh', '/var/www'),
    /Invalid PM2 binary path/,
  );
  assert.throws(
    () => pm2SiteAutostartUnitContent('/usr/bin/pm2', '/var/www bad'),
    /Invalid sites base path/,
  );
});
