'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ProxyController,
  shouldAuditProxyRequest,
} = require('../src/proxy/proxy.controller');

function requestFor(method, path) {
  return {
    method,
    path: `/proxy/remote${path}`,
    originalUrl: `/api/proxy/remote${path}`,
    url: `/proxy/remote${path}`,
    headers: {},
    ip: '127.0.0.1',
    body: undefined,
  };
}

function responseRecorder() {
  return {
    statusCode: null,
    ended: false,
    payload: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = String(value);
    },
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    end() {
      this.ended = true;
    },
    json(payload) {
      this.payload = payload;
    },
  };
}

test('current and legacy dashboard proxy reads are excluded from DB audit', async () => {
  const dashboardPaths = [
    '/dashboard/overview',
    '/dashboard/summary',
    '/system/metrics',
    '/sites',
  ];
  for (const path of dashboardPaths) {
    assert.equal(shouldAuditProxyRequest('GET', path), false);
    assert.equal(shouldAuditProxyRequest('HEAD', path), false);
  }
  assert.equal(shouldAuditProxyRequest('POST', '/dashboard/overview'), true);
  assert.equal(shouldAuditProxyRequest('GET', '/sites/site-1'), true);

  const auditCalls = [];
  const proxy = {
    getServer: () => ({ id: 'remote', name: 'Remote', url: 'https://example.test', token: 'hidden' }),
    proxyRaw: async (_server, _method, path) => new Response(null, {
      status: path === '/dashboard/overview' ? 200 : 204,
      headers: path === '/dashboard/overview'
        ? { 'X-Dashboard-Contract': '1' }
        : undefined,
    }),
  };
  const controller = new ProxyController(proxy, {}, {
    logOut: async (entry) => auditCalls.push(entry),
  });

  for (const path of dashboardPaths) {
    const response = responseRecorder();
    await controller.proxyRequest(
      'remote',
      requestFor('GET', path),
      response,
      { id: 'admin-1', role: 'ADMIN' },
    );
    assert.equal(response.statusCode, path === '/dashboard/overview' ? 200 : 204);
    assert.equal(response.ended, true);
    if (path === '/dashboard/overview') {
      assert.equal(response.headers['x-dashboard-contract'], '1');
    }
  }
  assert.equal(auditCalls.length, 0);

  await controller.proxyRequest(
    'remote',
    requestFor('GET', '/sites/site-1'),
    responseRecorder(),
    { id: 'admin-1', role: 'ADMIN' },
  );
  assert.equal(auditCalls.length, 1);
});

test('dashboard proxy read failure stays side-effect free', async () => {
  const auditCalls = [];
  const controller = new ProxyController({
    getServer: () => ({ id: 'remote', name: 'Remote', url: 'https://example.test', token: 'hidden' }),
    proxyRaw: async () => { throw new Error('offline'); },
  }, {}, {
    logOut: async (entry) => auditCalls.push(entry),
  });
  const response = responseRecorder();

  await controller.proxyRequest(
    'remote',
    requestFor('GET', '/dashboard/overview'),
    response,
    { id: 'admin-1', role: 'ADMIN' },
  );

  assert.equal(response.statusCode, 502);
  assert.equal(response.payload.error.code, 'PROXY_UPSTREAM_FAILED');
  assert.equal(auditCalls.length, 0);
});
