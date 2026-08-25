'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const webRoot = path.resolve(__dirname, '..');
const expectedPages = [
  'activity.vue',
  'admin/migrate-hostpanel/index.vue',
  'admin/updates.vue',
  'ai.vue',
  'backup-checks.vue',
  'backup-storages.vue',
  'backups.vue',
  'cron.vue',
  'databases.vue',
  'dns/index.vue',
  'dns/providers.vue',
  'dns/zones/[id].vue',
  'firewall.vue',
  'health.vue',
  'index.vue',
  'login.vue',
  'logs.vue',
  'monitoring.vue',
  'nginx.vue',
  'php.vue',
  'processes.vue',
  'servers.vue',
  'services.vue',
  'settings.vue',
  'setup.vue',
  'sites/[id].vue',
  'sites/create.vue',
  'sites/index.vue',
  'ssl.vue',
  'storage.vue',
  'terminal.vue',
  'updates.vue',
  'users.vue',
  'vpn.vue',
];

function vueFiles(root, relative = '') {
  const directory = path.join(root, relative);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const next = path.posix.join(relative, entry.name);
    return entry.isDirectory()
      ? vueFiles(root, next)
      : entry.isFile() && entry.name.endsWith('.vue') ? [next] : [];
  });
}

test('RPP-640 all 34 pages remain inside the capability-gated transport boundary', () => {
  const actualPages = vueFiles(path.join(webRoot, 'pages')).sort();
  assert.deepEqual(actualPages, [...expectedPages].sort());

  const surfaceRoots = ['pages', 'components'];
  const sources = surfaceRoots.flatMap((root) => {
    const absolute = path.join(webRoot, root);
    const files = [];
    const visit = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (/\.(?:ts|vue)$/.test(entry.name)) files.push(file);
      }
    };
    visit(absolute);
    return files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  }).join('\n');

  assert.doesNotMatch(sources, /\b(?:fetch|\$fetch)\s*\(/);
  assert.doesNotMatch(sources, /\baxios\s*\./);
  assert.doesNotMatch(sources, /\bnoProxy\b/);
  assert.doesNotMatch(sources, /document\.write\s*\(/);
  assert.doesNotMatch(
    expectedPages.map((page) => fs.readFileSync(path.join(webRoot, 'pages', page), 'utf8')).join('\n'),
    /["'`]\/proxy\//,
  );
  assert.doesNotMatch(
    fs.readFileSync(path.join(webRoot, 'composables/useApi.ts'), 'utf8'),
    /\bnoProxy\b/,
  );
});

test('RPP-640 unknown and partial target actions fail closed with an operator-visible reason', () => {
  const layout = fs.readFileSync(path.join(webRoot, 'layouts/default.vue'), 'utf8');
  const notice = fs.readFileSync(path.join(webRoot, 'components/RemoteContextNotice.vue'), 'utf8');
  const api = fs.readFileSync(path.join(webRoot, 'composables/useApi.ts'), 'utf8');
  const resolver = fs.readFileSync(path.join(webRoot, 'utils/remote-action-resolver.ts'), 'utf8');
  const catalogue = JSON.parse(
    fs.readFileSync(path.join(webRoot, 'generated/federation-http-actions.json'), 'utf8'),
  );

  assert.match(layout, /<RemoteContextNotice\s*\/>/);
  assert.match(notice, /remoteContextNotice\(serverStore\.remoteContext\)/);
  assert.match(notice, /notice\.code/);
  assert.match(notice, /notice\.message/);
  assert.match(api, /resolveRemoteHttpAction\(method, endpoint\)/);
  assert.match(api, /actionId: action\?\.actionId \?\? '__uncatalogued__'/);
  assert.match(api, /if \(action && decision\.available\) return/);
  assert.match(api, /Target не объявил capability/);
  assert.match(api, /attachRemoteMutationIdempotency/);
  assert.match(api, /assertTransportContextCurrent\(transport\)/);
  assert.match(resolver, /Ambiguous federation browser route/);
  assert.match(resolver, /return matches\[0\] \?\? null/);
  assert.equal(catalogue.schemaVersion, 'meowbox.browser-federation-http-actions/v1');
  assert.ok(catalogue.actions.length >= 300);
  assert.equal(
    new Set(catalogue.actions.map((action) => `${action.method} ${action.routeTemplate}`)).size,
    catalogue.actions.length,
  );
});
