'use strict';

const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const {
  __adminerHandoffRuntimeTest: helpers,
} = require('../dist/system/2026-08-24-003-adminer-handoff-v2-runtime');

test('SYS-02 Adminer Nginx hardening patch is exact and idempotent', () => {
  const initial = [
    'server {',
    '    location ^~ /adminer/ {',
    '        add_header X-Robots-Tag "noindex,nofollow" always;',
    '        add_header X-Frame-Options "SAMEORIGIN" always;',
    '        try_files $uri $uri/ /adminer/index.php?$args;',
    '        location ~ ^/adminer/(index|sso|adminer)\\.php$ {',
    '        }',
    '    }',
    '    # Web UI (Nuxt)',
    '    location / {}',
    '}',
    '',
  ].join('\n');
  const first = helpers.patchNginxAdminerHeaders(initial);
  const second = helpers.patchNginxAdminerHeaders(first);
  assert.equal(second, first);
  assert.equal((first.match(/Referrer-Policy "no-referrer"/g) || []).length, 1);
  assert.equal((first.match(/Cache-Control "no-store"/g) || []).length, 1);
  assert.match(first, /location = \/adminer\/adminer\.php \{/);
  assert.match(first, /location ~ \^\/adminer\/\(index\|sso\)\\\.php\$/);
  assert.doesNotMatch(first, /index\|sso\|adminer/);
  assert.throws(
    () => helpers.patchNginxAdminerHeaders('server {}\n'),
    /Adminer location is missing/,
  );
});

test('SYS-02 Adminer PHP-FPM key/open_basedir sync is idempotent and fail-closed', () => {
  const key = Buffer.alloc(32, 0x42).toString('base64');
  const initial = [
    '[meowbox-adminer]',
    'php_admin_value[open_basedir] = /state/adminer:/tmp',
    'env[ADMINER_SSO_KEY] = "stale"',
    'clear_env = yes',
    '',
  ].join('\n');
  const first = helpers.syncPoolContent(initial, '/state/.env', key);
  const second = helpers.syncPoolContent(first, '/state/.env', key);
  assert.equal(second, first);
  assert.match(first, new RegExp(`^env\\[ADMINER_SSO_KEY\\] = "${key}"$`, 'm'));
  assert.match(first, /^clear_env = no$/m);
  assert.match(first, /^php_admin_value\[open_basedir\] = \/state\/adminer:\/tmp:\/state\/\.env$/m);
  assert.throws(
    () => helpers.syncPoolContent('[meowbox-adminer]\nclear_env = no\n', '/state/.env', key),
    /lacks open_basedir/,
  );
});

test('SYS-02 installer, Panel Access, PHP source, and Prisma migration carry v2 contract', async () => {
  const root = path.resolve(__dirname, '..', '..');
  const [installer, panelAccess, phpSession, legacy, sql] = await Promise.all([
    readFile(path.join(root, 'install.sh'), 'utf8'),
    readFile(path.join(root, 'agent/src/panel-access/panel-access.manager.ts'), 'utf8'),
    readFile(path.join(root, 'tools/adminer-src/lib/sso.php'), 'utf8'),
    readFile(path.join(root, 'tools/adminer-src/sso.php'), 'utf8'),
    readFile(path.join(root, 'api/prisma/migrations/20260824205213_adminer_handoff/migration.sql'), 'utf8'),
  ]);
  for (const template of [installer, panelAccess]) {
    assert.match(template, /add_header Referrer-Policy "no-referrer" always;/);
    assert.match(template, /add_header Cache-Control "no-store" always;/);
    assert.match(template, /location = \/adminer\/adminer\.php/);
    assert.doesNotMatch(template, /index\|sso\|adminer/);
  }
  assert.match(phpSession, /__Secure-meowbox_adminer_session/);
  assert.match(phpSession, /MEOWBOX-ADMINER-SESSION-V2/);
  assert.match(legacy, /http_response_code\(410\)/);
  assert.match(sql, /CREATE TABLE "adminer_handoffs"/);
  assert.match(sql, /CREATE UNIQUE INDEX "adminer_handoffs_secret_hash_key"/);
});
