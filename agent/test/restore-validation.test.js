'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeRestoreIncludePaths,
} = require('../../shared/src/backup-restore');

test('selective restore paths cannot collapse invalid input into full restore', () => {
  assert.deepEqual(
    normalizeRestoreIncludePaths(['./public/index.php', 'storage/logs/']),
    ['public/index.php', 'storage/logs'],
  );
  assert.deepEqual(
    normalizeRestoreIncludePaths(['public/index.php', 'public/index.php']),
    ['public/index.php'],
  );

  for (const invalid of [
    [''],
    ['.'],
    ['/etc/passwd'],
    ['../outside'],
    ['public/../outside'],
    ['public//index.php'],
    ['C:\\Windows'],
    ['public\0index.php'],
  ]) {
    assert.throws(
      () => normalizeRestoreIncludePaths(invalid),
      /Invalid restore include path/,
    );
  }
});

test('selective restore path count and length are bounded', () => {
  assert.throws(
    () =>
      normalizeRestoreIncludePaths(
        Array.from({ length: 201 }, (_, index) => `path-${index}`),
      ),
    /Invalid restore include paths/,
  );
  assert.throws(
    () => normalizeRestoreIncludePaths(['x'.repeat(4097)]),
    /Invalid restore include path/,
  );
});
