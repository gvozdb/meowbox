'use strict';

const { execFile } = require('node:child_process');
const { readdir, readFile, rm, writeFile } = require('node:fs/promises');
const { dirname, join } = require('node:path');
const { promisify } = require('node:util');

const execFileP = promisify(execFile);

const IDS = Object.freeze({
  user: '00000000-0000-4000-8000-000000000001',
  modx2Site: '10000000-0000-4000-8000-000000000001',
  modx2Domain: '11000000-0000-4000-8000-000000000001',
  modx2Database: '12000000-0000-4000-8000-000000000001',
  modx3Site: '20000000-0000-4000-8000-000000000001',
  modx3Domain: '21000000-0000-4000-8000-000000000001',
  modx3Database: '22000000-0000-4000-8000-000000000001',
  multiSite: '30000000-0000-4000-8000-000000000001',
  multiPrimary: '31000000-0000-4000-8000-000000000001',
  multiPhpSecondary: '31000000-0000-4000-8000-000000000002',
  multiNodeSecondary: '31000000-0000-4000-8000-000000000003',
  multiPrimaryDatabase: '32000000-0000-4000-8000-000000000001',
  multiAuxDatabase: '32000000-0000-4000-8000-000000000002',
  sharedSite: '40000000-0000-4000-8000-000000000001',
  sharedPrimary: '41000000-0000-4000-8000-000000000001',
  sharedSecondary: '41000000-0000-4000-8000-000000000002',
});

const NOW = '2026-07-30T12:00:00.000Z';

