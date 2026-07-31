'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildSiteBackupManifest,
  normalizeSiteBackupManifest,
  parseSiteBackupManifest,
  stringifySiteBackupManifest,
} = require('../src/backups/site-backup-manifest');
const { BackupsService } = require('../src/backups/backups.service');

const siteId = '10000000-0000-4000-8000-000000000001';
const primaryId = '20000000-0000-4000-8000-000000000001';
const secondaryId = '20000000-0000-4000-8000-000000000002';
const databaseId = '30000000-0000-4000-8000-000000000001';

function domain(overrides) {
  return {
    id: primaryId,
    domain: 'example.test',
    isPrimary: true,
    position: 0,
    aliases: '[{"domain":"www.example.test","redirect":true}]',
    filesRelPath: 'www',
    preset: 'MODX_REVO',
    appStatus: 'RUNNING',
    appErrorMessage: null,
    phpVersion: '8.2',
    phpPoolCustom: 'pm.max_children = 4',
    runtimeKey: 'domain-primary',
    gitRepository: null,
    deployBranch: null,
    envVars: '{}',
    cmsAdminUser: 'admin',
    cmsAdminPasswordEnc: 'encrypted-cms',
    managerPath: 'manager',
    connectorsPath: 'connectors',
    cmsTablePrefix: 'modx_',
    modxVersion: '3.1.0',
    appPort: null,
    httpsRedirect: true,
    nginxClientMaxBodySize: null,
    nginxFastcgiReadTimeout: null,
    nginxFastcgiSendTimeout: null,
    nginxFastcgiConnectTimeout: null,
    nginxFastcgiBufferSizeKb: null,
    nginxFastcgiBufferCount: null,
    nginxHttp2: true,
    nginxHsts: false,
    nginxGzip: true,
    nginxRateLimitEnabled: true,
    nginxRateLimitRps: null,
    nginxRateLimitBurst: null,
    nginxCustomConfig: null,
    ...overrides,
  };
}

function sourceSite() {
  return {
    id: siteId,
    name: 'example',
    displayName: 'Example',
    status: 'RUNNING',
    errorMessage: null,
    rootPath: '/var/www/example',
    nginxConfigPath: '/etc/nginx/sites-available/example.conf',
    systemUser: 'example',
    sshPasswordEnc: 'encrypted-ssh',
    backupExcludes: '["cache"]',
    backupExcludeTables: '[]',
    metadata: '{"fixture":true}',
    domains: [
      domain({}),
      domain({
        id: secondaryId,
        domain: 'api.example.test',
        aliases: '[]',
        isPrimary: false,
        position: 1,
        preset: 'CUSTOM',
        phpVersion: null,
        phpPoolCustom: null,
        runtimeKey: 'domain-secondary',
        cmsAdminUser: null,
        cmsAdminPasswordEnc: null,
        managerPath: null,
        connectorsPath: null,
        cmsTablePrefix: null,
        modxVersion: null,
        appPort: 3100,
      }),
    ],
    databases: [
      {
        id: databaseId,
        siteDomainId: primaryId,
        name: 'example_db',
        type: 'MARIADB',
        dbUser: 'example_user',
        dbPasswordHash: 'argon2-hash',
        dbPasswordEnc: 'encrypted-db',
        purpose: 'APP_PRIMARY',
      },
    ],
  };
}

test('v2 manifest is deterministic, checksummed and deduplicates shared roots', () => {
  const createdAt = new Date('2026-07-31T00:00:00.000Z');
  const first = buildSiteBackupManifest({
    site: sourceSite(),
    backupType: 'FULL',
    includedDatabaseIds: [databaseId],
    createdAt,
  });
  const second = buildSiteBackupManifest({
    site: sourceSite(),
    backupType: 'FULL',
    includedDatabaseIds: [databaseId],
    createdAt,
  });

  assert.deepEqual(first, second);
  assert.deepEqual(first.roots, [
    {
      filesRelPath: 'www',
      siteDomainIds: [primaryId, secondaryId],
    },
  ]);
  assert.equal(parseSiteBackupManifest(stringifySiteBackupManifest(first)).checksum, first.checksum);

  const tampered = JSON.parse(stringifySiteBackupManifest(first));
  tampered.domains[0].runtimeKey = 'changed-runtime';
  assert.throws(
    () => parseSiteBackupManifest(JSON.stringify(tampered)),
    /checksum mismatch/,
  );
});

