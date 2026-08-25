'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { SslManager } = require('../src/ssl/ssl.manager');

test('T-OPS-005 SSL manager rejects path-like and incomplete domain sets before spawning certbot', async () => {
  const manager = new SslManager();
  const traversal = await manager.issueCertificate({
    domain: '../example.test',
    domains: ['../example.test'],
  });
  assert.equal(traversal.success, false);
  assert.match(traversal.error, /Invalid SSL certificate domain set/);

  const missingPrimary = await manager.issueCertificate({
    domain: 'example.test',
    domains: ['www.example.test'],
  });
  assert.equal(missingPrimary.success, false);
  assert.match(missingPrimary.error, /Invalid SSL certificate domain set/);

  const invalidRevoke = await manager.revokeCertificate('../example.test');
  assert.equal(invalidRevoke.success, false);
  assert.match(invalidRevoke.error, /Invalid domain name/);
});
