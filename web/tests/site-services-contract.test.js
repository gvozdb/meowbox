'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const source = readFileSync(
  resolve(__dirname, '../components/SiteServicesTab.vue'),
  'utf8',
);

test('site service UI supports catalog hints and shared tenant services', () => {
  assert.match(source, /item\.catalog\.siteLifecycle !== false/);
  assert.match(source, /item\.catalog\.siteActivationHint/);
  assert.match(source, /item\.catalog\.siteDisableWarning/);
  assert.match(source, /item\.catalog\.icon === 'storage'/);
  assert.match(source, /\/sites\/\$\{props\.siteId\}\/services\/\$\{item\.key\}\/enable/);
  assert.match(source, /\/sites\/\$\{props\.siteId\}\/services\/\$\{item\.key\}/);
});
