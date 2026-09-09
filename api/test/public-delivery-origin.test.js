'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PublicDeliveryOriginService,
} = require('../src/public-delivery/public-delivery-origin.service');

function fixture({
  claim = { state: 'UNCONFIGURED', endpoints: {} },
  access = { domain: 'panel.example.test', certMode: 'LE' },
  env = { PANEL_DOMAIN: 'localhost', PANEL_PORT: '11862' },
} = {}) {
  const config = { get: (key, fallback) => env[key] ?? fallback };
  const localEndpoints = { getClaim: () => claim };
  const settings = {
    getPanelAccess: async () => {
      if (access instanceof Error) throw access;
      return access;
    },
  };
  return new PublicDeliveryOriginService(config, localEndpoints, settings);
}

test('active Panel Access TLS domain is the unconfigured public-delivery fallback', async () => {
  const origins = fixture();
  assert.equal(await origins.browserPublicOrigin(), 'https://panel.example.test');
  assert.equal(await origins.directTransferOrigin(), 'https://panel.example.test');
});

test('explicit federation endpoint claims retain precedence', async () => {
  const origins = fixture({
    claim: {
      state: 'READY',
      endpoints: {
        browserPublicOrigin: 'https://browser.edge.test',
        directTransferOrigin: 'https://transfer.edge.test',
      },
    },
    access: new Error('database unavailable'),
  });
  assert.equal(await origins.browserPublicOrigin(), 'https://browser.edge.test');
  assert.equal(await origins.directTransferOrigin(), 'https://transfer.edge.test');
});

test('stale claimed recovery origin follows the active Panel Access domain to standard HTTPS', async () => {
  const origins = fixture({
    claim: {
      state: 'READY',
      endpoints: {
        browserPublicOrigin: 'https://panel.example.test:11862',
        directTransferOrigin: 'https://panel.example.test:11862',
      },
    },
  });
  assert.equal(await origins.browserPublicOrigin(), 'https://panel.example.test');
  assert.equal(await origins.directTransferOrigin(), 'https://panel.example.test');
});

test('claimed custom and edge origins are not rewritten', async () => {
  const origins = fixture({
    claim: {
      state: 'READY',
      endpoints: {
        browserPublicOrigin: 'https://panel.example.test:8443',
        directTransferOrigin: 'https://transfer.edge.test:11862',
      },
    },
  });
  assert.equal(await origins.browserPublicOrigin(), 'https://panel.example.test:8443');
  assert.equal(await origins.directTransferOrigin(), 'https://transfer.edge.test:11862');
});

test('legacy PANEL_DOMAIN and PANEL_PORT remain available without an active TLS domain', async () => {
  const origins = fixture({
    access: { domain: null, certMode: 'SELFSIGNED' },
    env: { PANEL_DOMAIN: 'legacy.example.test', PANEL_PORT: '11862' },
  });
  assert.equal(await origins.browserPublicOrigin(), 'https://legacy.example.test:11862');
});

test('invalid or unreadable active Panel Access state fails closed', async () => {
  await assert.rejects(
    fixture({ access: { domain: 'bad/path', certMode: 'LE' } }).browserPublicOrigin(),
    /TARGET_BROWSER_UNREACHABLE/,
  );
  await assert.rejects(
    fixture({ access: new Error('database unavailable') }).browserPublicOrigin(),
    /TARGET_BROWSER_UNREACHABLE/,
  );
});
