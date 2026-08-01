'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const webRoot = path.resolve(__dirname, '..');
const sitePage = fs.readFileSync(path.join(webRoot, 'pages', 'sites', '[id].vue'), 'utf8');
const dnsTab = fs.readFileSync(path.join(webRoot, 'components', 'SiteDnsTab.vue'), 'utf8');
const domainsTab = fs.readFileSync(path.join(webRoot, 'components', 'SiteDomainsTab.vue'), 'utf8');

test('DNS tab uses the selected domain endpoint', () => {
  assert.match(dnsTab, /\/dns\/sites\/\$\{props\.siteId\}\/domains\/\$\{props\.domainId\}/);
  assert.doesNotMatch(dnsTab, /`\/dns\/sites\/\$\{props\.siteId\}`/);
  assert.match(sitePage, /:domain-id="selectedDomainId"/);
});

test('site and application navigation stay separated', () => {
  const siteOrder = ['Сайты', 'Бэкапы', 'Крон', 'Сервисы', 'Логи', 'Опасная зона'];
  let offset = sitePage.indexOf('const siteTabs = computed');
  assert.notEqual(offset, -1);
  for (const label of siteOrder) {
    const next = sitePage.indexOf(`label: '${label}'`, offset);
    assert.notEqual(next, -1, `missing site tab ${label}`);
    offset = next + label.length;
  }
  assert.match(sitePage, /const applicationTabs = computed/);
  assert.doesNotMatch(
    sitePage.slice(
      sitePage.indexOf('const applicationTabs = computed'),
      sitePage.indexOf('const siteTabs = computed'),
    ),
    /label: '(ENV|Деплой|Бэкапы|Крон|Сервисы|Логи|Опасная зона)'/,
  );
});

test('site header has one status and domain options contain no status text', () => {
  const template = sitePage.slice(0, sitePage.indexOf('<script setup'));
  assert.equal((template.match(/<SiteStatusBadge/g) || []).length, 1);
  assert.doesNotMatch(template, /site-detail__app-status/);
  assert.match(template, /<option v-for="domain[\s\S]*?\{\{ domain\.domain \}\}[\s\S]*?<\/option>/);
  assert.doesNotMatch(
    template.slice(template.indexOf('id="site-domain-picker"'), template.indexOf('</select>', template.indexOf('id="site-domain-picker"'))),
    /appStatusLabel|Работает/,
  );
});

test('application modals are opaque and hide deferred deploy/env controls', () => {
  assert.match(domainsTab, /background-color: var\(--bg-modal\)/);
  assert.doesNotMatch(domainsTab, /background: var\(--bg-card\)/);
  assert.match(domainsTab, /:show-git-deploy="false"/);
  assert.match(domainsTab, /:show-environment="false"/);
  assert.match(domainsTab, /\.btn \{/);
});

test('application subtab strip has a complete top edge', () => {
  const styles = sitePage.slice(sitePage.indexOf('<style scoped>'));
  const block = styles.slice(
    styles.indexOf('.site-detail__tabs--application'),
    styles.indexOf('.site-detail__tab--application'),
  );
  assert.match(block, /border:\s*1px solid var\(--border-secondary\)/);
  assert.match(block, /border-radius:\s*10px/);
  assert.doesNotMatch(block, /border-top:\s*0/);
});
