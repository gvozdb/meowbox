'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const { UnauthorizedException } = require('@nestjs/common');
const { lastValueFrom, of } = require('rxjs');
const {
  AuditInterceptor,
} = require('../src/common/interceptors/audit.interceptor');
const {
  GlobalExceptionFilter,
} = require('../src/common/filters/http-exception.filter');

function executionContext(request, statusCode = 200) {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ statusCode }),
    }),
  };
}

test('T-AUD-001 federated target IN audit is correlated and never becomes local activity', async () => {
  const proxyRows = [];
  const localRows = [];
  const interceptor = new AuditInterceptor({
    proxyAuditLog: { create: async ({ data }) => proxyRows.push(data) },
    auditLog: { create: async ({ data }) => localRows.push(data) },
  });
  const requestId = randomUUID();
  const userId = randomUUID();
  const principalId = randomUUID();
  const request = {
    method: 'POST',
    path: '/api/sites',
    route: { path: '/api/sites' },
    params: {},
    headers: { 'user-agent': 'fixture' },
    ip: '203.0.113.40',
    user: { id: userId, sub: userId, role: 'MANAGER' },
    networkContext: {
      peerIp: '203.0.113.40',
      browserIp: '198.51.100.40',
      provenance: 'FEDERATION_SIGNED',
    },
    federationContext: {
      verified: true,
      requestId,
      actionId: 'http.post.sites',
      issuerInstallationId: randomUUID(),
      targetInstallationId: randomUUID(),
      issuerId: randomUUID(),
      keyId: 'ed25519-fixture',
      actorKind: 'OPERATOR',
      subject: randomUUID(),
      browserIp: '198.51.100.40',
      role: 'MANAGER',
      principalVersion: 1,
      effectivePermissions: ['http.post.sites'],
      descriptor: {},
      userId,
      principalId,
      operationId: null,
      idempotencyKey: 'fixture-key',
      idempotencyReceiptId: randomUUID(),
      replayHash: 'a'.repeat(64),
    },
  };

  await lastValueFrom(interceptor.intercept(
    executionContext(request, 201),
    { handle: () => of({ success: true }) },
  ));
  assert.equal(localRows.length, 0);
  assert.equal(proxyRows.length, 1);
  assert.deepEqual({
    direction: proxyRows[0].direction,
    userId: proxyRows[0].userId,
    requestId: proxyRows[0].requestId,
    actionId: proxyRows[0].actionId,
    targetPrincipalId: proxyRows[0].targetPrincipalId,
    statusCode: proxyRows[0].statusCode,
    peerIp: proxyRows[0].peerIp,
    browserIp: proxyRows[0].browserIp,
  }, {
    direction: 'IN',
    userId,
    requestId,
    actionId: 'http.post.sites',
    targetPrincipalId: principalId,
    statusCode: 201,
    peerIp: '203.0.113.40',
    browserIp: '198.51.100.40',
  });
});

test('SP1 target dashboard reads remain audit-suppressed', async () => {
  let writes = 0;
  const interceptor = new AuditInterceptor({
    proxyAuditLog: { create: async () => { writes += 1; } },
    auditLog: { create: async () => { writes += 1; } },
  });
  const request = {
    method: 'GET',
    path: '/api/dashboard/overview',
    headers: {},
    federationContext: { verified: true },
  };
  await lastValueFrom(interceptor.intercept(
    executionContext(request),
    { handle: () => of({}) },
  ));
  assert.equal(writes, 0);
});

test('nested federation HTTP errors keep a bounded code and message', () => {
  const filter = new GlobalExceptionFilter();
  const response = {
    statusCode: null,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; },
  };
  filter.catch(new UnauthorizedException({
    success: false,
    error: { code: 'REMOTE_AUTH_FAILED', message: 'Federation request rejected' },
  }), {
    switchToHttp: () => ({ getResponse: () => response }),
  });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.payload, {
    success: false,
    error: { code: 'REMOTE_AUTH_FAILED', message: 'Federation request rejected' },
  });
});
