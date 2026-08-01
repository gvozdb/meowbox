'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  collectDeclaredRateLimitZones,
  collectReferencedRateLimitZones,
  mergeRateLimitZones,
} = require('../dist/system/_rate-limit-zones');
const {
  createRateLimitZonesMigration,
} = require('../dist/system/2026-04-30-002-rate-limit-zones-bootstrap');

function makeContext(run) {
  return {
    prisma: {},
    exec: { run, runShell: async () => ({ stdout: '', stderr: '' }) },
    exists: async () => true,
    readFile: (file) => fs.promises.readFile(file, 'utf8'),
    writeFile: async (file, content, mode) => {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, content, { encoding: 'utf8', mode });
    },
    checkpoints: {
      read: async () => null,
      write: async () => {},
      remove: async () => {},
      pathFor: () => '',
    },
    log: () => {},
    config: {
      panelDir: '',
      currentDir: '',
      stateDir: '',
      migrationStateDir: '',
      releaseLockFile: '',
      sitesBasePath: '',
      nodeEnv: 'production',
    },
    dryRun: false,
  };
}

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-zones-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const confDir = path.join(root, 'conf.d');
  const sitesDir = path.join(root, 'sites-enabled');
  const zonesPath = path.join(confDir, 'meowbox-zones.conf');
  fs.mkdirSync(confDir, { recursive: true });
  fs.mkdirSync(sitesDir, { recursive: true });
  return {
    zonesPath,
    sitesDir,
    paths: {
      zonesPath,
      configRoots: [confDir, sitesDir],
      nginxBinary: '/fixture/nginx',
      systemctlBinary: '/fixture/systemctl',
    },
  };
}

test('preserves current mb zones and appends only missing referenced zones', () => {
  const current = [
    '# managed',
    'limit_req_zone $binary_remote_addr zone=site_limit:10m rate=30r/s;',
    'limit_req_zone $binary_remote_addr zone=mb_existing:2m rate=17r/s;',
    '',
  ].join('\n');

  const result = mergeRateLimitZones(current, ['mb_existing', 'mb_missing']);

  assert.match(result.content, /zone=mb_existing:2m rate=17r\/s;/);
  assert.match(result.content, /zone=mb_missing:1m rate=30r\/s;/);
  assert.equal(result.content.match(/zone=mb_existing:/g)?.length, 1);
  assert.deepEqual(result.addedZones, ['mb_missing']);
});

test('does not duplicate a zone declared outside the managed zones file', () => {
  const result = mergeRateLimitZones(
    'limit_req_zone $binary_remote_addr zone=site_limit:10m rate=30r/s;\n',
    ['mb_external'],
    ['mb_external'],
  );

  assert.deepEqual(result.addedZones, []);
  assert.doesNotMatch(result.content, /zone=mb_external:/);
});

test('parsers ignore comments and merge is idempotent', () => {
  const config = [
    '# limit_req zone=mb_commented burst=10;',
    'limit_req zone=mb_active burst=10 nodelay;',
    'limit_req_zone $binary_remote_addr zone=mb_declared:1m rate=5r/s;',
    '# limit_req_zone $binary_remote_addr zone=mb_disabled:1m rate=5r/s;',
  ].join('\n');

  assert.deepEqual([...collectReferencedRateLimitZones(config)], ['mb_active']);
  assert.deepEqual([...collectDeclaredRateLimitZones(config)], ['mb_declared']);

  const first = mergeRateLimitZones(null, ['mb_active']);
  const second = mergeRateLimitZones(first.content, ['mb_active']);
  assert.equal(second.content, first.content);
  assert.deepEqual(second.addedZones, []);
});

test('migration keeps existing hashed zones and activates a merged config', async (t) => {
  const fixture = makeFixture(t);
  const original = [
    'limit_req_zone $binary_remote_addr zone=site_limit:10m rate=30r/s;',
    'limit_req_zone $binary_remote_addr zone=mb_existing:2m rate=17r/s;',
    '',
  ].join('\n');
  fs.writeFileSync(fixture.zonesPath, original);
  fs.writeFileSync(
    path.join(fixture.sitesDir, 'site.conf'),
    'limit_req zone=mb_existing burst=5;\nlimit_req zone=mb_missing burst=5;\n',
  );

  const calls = [];
  const ctx = makeContext(async (command, args) => {
    calls.push([command, args]);
    return { stdout: '', stderr: '' };
  });

  await createRateLimitZonesMigration(fixture.paths).up(ctx);

  const updated = fs.readFileSync(fixture.zonesPath, 'utf8');
  assert.match(updated, /zone=mb_existing:2m rate=17r\/s;/);
  assert.match(updated, /zone=mb_missing:1m rate=30r\/s;/);
  assert.deepEqual(calls, [
    ['/fixture/nginx', ['-t']],
    ['/fixture/nginx', ['-t']],
    ['/fixture/systemctl', ['reload', 'nginx']],
  ]);
});

test('migration restores the exact original file when activation fails', async (t) => {
  const fixture = makeFixture(t);
  const original =
    'limit_req_zone $binary_remote_addr zone=site_limit:10m rate=30r/s;\n';
  fs.writeFileSync(fixture.zonesPath, original);
  fs.writeFileSync(
    path.join(fixture.sitesDir, 'site.conf'),
    'limit_req zone=mb_missing burst=5;\n',
  );

  let nginxTests = 0;
  const ctx = makeContext(async (command) => {
    if (command === '/fixture/nginx') {
      nginxTests += 1;
      if (nginxTests === 2) throw new Error('fixture nginx validation failure');
    }
    return { stdout: '', stderr: '' };
  });

  await assert.rejects(
    createRateLimitZonesMigration(fixture.paths).up(ctx),
    /nginx activation failed.*исходный zones-файл восстановлен/,
  );
  assert.equal(fs.readFileSync(fixture.zonesPath, 'utf8'), original);
  assert.equal(nginxTests, 3);
});
