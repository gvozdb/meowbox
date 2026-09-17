'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildVerifyCurlArgs } = require('../src/migration/hostpanel/run-item');

const common = {
  domain: 'new.example.test',
  slaveIp: '203.0.113.10',
};

test('Hostpanel verify targets HTTP on port 80 without transferred SSL', () => {
  assert.deepEqual(
    buildVerifyCurlArgs({ ...common, sslTransferred: false }),
    [
      '-sk', '-o', '/dev/null',
      '-w', '%{http_code}',
      '--resolve', 'new.example.test:80:203.0.113.10',
      '-I', 'http://new.example.test/',
      '--max-time', '15',
    ],
  );
});

test('Hostpanel verify targets HTTPS on port 443 with transferred SSL', () => {
  assert.deepEqual(
    buildVerifyCurlArgs({ ...common, sslTransferred: true }),
    [
      '-sk', '-o', '/dev/null',
      '-w', '%{http_code}',
      '--resolve', 'new.example.test:443:203.0.113.10',
      '-I', 'https://new.example.test/',
      '--max-time', '15',
    ],
  );
});