const legacyFixtureSql = `
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

INSERT INTO "users" (
  "id", "username", "email", "password_hash", "role", "totp_enabled",
  "created_at", "updated_at"
) VALUES (
  '${IDS.user}', 'fixture_operator', 'fixture@example.test', 'fixture-not-a-real-password-hash',
  'ADMIN', 0, '${NOW}', '${NOW}'
);

INSERT INTO "sites" (
  "id", "name", "domain", "aliases", "type", "status", "php_version",
  "git_repository", "deploy_branch", "app_port", "env_vars", "root_path",
  "nginx_config_path", "site_user", "cms_admin_user", "manager_path",
  "connectors_path", "db_enabled", "https_redirect", "files_rel_path",
  "user_id", "created_at", "updated_at", "modx_version", "display_name",
  "error_message", "php_pool_custom", "cms_table_prefix", "nginx_custom_config"
) VALUES
(
  '${IDS.modx2Site}', 'modx2app', 'modx2.example.test',
  '[{"domain":"www.modx2.example.test","redirect":true}]', 'MODX_REVO',
  'RUNNING', '8.2', NULL, 'main', NULL, '{"FIXTURE_MODE":"safe"}',
  '/srv/meowbox/sites/modx2app', '/etc/nginx/sites-available/modx2.example.test.conf',
  'modx2app', 'fixture_admin', 'manager', 'connectors', 1, 1, 'www',
  '${IDS.user}', '${NOW}', '${NOW}', '2.8.8-pl', 'Fixture MODX 2',
  NULL, 'php_admin_value[memory_limit] = 256M
php_admin_value[open_basedir] = /legacy/modx2
request_terminate_timeout = 300
pm.max_children = 4', 'modx_', '# fixture custom nginx'
),
(
  '${IDS.modx3Site}', 'modx3app', 'modx3.example.test', '[]', 'MODX_3',
  'ERROR', '8.3', NULL, 'main', NULL, '{}',
  '/srv/meowbox/sites/modx3app', '/etc/nginx/sites-available/modx3.example.test.conf',
  'modx3app', 'fixture_admin', 'manager', 'connectors', 1, 1, 'public',
  '${IDS.user}', '${NOW}', '${NOW}', '3.1.2-pl', 'Fixture MODX 3',
  'Fixture deployment interrupted', 'pm.max_children = 3', 'modx3_', NULL
),
(
  '${IDS.multiSite}', 'custommulti', 'app.example.test',
  '[{"domain":"www.app.example.test","redirect":false}]', 'CUSTOM',
  'RUNNING', '8.1', 'git@example.test:fixture/custom.git', 'main', NULL,
  '{"APP_ENV":"fixture"}', '/srv/meowbox/sites/custommulti',
  '/etc/nginx/sites-available/app.example.test.conf', 'custommulti',
  NULL, NULL, NULL, 1, 1, 'www', '${IDS.user}', '${NOW}', '${NOW}',
  NULL, 'Fixture multi-app', NULL, 'php_admin_value[memory_limit] = 192M
pm.max_children = 5', NULL, NULL
),
(
  '${IDS.sharedSite}', 'sharedroot', 'shared.example.test', '[]', 'CUSTOM',
  'RUNNING', NULL, NULL, 'main', NULL, '{}',
  '/srv/meowbox/sites/sharedroot', '/etc/nginx/sites-available/shared.example.test.conf',
  'sharedroot', NULL, NULL, NULL, 0, 1, 'www', '${IDS.user}', '${NOW}',
  '${NOW}', NULL, 'Fixture shared root', NULL, NULL, NULL, NULL
);

INSERT INTO "site_domains" (
  "id", "site_id", "domain", "is_primary", "position", "aliases",
  "files_rel_path", "app_port", "https_redirect", "nginx_http2",
  "nginx_hsts", "nginx_gzip", "nginx_rate_limit_enabled",
  "nginx_custom_config", "created_at", "updated_at"
) VALUES
(
  '${IDS.modx2Domain}', '${IDS.modx2Site}', 'modx2.example.test', 1, 0,
  '[{"domain":"www.modx2.example.test","redirect":true}]', NULL, NULL, 1,
  1, 1, 1, 1, '# modx2 domain fixture', '${NOW}', '${NOW}'
),
(
  '${IDS.modx3Domain}', '${IDS.modx3Site}', 'modx3.example.test', 1, 0,
  '[]', 'public', NULL, 1, 1, 0, 1, 1, NULL, '${NOW}', '${NOW}'
),
(
  '${IDS.multiPrimary}', '${IDS.multiSite}', 'app.example.test', 1, 0,
  '[{"domain":"www.app.example.test","redirect":false}]', NULL, NULL, 1,
  1, 0, 1, 1, '# primary fixture', '${NOW}', '${NOW}'
),
(
  '${IDS.multiPhpSecondary}', '${IDS.multiSite}', 'api.example.test', 0, 1,
  '[]', NULL, NULL, 1, 1, 0, 1, 1, '# php secondary fixture', '${NOW}', '${NOW}'
),
(
  '${IDS.multiNodeSecondary}', '${IDS.multiSite}', 'node.example.test', 0, 2,
  '[{"domain":"node-alias.example.test","redirect":true}]', 'node', 3100, 1,
  1, 0, 1, 1, '# node secondary fixture', '${NOW}', '${NOW}'
),
(
  '${IDS.sharedPrimary}', '${IDS.sharedSite}', 'shared.example.test', 1, 0,
  '[]', 'www', NULL, 1, 1, 0, 1, 1, NULL, '${NOW}', '${NOW}'
),
(
  '${IDS.sharedSecondary}', '${IDS.sharedSite}', 'shared-alt.example.test', 0, 1,
  '[]', 'www', 4200, 1, 1, 0, 1, 1, NULL, '${NOW}', '${NOW}'
);

INSERT INTO "databases" (
  "id", "name", "type", "db_user", "db_password_hash", "site_id",
  "size_bytes", "created_at", "updated_at", "db_password_enc"
) VALUES
(
  '${IDS.modx2Database}', 'modx2app', 'MARIADB', 'modx2app',
  'fixture-hash', '${IDS.modx2Site}', 1024, '${NOW}', '${NOW}', 'fixture-ciphertext'
),
(
  '${IDS.modx3Database}', 'modx3app', 'MARIADB', 'modx3app',
  'fixture-hash', '${IDS.modx3Site}', 2048, '${NOW}', '${NOW}', 'fixture-ciphertext'
),
(
  '${IDS.multiPrimaryDatabase}', 'custommulti', 'MARIADB', 'custommulti',
  'fixture-hash', '${IDS.multiSite}', 4096, '${NOW}', '${NOW}', 'fixture-ciphertext'
),
(
  '${IDS.multiAuxDatabase}', 'fixture_analytics', 'POSTGRESQL', 'fixture_analytics',
  'fixture-hash', '${IDS.multiSite}', 8192, '${NOW}', '${NOW}', 'fixture-ciphertext'
);

INSERT INTO "ssl_certificates" (
  "id", "site_id", "domain_id", "domains", "status", "issuer",
  "is_wildcard", "issued_at", "expires_at", "days_remaining",
  "cert_path", "key_path", "created_at", "updated_at"
) VALUES (
  '50000000-0000-4000-8000-000000000001', '${IDS.modx2Site}', '${IDS.modx2Domain}',
  '["modx2.example.test","www.modx2.example.test"]', 'ACTIVE', 'Fixture CA', 0,
  '${NOW}', '2027-07-30T12:00:00.000Z', 365,
  '/fixture/cert.pem', '/fixture/key.pem', '${NOW}', '${NOW}'
);

INSERT INTO "deploy_logs" (
  "id", "site_id", "status", "commit_sha", "commit_message", "branch",
  "output", "triggered_by", "duration_ms", "started_at", "completed_at", "created_at"
) VALUES (
  '60000000-0000-4000-8000-000000000001', '${IDS.multiSite}', 'SUCCESS',
  'fixture-sha', 'fixture deploy', 'main', 'fixture output', 'fixture', 100,
  '${NOW}', '${NOW}', '${NOW}'
);

COMMIT;
`;