test('v1 maps Site application to primary and secondary domains to CUSTOM', () => {
  const manifest = normalizeSiteBackupManifest({
    manifestVersion: 1,
    site: {
      id: siteId,
      name: 'legacy',
      rootPath: '/var/www/legacy',
      nginxConfigPath: '/etc/nginx/sites-available/legacy.conf',
      type: 'MODX_REVO',
      status: 'RUNNING',
      filesRelPath: 'www',
      phpVersion: '8.1',
      cmsAdminUser: 'admin',
      envVars: '{}',
    },
    domains: [
      {
        id: primaryId,
        domain: 'legacy.example.test',
        isPrimary: true,
        position: 0,
      },
      {
        id: secondaryId,
        domain: 'legacy-api.example.test',
        position: 1,
      },
    ],
    databases: [
      {
        id: databaseId,
        name: 'legacy_db',
        type: 'MARIADB',
        dbUser: 'legacy_user',
      },
    ],
  });

  assert.equal(manifest.manifestVersion, 2);
  assert.equal(manifest.domains[0].preset, 'MODX_REVO');
  assert.equal(manifest.domains[0].phpVersion, '8.1');
  assert.equal(manifest.domains[1].preset, 'CUSTOM');
  assert.equal(manifest.domains[1].phpVersion, '8.1');
  assert.equal(manifest.databases[0].sourceSiteDomainId, primaryId);
  assert.equal(manifest.databases[0].purpose, 'APP_PRIMARY');
});

test('exact restore preserves domain and database ownership mapping', async () => {
  const backedUpSite = sourceSite();
  const manifest = buildSiteBackupManifest({
    site: backedUpSite,
    backupType: 'FULL',
    includedDatabaseIds: [databaseId],
    createdAt: new Date('2026-07-31T00:00:00.000Z'),
  });
  const currentSite = sourceSite();
  currentSite.domains[0] = domain({
    runtimeKey: 'current-primary',
    phpVersion: '8.4',
  });
  const prisma = {
    siteDomain: {
      findMany: async () =>
        currentSite.domains.map((item) => ({
          id: item.id,
          domain: item.domain,
          aliases: item.aliases,
          runtimeKey: item.runtimeKey,
          appPort: item.appPort,
        })),
    },
  };
  const service = new BackupsService(
    prisma,
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {},
  );

  const plan = await service.planExactRestore(currentSite, manifest);
  assert.deepEqual(plan.domainTargets, [
    { sourceId: primaryId, targetId: primaryId },
    { sourceId: secondaryId, targetId: secondaryId },
  ]);
  assert.deepEqual(plan.databaseTargets, [
    { sourceId: databaseId, targetId: databaseId },
  ]);
  assert.deepEqual(plan.databasesForAgent, [
    {
      name: 'example_db',
      sourceName: 'example_db',
      type: 'MARIADB',
    },
  ]);
  assert.equal(
    parseSiteBackupManifest(plan.rollbackManifest).domains[0].runtimeKey,
    'current-primary',
  );
});

test('exact restore rejects diverged topology before content mutation', async () => {
  const site = sourceSite();
  const manifest = buildSiteBackupManifest({
    site,
    backupType: 'FULL',
    includedDatabaseIds: [databaseId],
  });
  const service = new BackupsService(
    { siteDomain: { findMany: async () => [] } },
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {},
  );

  await assert.rejects(
    () =>
      service.planExactRestore(
        { ...site, domains: site.domains.slice(0, 1) },
        manifest,
      ),
    /unchanged domain and database topology/,
  );
});
