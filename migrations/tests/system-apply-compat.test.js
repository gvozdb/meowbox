'use strict';

const assert = require('node:assert/strict');
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const test = require('node:test');

const {
  applySystemMigrationWithCompatibility,
} = require('../dist/system-apply-compat');
const {
  LEGACY_SYSTEM_PLAN_COMPATIBILITY,
  requiresLegacyNginxRuntimeAdapter,
} = require('../dist/system-plan-compat');

const projectRoot = resolve(__dirname, '..', '..');

const adaptedIds = [
  '2026-07-04-001-ssl-trusted-certificate-nginx',
  '2026-07-04-002-ssl-stapling-ocsp-guard',
  '2026-07-04-004-ssl-usable-statuses-nginx',
  '2026-07-04-005-ssl-trusted-certificate-alias-redirects',
  '2026-07-04-006-ssl-ocsp-system-ca-fallback',
  '2026-07-26-001-ssl-renewal-reliability',
  '2026-07-26-003-stable-acme-webroot',
];

function artifact(id) {
  const entry = LEGACY_SYSTEM_PLAN_COMPATIBILITY.find((candidate) => candidate.id === id);
  assert.ok(entry, `missing compatibility entry for ${id}`);
  return { id: entry.id, checksum: entry.checksum };
}

function assertTemporaryPath(candidate) {
  assert.ok(
    resolve(candidate).startsWith(`${resolve(tmpdir())}/meowbox-system-apply-test-`),
    `refusing test write outside a temporary fixture: ${candidate}`,
  );
}

function context(currentDir, runtimeRows) {
  return {
    config: { currentDir },
    prisma: {
      siteDomain: {
        findMany: async () => runtimeRows,
      },
    },
    log: () => {},
  };
}

async function fixture() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'meowbox-system-apply-test-'));
  const templatesPath = join(tempRoot, 'agent', 'dist', 'nginx', 'templates.js');
  await mkdir(join(tempRoot, 'agent', 'dist', 'nginx'), { recursive: true });
  await writeFile(
    templatesPath,
    `'use strict';\nexports.renderNginxSite = (site) => site;\n`,
  );
  delete require.cache[require.resolve(templatesPath)];
  return { tempRoot, templatesPath };
}

test('apply compatibility is explicit and checksum-bound', async () => {
  assert.deepEqual(
    LEGACY_SYSTEM_PLAN_COMPATIBILITY
      .filter((entry) => requiresLegacyNginxRuntimeAdapter({
        id: entry.id,
        checksum: entry.checksum,
      }))
      .map((entry) => entry.id),
    adaptedIds,
  );
  assert.equal(
    requiresLegacyNginxRuntimeAdapter({
      id: '2026-01-01-001-unknown',
      checksum: '0'.repeat(64),
    }),
    false,
  );
  assert.throws(
    () => requiresLegacyNginxRuntimeAdapter({
      id: adaptedIds[0],
      checksum: '0'.repeat(64),
    }),
    /compatibility is stale/,
  );
});