const legacyAlignmentFixtureSql = `
INSERT INTO "server_path_backup_configs" (
  "id", "name", "path", "warning_acknowledged", "enabled", "updated_at"
) VALUES (
  'alignment-server-config', 'Alignment server config', '/var/log', 1, 1, '${NOW}'
);
INSERT INTO "server_path_backups" (
  "id", "config_id", "status", "engine", "file_path"
) VALUES (
  'alignment-server-backup', 'alignment-server-config',
  'COMPLETED', 'TAR', '/tmp/alignment-server.tar.gz'
);
INSERT INTO "panel_data_backup_configs" (
  "id", "name", "enabled", "updated_at"
) VALUES (
  'alignment-panel-config', 'Alignment panel config', 0, '${NOW}'
);
INSERT INTO "panel_data_backups" (
  "id", "config_id", "status", "engine"
) VALUES (
  'alignment-panel-backup', 'alignment-panel-config', 'FAILED', 'RESTIC'
);
INSERT INTO "site_backup_schedules" (
  "id", "name", "enabled", "check_enabled", "check_read_data", "updated_at"
) VALUES (
  'alignment-schedule', 'Alignment schedule', 1, 1, 0, '${NOW}'
);
INSERT INTO "notification_digest_queue" (
  "id", "config_type", "config_id", "config_name", "event", "resource_label"
) VALUES (
  'alignment-digest', 'SITE_SCHEDULE', 'alignment-schedule',
  'Alignment schedule', 'BACKUP_COMPLETED', 'fixture'
);`;

const runtimeEvidence = Object.freeze({
  domains: {
    [IDS.modx2Domain]: {
      phpEnabled: true,
      modxDatabaseName: 'modx2app',
      poolMaxChildren: 4,
    },
    [IDS.modx3Domain]: {
      phpEnabled: true,
      modxDatabaseName: 'modx3app',
      poolMaxChildren: 3,
    },
    [IDS.multiPrimary]: {
      phpEnabled: true,
      poolMaxChildren: 5,
    },
    [IDS.multiPhpSecondary]: {
      phpEnabled: true,
    },
    [IDS.multiNodeSecondary]: {
      phpEnabled: false,
    },
  },
});

const DOMAIN_RELEASE_MIGRATIONS = new Set([
  'z20260731000000_domain_centric_applications',
  'zz20260731102000_backup_manifest_v2',
  'zz20260731103000_deploy_operations',
  'zz20260731104000_backup_schema_alignment',
]);

const V0664_PRISMA_SCHEMA_LINEAGES = Object.freeze({
  canonical: Object.freeze(['v0.6.64']),
  sequential: Object.freeze([
    'v0.6.0',
    'v0.6.15',
    'v0.6.16',
    'v0.6.17',
    'v0.6.23',
    'v0.6.27',
    'v0.6.35',
    'v0.6.36',
    'v0.6.43',
    'v0.6.50',
  ]),
});

async function createLegacyCoreFixture(dbPath, prismaMigrationsDir, runSqliteScript) {
  await writeFile(dbPath, '', { flag: 'wx', mode: 0o600 });
  const entries = await readdir(prismaMigrationsDir, { withFileTypes: true });
  const migrationNames = entries
    .filter((entry) => entry.isDirectory() && !DOMAIN_RELEASE_MIGRATIONS.has(entry.name))
    .map((entry) => entry.name)
    .sort();

  for (const migrationName of migrationNames) {
    const sql = await readFile(join(prismaMigrationsDir, migrationName, 'migration.sql'), 'utf8');
    await runSqliteScript(dbPath, sql);
  }
  await runSqliteScript(dbPath, legacyFixtureSql);
}

async function createV0664PrismaFixture(
  dbPath,
  projectRoot,
  runSqliteScript,
  lineage = 'canonical',
) {
  const schemaTags = V0664_PRISMA_SCHEMA_LINEAGES[lineage];
  if (schemaTags === undefined) throw new Error(`Unknown v0.6.64 schema lineage: ${lineage}`);
  const prismaBin = join(projectRoot, 'api', 'node_modules', '.bin', 'prisma');
  const schemaPaths = [];
  await writeFile(dbPath, '', { flag: 'wx', mode: 0o600 });
  try {
    for (const schemaTag of schemaTags) {
      const schemaPath = join(
        dirname(dbPath),
        `${lineage}-${schemaTag}-schema.prisma`,
      );
      const { stdout: schema } = await execFileP(
        'git',
        ['show', `${schemaTag}:api/prisma/schema.prisma`],
        { cwd: projectRoot, maxBuffer: 2 * 1024 * 1024 },
      );
      await writeFile(schemaPath, schema, { flag: 'wx', mode: 0o600 });
      schemaPaths.push(schemaPath);
    }
    for (const [index, schemaPath] of schemaPaths.entries()) {
      const from = index === 0
        ? ['--from-empty']
        : ['--from-url', `file:${dbPath}`];
      const { stdout: ddl } = await execFileP(
        prismaBin,
        [
          'migrate',
          'diff',
          ...from,
          '--to-schema-datamodel',
          schemaPath,
          '--script',
        ],
        {
          cwd: join(projectRoot, 'api'),
          env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      await runSqliteScript(dbPath, ddl);
    }
    await runSqliteScript(dbPath, legacyFixtureSql + legacyAlignmentFixtureSql);
  } finally {
    await Promise.all(schemaPaths.map((schemaPath) => rm(schemaPath, { force: true })));
  }
}

module.exports = {
  IDS,
  createLegacyCoreFixture,
  createV0664PrismaFixture,
  legacyAlignmentFixtureSql,
  legacyFixtureSql,
  runtimeEvidence,
};
