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

const scope = loadTypeScript(path.join(webRoot, 'utils/api-request-scope.ts'));

test('RPP-210 master lifecycle and control-plane paths ignore selected target', () => {
  for (const endpoint of [
    '/auth/login',
    '/admin/update/version',
    '/admin/update/tags?refresh=1',
    '/auth/refresh',
    '/auth/logout',
    '/auth/me',
    '/auth/totp/enable',
    '/auth/sessions/session-id',
    '/auth/basic-auth',
    '/setup/status',
    '/setup/init',
    '/servers',
    '/servers/enrollments/id',
    '/migration/start',
    '/proxy/target/sites',
    '/panel-settings/appearance',
  ]) {
    assert.equal(scope.resolveApiRequestScope(endpoint, 'selected-target'), 'master', endpoint);
  }
});

test('RPP-210 target data paths remain selected-target unless caller chooses master', () => {
  for (const endpoint of [
    '/users',
    '/sites',
    '/panel-settings',
    '/panel-settings/site-defaults',
    '/authenticators',
  ]) {
    assert.equal(scope.resolveApiRequestScope(endpoint, 'selected-target'), 'selected-target', endpoint);
    assert.equal(scope.resolveApiRequestScope(endpoint, 'master'), 'master', endpoint);
  }
  assert.equal(scope.resolveApiRequestScope('/auth/me?fresh=1', 'selected-target'), 'master');
  assert.throws(() => scope.resolveApiRequestScope('https://target.test/api/sites', 'master'));
  assert.throws(() => scope.resolveApiRequestScope('//target.test/api/sites', 'master'));
});

test('RPP-210 facades and logout cleanup are explicit source contracts', () => {
  const useApi = fs.readFileSync(path.join(webRoot, 'composables/useApi.ts'), 'utf8');
  const masterFacade = fs.readFileSync(path.join(webRoot, 'composables/useMasterApi.ts'), 'utf8');
  const remoteFacade = fs.readFileSync(path.join(webRoot, 'composables/useRemoteApi.ts'), 'utf8');
  const auth = fs.readFileSync(path.join(webRoot, 'stores/auth.ts'), 'utf8');
  const login = fs.readFileSync(path.join(webRoot, 'pages/login.vue'), 'utf8');
  const setup = fs.readFileSync(path.join(webRoot, 'pages/setup.vue'), 'utf8');

  assert.match(masterFacade, /useApi\('master'\)/);
  assert.match(remoteFacade, /useApi\('selected-target'\)/);
  assert.match(useApi, /export function cancelRemoteApiRequests/);
  assert.doesNotMatch(useApi, /endpoint\.startsWith\('\/servers'\)/);
  assert.match(auth, /const api = useMasterApi\(\)/);
  assert.match(auth, /finally\s*\{[\s\S]*resetRemoteSelectionAndTransport\(\)/);
  assert.match(auth, /logoutRevocationUncertain = !revocationConfirmed/);
  assert.match(auth, /sessionStorage\.setItem\(LOGOUT_REVOCATION_UNCERTAIN_KEY, '1'\)/);
  assert.match(auth, /return \{ revocationConfirmed \}/);
  assert.match(login, /const api = useMasterApi\(\)/);
  assert.match(login, /serverStore\.resetToMain\(\)/);
  assert.match(login, /authStore\.logoutRevocationUncertain/);
  assert.match(login, /сервер не подтвердил отзыв токена/);
  assert.match(setup, /const api = useMasterApi\(\)/);
  assert.match(setup, /serverStore\.resetToMain\(\)/);
});

test('RPP-300 server enrollment UI uses pinned federation routes, never legacy provisioning', () => {
  const store = fs.readFileSync(path.join(webRoot, 'stores/server.ts'), 'utf8');
  const page = fs.readFileSync(path.join(webRoot, 'pages/servers.vue'), 'utf8');
  assert.doesNotMatch(store, /\/servers\/provision/);
  assert.match(store, /\/servers\/enrollments/);
  assert.match(store, /sshPassword/);
  assert.match(page, /sshFingerprint/);
  assert.match(page, /spkiSha256/);
  assert.match(page, /Pinned HTTPS и Ed25519 manifest/);
  assert.match(page, /provisionForm\.password = ''/);
});

test('RPP-630 main stays separate while target updates require signed capabilities', () => {
  const store = fs.readFileSync(path.join(webRoot, 'stores/server.ts'), 'utf8');
  const layout = fs.readFileSync(path.join(webRoot, 'layouts/default.vue'), 'utf8');
  const page = fs.readFileSync(path.join(webRoot, 'pages/servers.vue'), 'utf8');

  assert.match(store, /const MAIN_SERVER: Readonly<ServerInfo>/);
  assert.match(store, /serverOptions: \(state\) => \[MAIN_SERVER, \.\.\.state\.servers\]/);
  assert.match(store, /this\.servers = data \|\| \[\]/);
  assert.doesNotMatch(store, /this\.servers\s*=\s*\[MAIN_SERVER/);
  assert.match(layout, /v-for="s in serverStore\.serverOptions"/);
  assert.match(page, /v-for="server in serverStore\.servers"/);
  assert.match(page, /:disabled="!canFleetUpdate\(server\)"/);
  assert.match(page, /server\.fleetUpdateReady === true/);
  assert.match(page, /operationIdempotencyKey\('fleet-update'\)/);
  assert.match(page, /pollFederatedUpdate/);
  assert.match(page, /snapshot\?\.manifestVerified/);
  assert.match(page, /result\.trackingPath/);
  assert.match(page, /v-if="!server\.federation" class="server-card__actions"/);
  assert.match(page, /if \(!server \|\| !canFleetUpdate\(server\)\) return;/);
});
