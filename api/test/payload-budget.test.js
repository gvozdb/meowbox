'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  declaredContentLength,
  requestBodyBudget,
} = require('../src/common/http/payload-budget');

const uploadRequest = {
  method: 'PUT',
  url: '/api/public/v1/transfers/11111111-2222-4333-8444-555555555555/upload?secret=opaque',
  headers: { 'content-type': 'application/octet-stream' },
};

test('T-XFER-002 only the exact direct upload route receives the artifact body budget', () => {
  const env = {
    TRANSFER_MAX_ARTIFACT_BYTES: '53687091200',
    API_JSON_LIMIT_MB: '7',
    API_UPLOAD_LIMIT_MB: '99',
  };
  assert.equal(requestBodyBudget(uploadRequest, env), 53_687_091_200);
  assert.equal(requestBodyBudget({ ...uploadRequest, method: 'POST' }, env), 7 * 1024 ** 2);
  assert.equal(requestBodyBudget({
    ...uploadRequest,
    headers: { 'content-type': 'application/json' },
  }, env), 7 * 1024 ** 2);
  assert.equal(requestBodyBudget({
    ...uploadRequest,
    url: '/api/public/v1/transfers/not-a-uuid/upload',
  }, env), 7 * 1024 ** 2);
  assert.equal(requestBodyBudget({
    ...uploadRequest,
    url: '/api/proxy/target/suffix',
  }, env), 1024 ** 2);
});

test('T-XFER-002 payload admission parses Content-Length without prefix coercion', () => {
  assert.equal(declaredContentLength('53687091200'), 53_687_091_200n);
  assert.equal(declaredContentLength('0'), 0n);
  for (const invalid of [undefined, '', '01', '1x', '-1', ['1', '1']]) {
    assert.equal(declaredContentLength(invalid), null);
  }
});

test('T-XFER-002 main keeps direct uploads streaming outside JSON parsers', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf8');
  assert.match(source, /bodyParser: false/);
  assert.match(source, /requestBodyBudget\(req\)/);
  assert.match(source, /contentLength > BigInt\(maxSize\)/);
  assert.doesNotMatch(source, /express\.raw\([\s\S]*public\/v1\/transfers/);
});
