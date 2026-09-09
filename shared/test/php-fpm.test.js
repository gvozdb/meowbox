'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  isMeowboxManagedPhpFpmDirective,
  sanitizeMigratedPhpFpmCustomConfig,
} = require('../dist');

test('hostPanel migration removes source-bound PHP-FPM paths only', () => {
  const custom = [
    'php_admin_value[upload_tmp_dir] = /var/www/legacy/tmp',
    'php_value[session.save_path] = /var/www/legacy/sessions',
    'PHP_ADMIN_VALUE[ERROR_LOG] = /var/www/legacy/log/php.log',
    'php_admin_value[disable_functions] = exec,passthru',
    'php_value[max_execution_time] = 240',
    'env[APP_ENV] = production',
    'listen = /tmp/unsafe.sock',
  ].join('\n');

  assert.equal(
    sanitizeMigratedPhpFpmCustomConfig(custom),
    [
      'php_admin_value[disable_functions] = exec,passthru',
      'php_value[max_execution_time] = 240',
      'env[APP_ENV] = production',
      'listen = /tmp/unsafe.sock',
    ].join('\n'),
  );
});

test('managed PHP-FPM directive detection is exact and case-insensitive', () => {
  assert.equal(isMeowboxManagedPhpFpmDirective('php_admin_value[upload_tmp_dir]'), true);
  assert.equal(isMeowboxManagedPhpFpmDirective('PHP_VALUE[SESSION.SAVE_PATH]'), true);
  assert.equal(isMeowboxManagedPhpFpmDirective('php_value[upload_max_filesize]'), false);
  assert.equal(isMeowboxManagedPhpFpmDirective('env[upload_tmp_dir]'), false);
});
