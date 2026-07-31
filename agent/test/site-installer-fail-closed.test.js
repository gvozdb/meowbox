'use strict';

const assert = require('node:assert/strict');
const {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SiteInstaller } = require('../src/installer/site-installer');

function modxParams(rootPath) {
  return {
    rootPath,
    filesRelPath: 'www',
    domain: 'example.test',
    phpVersion: '8.2',
    dbName: 'example_db',
    dbUser: 'example_user',
    dbPassword: 'not-a-real-secret',
    dbType: 'MARIADB',
  };
}

test('MODX download failure is reported instead of creating a stub', async () => {
  const installer = new SiteInstaller();
  const commands = [];
  installer.executor = {
    execute: async (command) => {
      commands.push(command);
      return command === 'curl'
        ? { exitCode: 22, stdout: '', stderr: 'download failed' }
        : { exitCode: 0, stdout: '', stderr: '' };
    },
  };

  const result = await installer.installModxRevo(
    modxParams('/tmp/meowbox-installer-fail-closed'),
  );

  assert.equal(result.success, false);
  assert.match(result.error, /download failed/i);
  assert.deepEqual(commands, ['mkdir', 'curl']);
});

test('CUSTOM scaffold never overwrites a raced existing index', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'meowbox-custom-scaffold-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const www = path.join(root, 'www');
  mkdirSync(www);
  writeFileSync(path.join(www, 'index.html'), 'operator content', 'utf8');

  const installer = new SiteInstaller();
  installer.executor = {
    execute: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  };

  const result = await installer.scaffoldCustomSite(
    root,
    'example.test',
    undefined,
    'www-data',
    'www',
  );

  assert.equal(result.success, false);
  assert.equal(
    readFileSync(path.join(www, 'index.html'), 'utf8'),
    'operator content',
  );
});

test('MODX 3 fallback does not recursively delete application root', async () => {
  const installer = new SiteInstaller();
  const commands = [];
  installer.resolveComposerPath = async () => '/usr/local/bin/composer';
  installer.executor = {
    execute: async (command) => {
      commands.push(command);
      if (command === 'curl') {
        return { exitCode: 22, stdout: '', stderr: 'download failed' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    executeStreaming: async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'composer failed',
    }),
  };

  const result = await installer.installModx3(
    modxParams('/tmp/meowbox-installer-no-rm'),
  );

  assert.equal(result.success, false);
  assert.equal(commands.includes('rm'), false);
});
