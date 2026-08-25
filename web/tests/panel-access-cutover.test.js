'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('T-PA-001 remote Panel Access uses master-coordinated candidate cutover', () => {
  const page = read('pages/settings.vue');
  assert.match(page, /useMasterApi\(\)/);
  assert.match(page, /\/servers\/\$\{serverId\}\/panel-access\/cutovers/);
  assert.match(page, /probePanelAccessCandidate\(view\.candidateOrigin\)/);
  assert.match(page, /confirm-browser/);
  assert.match(page, /serverStore\.loadServers\(\)/);
  assert.match(page, /serverStore\.refreshCurrentRemoteContext\(\)/);
  assert.match(page, /Прямой target origin/);
});

test('T-PA-002 browser probe is direct, credentialless, bounded, and target-relative', () => {
  const helper = read('utils/panel-access-cutover.ts');
  assert.match(helper, /method: 'HEAD'/);
  assert.match(helper, /mode: 'no-cors'/);
  assert.match(helper, /credentials: 'omit'/);
  assert.match(helper, /redirect: 'error'/);
  assert.match(helper, /referrerPolicy: 'no-referrer'/);
  assert.match(helper, /\/api\/federation\/v1\/health/);
  assert.doesNotMatch(helper, /window\.location/);
});

test('T-PA-003 unsafe remote certificate shortcuts stay disabled', () => {
  const page = read('pages/settings.vue');
  assert.match(page, /Legacy target не поддерживает безопасный Panel Access cutover/);
  assert.match(page, /Нельзя снять TLS с активного federation endpoint/);
  assert.match(page, /Self-signed для удалённого federation endpoint не поддерживается/);
  assert.match(page, /accessCutoverPending/);
  assert.match(page, /rollbackAccessCutover/);
  assert.match(page, /Idempotency-Key/);
  assert.doesNotMatch(page, /window\.location\.protocol\/\/\$\{window\.location\.host\}/);
});
