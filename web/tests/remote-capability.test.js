'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const webRoot = path.resolve(__dirname, '..');

function loadTypeScript(file) {
  const source = fs.readFileSync(file, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      resolveJsonModule: true,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: file,
  }).outputText;
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = module.paths;
  loaded._compile(output, file);
  return loaded.exports;
}

const capability = loadTypeScript(path.join(webRoot, 'utils/remote-capability.ts'));
const resolver = loadTypeScript(path.join(webRoot, 'utils/remote-action-resolver.ts'));

function fixture(overrides = {}) {
  const future = new Date(Date.now() + 60_000).toISOString();
  return {
    serverId: 'target-1',
    targetInstallationId: '0d48be5a-ea9e-4b86-bdc6-c8ef761b3d24',
    displayName: 'Target',
    registryGeneration: 1,
    contextEpoch: 1,
    browserPublicOrigin: 'https://target.example',
    directTransferOrigin: 'https://target.example',
    sshHost: 'target.example',
    sshPort: 22,
    productVersion: 'v1.0.0',
    protocol: {
      mode: 'v1-enabled',
      selected: 1,
      target: { min: 1, max: 1 },
      acceptedMaster: { min: 1, max: 1 },
    },
    manifest: { schemaVersion: 1, revision: 'one', validUntil: future },
    capabilities: {
      'http.get.sites': {
        actionId: 'http.get.sites',
        enabled: true,
        roles: ['ADMIN', 'MANAGER', 'VIEWER'],
        executionMode: 'INTERACTIVE',
      },
    },
    status: {
      transport: { state: 'ONLINE', reasonCode: 'READY' },
      trust: { state: 'ACTIVE', reasonCode: 'READY' },
      capability: { state: 'FRESH', reasonCode: 'READY' },
      browser: { state: 'REACHABLE', reasonCode: 'READY' },
    },
    topologyMode: 'PUBLIC',
    killSwitches: { http: false, ws: false, publicDelivery: false, legacy: true },
    ...overrides,
  };
}

test('RPP-640 capability decision is local-transparent and fail-closed for remotes', () => {
  assert.equal(capability.evaluateRemoteCapability({ isLocal: true, context: null, role: 'ADMIN' }).available, true);
  assert.equal(capability.evaluateRemoteCapability({ isLocal: false, context: null, role: 'ADMIN' }).code, 'REMOTE_NOT_READY');

  const ready = fixture();
  assert.equal(capability.evaluateRemoteCapability({
    isLocal: false,
    context: ready,
    role: 'VIEWER',
    requirement: { actionId: 'http.get.sites' },
  }).available, true);
  assert.equal(capability.evaluateRemoteCapability({
    isLocal: false,
    context: ready,
    role: 'ADMIN',
    requirement: { actionId: 'http.post.sites' },
  }).code, 'REMOTE_ACTION_UNSUPPORTED');
});

test('RPP-640 transport, role, browser and partial states stay distinct', () => {
  const ready = fixture();
  assert.equal(capability.evaluateRemoteCapability({
    isLocal: false,
    context: { ...ready, killSwitches: { ...ready.killSwitches, ws: true } },
    role: 'ADMIN',
    requirement: { transport: 'ws' },
  }).code, 'REMOTE_DISABLED');
  assert.equal(capability.evaluateRemoteCapability({
    isLocal: false,
    context: ready,
    role: 'SERVICE',
    requirement: { actionId: 'http.get.sites' },
  }).code, 'REMOTE_PERMISSION_DENIED');
  assert.equal(capability.evaluateRemoteCapability({
    isLocal: false,
    context: { ...ready, status: { ...ready.status, browser: { state: 'UNREACHABLE', reasonCode: 'TARGET_BROWSER_UNREACHABLE' } } },
    role: 'ADMIN',
    requirement: { browserReachability: true },
  }).code, 'REMOTE_BROWSER_UNREACHABLE');
  assert.equal(capability.remoteContextNotice({
    ...ready,
    status: { ...ready.status, capability: { state: 'PARTIAL', reasonCode: 'PARTIAL_CAPABILITY' } },
  }).code, 'PARTIAL_CAPABILITY');
});

test('RPP-210 selected-target mutations receive one stable automatic idempotency key', () => {
  const source = fs.readFileSync(path.join(webRoot, 'composables/useApi.ts'), 'utf8');
  assert.match(source, /attachRemoteMutationIdempotency\(headers, method, transport\.snapshot !== null\)/);
  assert.match(source, /headers\['Idempotency-Key'\] = newIdempotencyKey\(\)/);
  assert.match(source, /if \(remote && MUTATION_METHODS\.has\(method\)/);
});

test('RPP-640 generated browser resolver maps concrete paths and denies stale routes', () => {
  assert.equal(
    resolver.resolveRemoteHttpAction('GET', '/sites/abc?fresh=1').actionId,
    'http.get.sites-id',
  );
  assert.equal(
    resolver.resolveRemoteHttpAction('POST', '/sites/abc/domains/def/databases/ghi/export').actionId,
    'http.post.sites-site-id-domains-domain-id-databases-id-export',
  );
  assert.equal(resolver.resolveRemoteHttpAction('POST', '/auth/logout'), null);
  assert.equal(resolver.resolveRemoteHttpAction('POST', '/sites/abc/unsupported'), null);
  assert.throws(() => resolver.resolveRemoteHttpAction('GET', '//target.example/sites'));
});

test('RPP-640 every generated browser action is unique and target-dispatchable', () => {
  const actions = resolver.activeRemoteHttpActions();
  assert.ok(actions.length > 100);
  assert.equal(new Set(actions.map((action) => `${action.method} ${action.routeTemplate}`)).size, actions.length);
  assert.ok(actions.every((action) => action.routeTemplate.startsWith('/api/')));
});
