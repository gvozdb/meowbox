'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const webRoot = path.resolve(__dirname, '..');

function loadTypeScript(relativePath) {
  const file = path.join(webRoot, relativePath);
  const source = fs.readFileSync(file, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
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

const context = loadTypeScript('utils/selected-target-context.ts');
const navigation = loadTypeScript('utils/server-switch-navigation.ts');

test('RPP-600 context identity rejects generation, epoch, target and A-B-A drift', () => {
  const original = {
    serverId: 'server-a',
    transportServerId: 'installation-a',
    registryGeneration: 7,
    contextEpoch: 11,
  };
  assert.equal(context.sameSelectedTargetContext(original, { ...original }), true);
  for (const stale of [
    { ...original, serverId: 'server-b' },
    { ...original, transportServerId: 'installation-b' },
    { ...original, registryGeneration: 8 },
    { ...original, contextEpoch: 13 },
    null,
  ]) {
    assert.equal(context.sameSelectedTargetContext(original, stale), false);
    assert.throws(
      () => context.assertSelectedTargetContext(original, stale),
      (error) => error.code === 'REMOTE_CONTEXT_CHANGED',
    );
  }
});

test('RPP-610 entity routes return to target-safe collections', () => {
  assert.equal(navigation.serverSwitchUrl('/sites/550e8400-e29b-41d4-a716-446655440000', '?tab=ssl&domain=x'), '/sites');
  assert.equal(navigation.serverSwitchUrl('/dns/zones/zone-id', '?tab=records'), '/dns');
  assert.equal(navigation.serverSwitchUrl('/sites/create', '?tab=domain'), '/sites/create?tab=domain');
});

test('RPP-610 generic routes preserve only compatible view state', () => {
  assert.equal(
    navigation.serverSwitchUrl('/backups', '?status=FAILED&page=2&token=secret&siteId=old&search=nightly'),
    '/backups?status=FAILED&page=2&search=nightly',
  );
  assert.equal(navigation.serverSwitchUrl('/terminal', '?sessionId=old#ignored'), '/terminal');
});

test('RPP-600 transport, operation and socket sources bind work to context epoch', () => {
  const api = fs.readFileSync(path.join(webRoot, 'composables/useApi.ts'), 'utf8');
  const operations = fs.readFileSync(path.join(webRoot, 'composables/useOperation.ts'), 'utf8');
  const socket = fs.readFileSync(path.join(webRoot, 'composables/useSocket.ts'), 'utf8');
  const store = fs.readFileSync(path.join(webRoot, 'stores/server.ts'), 'utf8');

  assert.match(api, /snapshot\.transportServerId/);
  assert.match(api, /assertTransportContextCurrent\(transport\)/);
  assert.match(api, /cancelRemoteApiRequests/);
  assert.match(operations, /export function cancelOperationWatches/);
  assert.match(store, /cancelOperationWatches\(\)/);
  assert.match(store, /cancelPublicDeliveryRequests\(\)/);
  assert.match(store, /captureSelectedTargetContext/);
  assert.match(store, /assertSelectedTargetContextCurrent/);
  assert.match(store, /registryGeneration:[\s\S]*contextEpoch:/);
  assert.match(socket, /socketBoundContextKey/);
  assert.match(socket, /contextKeyIsCurrent/);
  assert.match(socket, /federation:state/);
  assert.match(socket, /federationState\.value === 'READY'/);
  assert.doesNotMatch(socket, /pendingListeners/);
});
