'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveDeployRuntime } = require('../src/deploy/deploy-runtime');

test('deploy runtime resolves supported domain presets', () => {
  assert.equal(resolveDeployRuntime('MODX_REVO', null), 'php');
  assert.equal(resolveDeployRuntime('MODX_3', undefined), 'php');
  assert.equal(resolveDeployRuntime('CUSTOM', null), 'files');
  assert.equal(resolveDeployRuntime('CUSTOM', 3000), 'node');
});

test('deploy runtime rejects stale presets and invalid internal ports', () => {
  for (const preset of ['NUXT_3', 'REACT', 'NESTJS', 'STATIC_HTML', '']) {
    assert.throws(
      () => resolveDeployRuntime(preset, null),
      /Unsupported application preset/,
    );
  }
  for (const port of [0, -1, 65_536, 3000.5, '3000']) {
    assert.throws(
      () => resolveDeployRuntime('CUSTOM', port),
      /Invalid Node\.js app port/,
    );
  }
  assert.throws(
    () => resolveDeployRuntime('MODX_REVO', 3000),
    /cannot have a Node\.js app port/,
  );
});
