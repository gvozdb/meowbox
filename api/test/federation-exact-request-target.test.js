'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ExactRequestTargetError,
  parseExactFederationTarget,
} = require('../src/federation/exact-request-target');

const SERVER_ID = '11111111-2222-4333-8444-555555555555';

test('exact target preserves query order, duplicates, empties, plus and escape form', () => {
  const inbound = `/api/proxy/${SERVER_ID}/sites/a%2Db?x=1&x=&plus=a+b&escaped=%2b&bare`;
  assert.deepEqual(parseExactFederationTarget(inbound, SERVER_ID), {
    serverId: SERVER_ID,
    inboundTarget: inbound,
    rawSuffix: 'sites/a%2Db?x=1&x=&plus=a+b&escaped=%2b&bare',
    rawPath: '/api/sites/a%2Db',
    rawQuery: 'x=1&x=&plus=a+b&escaped=%2b&bare',
    targetPathAndQuery: '/api/sites/a%2Db?x=1&x=&plus=a+b&escaped=%2b&bare',
  });
});

test('exact target rejects ambiguous and unsafe paths', () => {
  for (const suffix of [
    'sites//x',
    'sites\\x',
    'sites/%2Fx',
    'sites/%5cx',
    'sites/.',
    'sites/..',
    'sites/%2e',
    'sites/%2E%2e',
    'sites/%',
    'sites/%zz',
    'sites/%c0%af',
    'sites/%00',
    'sites/%1f',
    'sites/%7f',
  ]) {
    assert.throws(
      () => parseExactFederationTarget(`/api/proxy/${SERVER_ID}/${suffix}`, SERVER_ID),
      ExactRequestTargetError,
      suffix,
    );
  }
});

test('exact target rejects wrong server, fragments, bare query and non-ASCII', () => {
  const cases = [
    `/api/proxy/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/sites`,
    `/api/proxy/${SERVER_ID}/sites#fragment`,
    `/api/proxy/${SERVER_ID}/sites?`,
    `/api/proxy/${SERVER_ID}/сайты`,
    `/api/proxy/${SERVER_ID}/`,
  ];
  for (const inbound of cases) {
    assert.throws(
      () => parseExactFederationTarget(inbound, SERVER_ID),
      ExactRequestTargetError,
      inbound,
    );
  }
  assert.throws(
    () => parseExactFederationTarget(`/api/proxy/${SERVER_ID}/sites`, 'REMOTE'),
    (error) => error?.code === 'INVALID_SERVER_ID',
  );
});

test('exact target enforces independent path, query and total limits', () => {
  assert.throws(
    () => parseExactFederationTarget(
      `/api/proxy/${SERVER_ID}/sites`,
      SERVER_ID,
      { maxPathBytes: 4 },
    ),
    (error) => error?.code === 'REQUEST_TARGET_TOO_LARGE',
  );
  assert.throws(
    () => parseExactFederationTarget(
      `/api/proxy/${SERVER_ID}/sites?abcdef`,
      SERVER_ID,
      { maxQueryBytes: 5 },
    ),
    (error) => error?.code === 'REQUEST_TARGET_TOO_LARGE',
  );
  assert.throws(
    () => parseExactFederationTarget(
      `/api/proxy/${SERVER_ID}/sites`,
      SERVER_ID,
      { maxTargetBytes: 10 },
    ),
    (error) => error?.code === 'REQUEST_TARGET_TOO_LARGE',
  );
});
