'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Reflector } = require('@nestjs/core');

const {
  CustomThrottlerGuard,
  federationRateLimitTracker,
} = require('../src/common/guards/throttler-tracker.guard');

const catalogue = {
  resolveHttpByConcretePath(method, path) {
    if (method === 'GET' && path === '/api/sites/one') return { actionId: 'http.get.sites-id' };
    if (method === 'DELETE' && path === '/api/sites/one') return { actionId: 'http.delete.sites-id' };
    return undefined;
  },
};

function base(overrides = {}) {
  return {
    headers: {},
    ip: '203.0.113.8',
    method: 'GET',
    originalUrl: '/api/sites',
    params: {},
    socket: { remoteAddress: '203.0.113.8' },
    ...overrides,
  };
}

test('CF22 local rate keys isolate operators sharing one NAT address', () => {
  const first = federationRateLimitTracker(base({ user: { sub: 'operator-a' } }), catalogue);
  const second = federationRateLimitTracker(base({ user: { sub: 'operator-b' } }), catalogue);
  assert.notEqual(first, second);
  assert.equal(first.startsWith('local:'), true);
  assert.equal(first.includes('operator-a'), false);
});

test('CF22 master relay keys bind operator, target, and catalogue action', () => {
  const request = base({
    user: { sub: 'operator-a' },
    params: { serverId: 'target-a' },
    originalUrl: '/api/proxy/target-a/sites/one?include=domains',
  });
  const tracker = federationRateLimitTracker(request, catalogue);
  assert.match(tracker, /^relay:[a-f0-9]{24}:[a-f0-9]{24}:http\.get\.sites-id$/);
  assert.notEqual(tracker, federationRateLimitTracker({
    ...request,
    params: { serverId: 'target-b' },
    originalUrl: '/api/proxy/target-b/sites/one',
  }, catalogue));
  assert.notEqual(tracker, federationRateLimitTracker({ ...request, method: 'DELETE' }, catalogue));
});

test('CF22 delegated target keys bind issuer, subject, and verified action', () => {
  const request = base({
    federationContext: {
      verified: true,
      issuerId: 'issuer-a',
      subject: 'operator-a',
      actionId: 'http.get.sites',
    },
  });
  const tracker = federationRateLimitTracker(request, catalogue);
  assert.match(tracker, /^delegated:[a-f0-9]{24}:[a-f0-9]{24}:http\.get\.sites$/);
  assert.notEqual(tracker, federationRateLimitTracker({
    ...request,
    federationContext: { ...request.federationContext, actionId: 'http.get.domains' },
  }, catalogue));
});

test('CF22 public keys bind source IP and credential hash without retaining token', () => {
  const token = 'opaque-token-material';
  const request = base({ params: { token }, originalUrl: '/api/public/v1/webhooks/opaque' });
  const tracker = federationRateLimitTracker(request, catalogue);
  assert.match(tracker, /^public:[a-f0-9]{24}:[a-f0-9]{24}$/);
  assert.equal(tracker.includes(token), false);
  assert.notEqual(tracker, federationRateLimitTracker({
    ...request,
    ip: '203.0.113.9',
    socket: { remoteAddress: '203.0.113.9' },
  }, catalogue));
  assert.notEqual(tracker, federationRateLimitTracker({
    ...request,
    params: { token: 'different-token' },
  }, catalogue));
});

test('CF22 transfer query secrets use the public identity boundary', () => {
  const tracker = federationRateLimitTracker(base({
    originalUrl: '/api/transfers/id/download?secret=redacted',
    params: { id: 'id' },
    query: { secret: 'transfer-secret' },
  }), catalogue);
  assert.match(tracker, /^public:/);
  assert.equal(tracker.includes('transfer-secret'), false);
});

class MemoryStorage {
  constructor() {
    this.hits = new Map();
  }

  async increment(key) {
    const totalHits = (this.hits.get(key) ?? 0) + 1;
    this.hits.set(key, totalHits);
    return { totalHits, timeToExpire: 60 };
  }
}

function contextFor(request) {
  const headers = new Map();
  return {
    context: {
      getClass: () => class SitesController {},
      getHandler: () => function listSites() {},
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ header: (name, value) => headers.set(name, value) }),
      }),
    },
    headers,
  };
}

test('CF22 per-operator limits remain fair behind NAT while a separate IP ceiling stays active', async () => {
  const storage = new MemoryStorage();
  const guard = new CustomThrottlerGuard(
    [{ name: 'short', limit: 2, ttl: 60_000 }],
    storage,
    new Reflector(),
    catalogue,
  );
  await guard.onModuleInit();
  const first = contextFor(base({ user: { sub: 'operator-a' } }));
  assert.equal(await guard.canActivate(first.context), true);
  assert.equal(await guard.canActivate(first.context), true);
  await assert.rejects(() => guard.canActivate(first.context), /Too Many Requests/);

  const second = contextFor(base({ user: { sub: 'operator-b' } }));
  assert.equal(await guard.canActivate(second.context), true);
  assert.equal(await guard.canActivate(second.context), true);

  const globalStorage = new MemoryStorage();
  const globalGuard = new CustomThrottlerGuard(
    [{ name: 'short', limit: 1, ttl: 60_000 }],
    globalStorage,
    new Reflector(),
    catalogue,
  );
  await globalGuard.onModuleInit();
  for (let index = 0; index < 5; index += 1) {
    const scoped = contextFor(base({ user: { sub: `operator-${index}` } }));
    assert.equal(await globalGuard.canActivate(scoped.context), true);
  }
  const blocked = contextFor(base({ user: { sub: 'operator-over-global-ceiling' } }));
  await assert.rejects(() => globalGuard.canActivate(blocked.context), /Too Many Requests/);
  assert.equal(blocked.headers.get('Retry-After-short'), 60);
});
