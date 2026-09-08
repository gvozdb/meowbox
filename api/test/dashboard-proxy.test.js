'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ProxyController,
  shouldAuditProxyRequest,
} = require('../src/proxy/proxy.controller');
const {
  normalizeLegacyProxyTransportError,
} = require('../src/proxy/proxy.service');

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
  const controller = new ProxyController(proxy, {
    logOut: async (entry) => auditCalls.push(entry),
  }, {
    resolveRouteTarget: async () => ({ kind: 'LEGACY_STATIC_V0' }),
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

  const denied = responseRecorder();
  await controller.proxyRequest(
    'remote',
    requestFor('GET', '/sites/site-1'),
    denied,
    { id: 'admin-1', role: 'ADMIN' },
  );
  assert.equal(denied.statusCode, 426);
  assert.equal(auditCalls.length, 0);
});

test('dashboard proxy read failure stays side-effect free', async () => {
  const auditCalls = [];
  const controller = new ProxyController({
    getServer: () => ({ id: 'remote', name: 'Remote', url: 'https://example.test', token: 'hidden' }),
    proxyRaw: async () => { throw new Error('offline'); },
  }, {
    logOut: async (entry) => auditCalls.push(entry),
  }, {
    resolveRouteTarget: async () => ({ kind: 'LEGACY_STATIC_V0' }),
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

test('legacy TLS failures expose stable remediation codes without raw transport details', () => {
  const required = normalizeLegacyProxyTransportError({
    message: 'fetch failed',
    cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'internal TLS detail' },
  });
  assert.equal(required.code, 'LEGACY_TLS_PIN_REQUIRED');
  assert.equal(required.message, 'Self-signed TLS certificate requires automatic trust bootstrap');

  const mismatch = normalizeLegacyProxyTransportError(new Error('Peer SPKI pin mismatch'));
  assert.equal(mismatch.code, 'LEGACY_TLS_PIN_MISMATCH');
});

test('legacy self-signed TLS is bootstrapped once and retried with the pinned dispatcher', async (t) => {
  const service = new (require('../src/proxy/proxy.service').ProxyService)({}, {});
  const server = {
    id: 'remote',
    name: 'Remote',
    url: 'https://panel.example.test',
    token: 'hidden-token-value',
  };
  const trusted = { ...server, tlsCaCertificatePem: 'certificate' };
  let bootstrapCalls = 0;
  service.bindLegacySelfSignedTrust = async () => {
    bootstrapCalls += 1;
    return trusted;
  };
  service.getFetchDispatcher = (value) => value === trusted ? 'pinned' : 'strict';

  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async (_url, options) => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      throw {
        message: 'fetch failed',
        cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' },
      };
    }
    assert.equal(options.dispatcher, 'pinned');
    return new Response('{}', { status: 200 });
  };
  t.after(() => { global.fetch = originalFetch; });

  const response = await service.fetchLegacy(server, `${server.url}/api/sites`, {
    method: 'GET',
    dispatcher: 'strict',
  });
  assert.equal(response.status, 200);
  assert.equal(bootstrapCalls, 1);
  assert.equal(fetchCalls, 2);
});

test('proxy guard admits catalogued VIEWER reads while legacy-static-v0 stays ADMIN-only', async () => {
  assert.deepEqual(
    Reflect.getMetadata('roles', ProxyController.prototype.proxyRequest),
    ['ADMIN', 'MANAGER', 'VIEWER'],
  );
  let upstreamCalls = 0;
  const controller = new ProxyController({
    getServer: () => ({ id: 'remote', name: 'Remote', url: 'https://example.test', token: 'hidden' }),
    proxyRaw: async () => {
      upstreamCalls += 1;
      return new Response(null, { status: 204 });
    },
  }, { logOut: async () => {} }, {
    resolveRouteTarget: async () => ({ kind: 'LEGACY_STATIC_V0' }),
  });

  await assert.rejects(
    () => controller.proxyRequest(
      'remote',
      requestFor('GET', '/dashboard/overview'),
      responseRecorder(),
      { id: 'manager-1', role: 'MANAGER' },
    ),
    /Legacy remote access is ADMIN-only/,
  );
  await assert.rejects(
    () => controller.proxyRequest(
      'remote',
      requestFor('GET', '/sites'),
      responseRecorder(),
      { id: 'viewer-1', role: 'VIEWER' },
    ),
    /Legacy remote access is ADMIN-only/,
  );

  const denied = responseRecorder();
  await controller.proxyRequest(
    'remote',
    requestFor('GET', '/users'),
    denied,
    { id: 'admin-1', role: 'ADMIN' },
  );
  assert.equal(denied.statusCode, 426);
  assert.equal(denied.payload.error.code, 'LEGACY_UPGRADE_REQUIRED');
  assert.equal(upstreamCalls, 0);
});