test('legacy renderer receives current per-domain runtime metadata', async () => {
  const { tempRoot, templatesPath } = await fixture();
  try {
    const templates = require(templatesPath);
    const originalRender = templates.renderNginxSite;
    let rendered;
    const migration = {
      up: async () => {
        rendered = require(templatesPath).renderNginxSite({
          siteName: 'alpha',
          rootPath: '/var/www/alpha',
          phpEnabled: false,
          domains: [{
            domainId: 'domain-1',
            domain: 'alpha.example',
            filesRelPath: 'legacy-www',
            appPort: 9999,
          }],
        });
      },
    };
    const runtimeRows = [{
      id: 'domain-1',
      filesRelPath: 'public',
      preset: 'CUSTOM',
      phpVersion: '8.3',
      runtimeKey: 'alpha',
      isPrimary: true,
      appPort: 3100,
      site: { name: 'alpha' },
    }];

    await applySystemMigrationWithCompatibility(
      artifact(adaptedIds[0]),
      migration,
      context(tempRoot, runtimeRows),
    );

    assert.equal(rendered.domains[0].filesRelPath, 'public');
    assert.equal(rendered.domains[0].preset, 'CUSTOM');
    assert.equal(rendered.domains[0].phpVersion, '8.3');
    assert.equal(rendered.domains[0].runtimeKey, 'alpha');
    assert.equal(rendered.domains[0].isPrimary, true);
    assert.equal(rendered.domains[0].appPort, 3100);
    assert.equal(rendered.domains[0].socketPath, undefined);
    assert.strictEqual(require(templatesPath).renderNginxSite, originalRender);
  } finally {
    delete require.cache[require.resolve(templatesPath)];
    assertTemporaryPath(tempRoot);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('legacy renderer rejects missing or cross-site runtime metadata and restores export', async () => {
  const { tempRoot, templatesPath } = await fixture();
  try {
    const templates = require(templatesPath);
    const originalRender = templates.renderNginxSite;
    const migration = {
      up: async () => {
        require(templatesPath).renderNginxSite({
          siteName: 'alpha',
          domains: [{ domainId: 'domain-1' }],
        });
      },
    };
    const runtimeRows = [{
      id: 'domain-1',
      filesRelPath: 'www',
      preset: 'CUSTOM',
      phpVersion: null,
      runtimeKey: 'beta',
      isPrimary: true,
      appPort: null,
      site: { name: 'beta' },
    }];

    await assert.rejects(
      applySystemMigrationWithCompatibility(
        artifact(adaptedIds[0]),
        migration,
        context(tempRoot, runtimeRows),
      ),
      /site mismatch/,
    );
    assert.strictEqual(require(templatesPath).renderNginxSite, originalRender);
  } finally {
    delete require.cache[require.resolve(templatesPath)];
    assertTemporaryPath(tempRoot);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('modern migrations execute without loading the legacy adapter', async () => {
  let applied = false;
  await applySystemMigrationWithCompatibility(
    { id: '2026-08-02-001-modern', checksum: '0'.repeat(64) },
    { up: async () => { applied = true; } },
    context('/path/that/does/not/exist', []),
  );
  assert.equal(applied, true);
});

for (const migrationId of adaptedIds) {
  test(`${migrationId} renders through the current strict agent contract`, async () => {
    const migration = require(`../dist/system/${migrationId}`).default;
    const logs = [];
    const runtimeRows = [{
      id: 'domain-1',
      filesRelPath: 'public',
      preset: 'CUSTOM',
      phpVersion: '8.3',
      runtimeKey: 'compatfixture',
      isPrimary: true,
      appPort: null,
      site: { name: 'compatfixture' },
    }];
    const ctx = {
      config: { currentDir: projectRoot },
      dryRun: true,
      exists: async () => false,
      exec: {
        run: async () => ({ stdout: '', stderr: '' }),
      },
      writeFile: async () => {
        throw new Error('historical compatibility dry-run attempted a write');
      },
      log: (message) => logs.push(message),
      prisma: {
        siteDomain: { findMany: async () => runtimeRows },
        site: {
          findMany: async () => [{
            name: 'compatfixture',
            status: 'RUNNING',
            rootPath: '/var/www/compatfixture',
            systemUser: 'compatfixture',
            domains: [{
              id: 'domain-1',
              domain: 'compat.invalid',
              aliases: '[]',
              filesRelPath: 'public',
              appPort: null,
              httpsRedirect: true,
              nginxCustomConfig: null,
              sslCertificate: null,
            }],
          }],
        },
      },
    };

    await applySystemMigrationWithCompatibility(
      artifact(migrationId),
      migration,
      ctx,
    );

    assert.ok(logs.some((message) => message.includes('compat: enriched legacy Nginx payload')));
    assert.ok(logs.some((message) => message.includes('[dry-run] would:')));
  });
}
