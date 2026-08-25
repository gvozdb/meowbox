'use strict';

const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..', '..');

test('dev deployment aborts when system migrations fail', async () => {
  const source = await readFile(path.join(projectRoot, 'tools', 'dev.sh'), 'utf8');
  assert.match(source, /export PATH="\/usr\/local\/sbin:\/usr\/sbin:\/sbin:/);
  assert.match(source, /node dist\/runner\.js up\) \\\n+\s*\|\| abort "system migrations failed"/);
  assert.doesNotMatch(source, /system migrations[^\n]*\|\| say/);
});
