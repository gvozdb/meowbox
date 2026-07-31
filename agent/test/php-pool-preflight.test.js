'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildPhpPoolPreflightPlan,
} = require('../src/php/pool-preflight');

function pool(overrides = {}) {
  return {
    siteName: 'transfer-target',
    domainId: '20000000-0000-4000-8000-000000000001',
    domain: 'example.test',
    phpVersion: '8.2',
    runtimeKey: 'transfer-primary',
    user: 'transfer-target',
    rootPath: '/var/www/transfer-target',
    filesRelPath: 'www',
    customConfig: 'pm.max_children = 4',
    ...overrides,
  };
}

test('PHP transfer preflight renders deterministic unique identities', () => {
  const plan = buildPhpPoolPreflightPlan([
    pool(),
    pool({
      domainId: '20000000-0000-4000-8000-000000000002',
      domain: 'api.example.test',
      phpVersion: '8.3',
      runtimeKey: 'transfer-api',
      filesRelPath: 'api',
    }),
  ]);

  assert.deepEqual(plan.phpVersions, ['8.2', '8.3']);
  assert.equal(plan.pools.length, 2);
  assert.notEqual(plan.pools[0].poolFile, plan.pools[1].poolFile);
  assert.notEqual(
    plan.pools[0].runtime.socketPath,
    plan.pools[1].runtime.socketPath,
  );
});

test('PHP transfer preflight rejects runtime, path and config conflicts', () => {
  assert.throws(
    () =>
      buildPhpPoolPreflightPlan([
        pool(),
        pool({
          domainId: '20000000-0000-4000-8000-000000000002',
          domain: 'api.example.test',
          runtimeKey: 'transfer-primary',
        }),
      ]),
    /Duplicate runtimeKey/,
  );
  assert.throws(
    () =>
      buildPhpPoolPreflightPlan([
        pool({ filesRelPath: '../escape' }),
      ]),
    /must not contain "\.\."/,
  );
  assert.throws(
    () =>
      buildPhpPoolPreflightPlan([
        pool({ customConfig: 'listen = /tmp/attacker.sock' }),
      ]),
    /cannot override listen/,
  );
});
