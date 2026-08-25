'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  NginxManager,
  renderStoppedNginxSite,
} = require('../src/nginx/nginx.manager');

test('managed Nginx diagnostic returns only hashes and rejects unsafe identifiers', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meowbox-nginx-diagnostic-'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const configPath = path.join(tempDir, 'site.conf');
  const site = { siteId: 'site-1', siteName: 'safe_site', rootPath: '/var/www/safe_site', domains: [], stopped: true };
  await fs.writeFile(configPath, renderStoppedNginxSite(site));

  const manager = new NginxManager();
  manager.mainConfigPath = () => configPath;
  const matching = await manager.diagnoseManagedConfigs({ sites: [site] });
  assert.equal(matching.files.length, 1);
  assert.equal(matching.files[0].matches, true);
  assert.deepEqual(Object.keys(matching.files[0]).sort(), [
    'actualSha256', 'exists', 'expectedSha256', 'id', 'label', 'matches', 'siteId',
  ]);

  await fs.writeFile(configPath, 'manually changed');
  const drift = await manager.diagnoseManagedConfigs({ sites: [site] });
  assert.equal(drift.files[0].matches, false);
  assert.equal('content' in drift.files[0], false);

  const rejected = await manager.diagnoseManagedConfigs({
    sites: [{ ...site, siteId: '../escape', siteName: '../escape' }],
  });
  assert.deepEqual(rejected.files, []);

  const largeInventory = await manager.diagnoseManagedConfigs({
    sites: Array.from({ length: 21 }, (_, index) => ({
      ...site,
      siteId: `site-${index}`,
      siteName: `safe_site_${index}`,
    })),
  });
  assert.equal(largeInventory.files.length, 20);
  assert.equal(largeInventory.partial, true);
});
