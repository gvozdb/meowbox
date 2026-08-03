'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const webRoot = path.resolve(__dirname, '..');
const databasePage = fs.readFileSync(
  path.join(webRoot, 'pages', 'databases.vue'),
  'utf8',
);

test('database catalog reads globally and mutates through domain-scoped routes', () => {
  assert.match(databasePage, /api\.get<DbItem\[]>\(`\/databases/);
  assert.match(
    databasePage,
    /`\/sites\/\$\{db\.siteId\}\/domains\/\$\{db\.siteDomainId\}\/databases\/\$\{db\.id\}`/,
  );
  assert.doesNotMatch(databasePage, /api\.(?:post|del|upload)\([^\n]*`\/databases/);
});

test('database creation requires an explicit site application', () => {
  assert.match(databasePage, /v-model="createForm\.siteId"/);
  assert.match(databasePage, /v-model="createForm\.domainId"/);
  assert.match(
    databasePage,
    /`\/sites\/\$\{createForm\.siteId\}\/domains\/\$\{createForm\.domainId\}\/databases`/,
  );
  assert.match(databasePage, /!createForm\.siteId \|\| !createForm\.domainId/);
});
