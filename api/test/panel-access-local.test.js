'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');

const { PanelAccessService } = require('../src/panel-access/panel-access.service');

const active = {
  domain: 'old.panel.test',
  certMode: 'LE',
  httpsRedirect: true,
  denyIpAccess: true,
  certIssuedAt: '2026-08-01T00:00:00.000Z',
  certExpiresAt: '2026-11-01T00:00:00.000Z',
  certPath: '/fixture/old/fullchain.pem',
  keyPath: '/fixture/old/privkey.pem',
  leLastError: null,
  leEmail: 'ops@example.test',
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fixture(options = {}) {
  let stored = clone(options.current || active);
  const writes = [];
  const events = [];
  const trace = [];
  const settings = {
    getPanelAccess: async () => clone(stored),
    set: async (_key, value) => {
      trace.push('store');
      if (options.storeError) throw options.storeError;
      stored = clone(value);
      writes.push(clone(value));
    },
  };
  const relay = {
    isAgentConnected: () => options.agentOnline !== false,
    emitToAgent: async (event, payload) => {
      events.push([event, clone(payload)]);
      trace.push(event);
      if (event === 'panel-access:issue-le') {
        return options.issueResult || {
          success: true,
          certPath: '/fixture/new/fullchain.pem',
          keyPath: '/fixture/new/privkey.pem',
          expiresAt: '2026-12-01T00:00:00.000Z',
        };
      }
      if (event === 'panel-access:render-nginx') {
        return options.renderResult || { success: true };
      }
      if (event === 'panel-access:gen-selfsigned') {
        return options.selfSignedResult || {
          success: true,
          certPath: '/fixture/selfsigned/fullchain.pem',
          keyPath: '/fixture/selfsigned/privkey.pem',
          expiresAt: '2036-09-01T00:00:00.000Z',
        };
      }
      if (event === 'panel-access:status') {
        return {
          success: true,
          certOnDisk: true,
          certExpiresAt: stored.certExpiresAt,
          dnsResolved: '192.0.2.10',
          serverIp: '192.0.2.10',
          dnsMatchesServer: true,
          panelPort: 11862,
        };
      }
      throw new Error(`Unexpected agent event: ${event}`);
    },
  };
  const prisma = { user: { findFirst: async () => null } };
  const service = new PanelAccessService(prisma, settings, relay);
  return { service, events, trace, writes, stored: () => clone(stored) };
}

test('local domain PUT cannot discard active TLS', async () => {
  const state = fixture();
  await assert.rejects(
    () => state.service.setDomain('new.panel.test'),
    /применяется вместе с выпуском Let's Encrypt/,
  );
  assert.deepEqual(state.stored(), active);
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.writes, []);
});

test('failed LE replacement preserves active settings and never renders NONE', async () => {
  const state = fixture({ issueResult: { success: false, error: 'ACME unauthorized' } });
  await assert.rejects(
    () => state.service.issueLeCert('new@example.test', 'new.panel.test'),
    /ACME unauthorized/,
  );
  assert.equal(state.stored().domain, active.domain);
  assert.equal(state.stored().certMode, 'LE');
  assert.equal(state.stored().certPath, active.certPath);
  assert.equal(state.stored().leLastError, 'ACME unauthorized');
  assert.deepEqual(state.events.map(([event]) => event), ['panel-access:issue-le']);
  assert.equal(state.events.some(([event]) => event === 'panel-access:remove-cert'), false);
});

test('successful LE replacement renders TLS before committing the new domain', async () => {
  const state = fixture();
  const result = await state.service.issueLeCert('new@example.test', 'new.panel.test');
  assert.equal(result.settings.domain, 'new.panel.test');
  assert.equal(result.settings.certMode, 'LE');
  assert.deepEqual(state.trace.slice(0, 3), [
    'panel-access:issue-le',
    'panel-access:render-nginx',
    'store',
  ]);
  const rendered = state.events.find(([event]) => event === 'panel-access:render-nginx')[1];
  assert.equal(rendered.domain, 'new.panel.test');
  assert.equal(rendered.certMode, 'LE');
  assert.equal(rendered.certPath, '/fixture/new/fullchain.pem');
  assert.equal(state.events.some(([event]) => event === 'panel-access:remove-cert'), false);
});

test('failed Nginx promotion leaves the old domain and certificate committed', async () => {
  const state = fixture({ renderResult: { success: false, error: 'nginx reload failed' } });
  await assert.rejects(
    () => state.service.issueLeCert('new@example.test', 'new.panel.test'),
    /nginx reload failed/,
  );
  assert.deepEqual(state.stored(), active);
  assert.deepEqual(state.writes, []);
  assert.equal(state.events.some(([event]) => event === 'panel-access:remove-cert'), false);
});

test('domain unbind replaces LE with self-signed before changing active settings', async () => {
  const state = fixture();
  const result = await state.service.setDomain(null);
  assert.equal(result.settings.domain, null);
  assert.equal(result.settings.certMode, 'SELFSIGNED');
  assert.equal(result.settings.denyIpAccess, false);
  assert.deepEqual(state.trace.slice(0, 3), [
    'panel-access:gen-selfsigned',
    'panel-access:render-nginx',
    'store',
  ]);
  assert.equal(state.events.some(([event]) => event === 'panel-access:remove-cert'), false);
});
