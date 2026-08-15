'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { XrayManager } = require('../src/vpn/xray.manager');

test('Xray rejects a reserved web TCP port before touching the host', async () => {
  const calls = [];
  const manager = new XrayManager({
    execute: async (...args) => {
      calls.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  await assert.rejects(
    manager.install({
      serviceId: '11111111-1111-4111-8111-111111111111',
      port: 443,
      sniMask: 'www.google.com',
    }),
    /зарезервирован/,
  );
  assert.deepEqual(calls, []);
});
