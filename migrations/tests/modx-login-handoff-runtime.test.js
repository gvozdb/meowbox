'use strict';

const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const {
  __modxHandoffRuntimeTest: helpers,
} = require('../dist/system/2026-08-25-003-modx-login-handoff-runtime');

test('SYS-03 MODX handoff Nginx route is bounded, no-log, and idempotent', () => {
  const initial = [
    'server {',
    '    # API proxy',
    '    location /api/ {',
    '        proxy_pass http://meowbox_api;',
    '    }',
    '}',
    '',
  ].join('\n');
  const first = helpers.patchPanelNginx(initial);
  assert.equal(helpers.patchPanelNginx(first), first);
  assert.match(first, /location \^~ \/api\/public\/v1\/modx\/login/);
  assert.match(first, /client_max_body_size 4k;/);
  assert.match(first, /proxy_request_buffering on;/);
  assert.match(first, /proxy_connect_timeout 5s;/);
  assert.match(first, /proxy_read_timeout 15s;/);
  assert.match(first, /access_log off;/);
  assert.match(first, /error_log \/dev\/null crit;/);
  assert.throws(() => helpers.patchPanelNginx('server {}\n'), /anchor is missing/);
});

test('SYS-03 installer and Panel Access templates include identical MODX safety contract', async () => {
  const root = path.resolve(__dirname, '..', '..');
  const [installer, panelAccess] = await Promise.all([
    readFile(path.join(root, 'install.sh'), 'utf8'),
    readFile(path.join(root, 'agent/src/panel-access/panel-access.manager.ts'), 'utf8'),
  ]);
  for (const template of [installer, panelAccess]) {
    assert.match(template, /location \^~ \/api\/public\/v1\/modx\/login/);
    assert.match(template, /client_max_body_size 4k;/);
    assert.match(template, /proxy_request_buffering on;/);
    assert.match(template, /access_log off;/);
    assert.match(template, /error_log \/dev\/null crit;/);
  }
});
