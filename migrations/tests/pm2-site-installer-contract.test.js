'use strict';

const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const test = require('node:test');

const installer = resolve(__dirname, '..', '..', 'install.sh');

test('fresh installer provisions the shared PM2 site autostart template', async () => {
  const content = await readFile(installer, 'utf8');
  const baseline = content.indexOf('baseline-fresh-install --fresh-install');
  const template = content.indexOf('PM2_SITE_UNIT_PATH="/etc/systemd/system/pm2@.service"');
  const reload = content.indexOf('systemctl daemon-reload', template);

  assert.ok(baseline >= 0, 'fresh-install baseline command must exist');
  assert.ok(template > baseline, 'PM2 site template must be provisioned after fresh-install baseline');
  assert.match(content.slice(template), /pm2SiteAutostartUnitContent/);
  assert.ok(reload > template, 'systemd must reload after template provisioning');
});
