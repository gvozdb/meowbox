'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('database transfer mutations have one durable implementation', () => {
  const legacy = read('src/databases/databases.service.ts');
  const operations = read('src/databases/database-operations.service.ts');
  assert.doesNotMatch(legacy, /async exportDatabase\(/);
  assert.doesNotMatch(legacy, /async importDatabase\(/);
  assert.doesNotMatch(legacy, /async importUpload\(/);
  assert.doesNotMatch(legacy, /runDatabaseImport\(/);
  assert.match(operations, /DATABASE_EXPORT_ACTION = 'database\.export\.stage'/);
  assert.match(operations, /DATABASE_IMPORT_ACTION = 'database\.import'/);
  assert.match(operations, /restoreDatabaseSnapshot/);
  assert.match(operations, /OperationNeedsAttentionError/);
});
