'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { promisify } = require('node:util');
const {
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { basename, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const {
  applyBaseline,
  applyLegacyMigrationMap,
  assessBaseline,
  buildLegacyMigrationMap,
  checkMigrationInvariants,
  fingerprintDatabaseFiles,
  loadBaselineContract,
  normalizeRelativePath,
  querySqliteJson,
  runSqliteScript,
} = require('../dist/release');
const {
  IDS,
  legacyFixtureSql,
  runtimeEvidence,
} = require('./fixtures/domain-applications');

const execFileP = promisify(execFile);
const migrationsDir = resolve(process.cwd());
const projectRoot = resolve(migrationsDir, '..');
const apiDir = join(projectRoot, 'api');
const prismaMigrationsDir = join(apiDir, 'prisma', 'migrations');
const prismaSchema = join(apiDir, 'prisma', 'schema.prisma');
const prismaBin = join(apiDir, 'node_modules', '.bin', 'prisma');
const baselineContractPath = join(
  migrationsDir,
  'release',
  'supported-baselines.json',
);

function assertTemporaryPath(path) {
  const expectedPrefix = `${resolve(tmpdir())}/meowbox-domain-release-test-`;
  assert.ok(
    resolve(path).startsWith(expectedPrefix),
    `refusing test write outside ${expectedPrefix}`,
  );
}

async function applyHistoricalSchema(dbPath) {
  assertTemporaryPath(dbPath);
  await writeFile(dbPath, '', { flag: 'wx', mode: 0o600 });
  const entries = await readdir(prismaMigrationsDir, { withFileTypes: true });
  const migrationNames = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        ![
          'z20260731000000_domain_centric_applications',
          'zz20260731102000_backup_manifest_v2',
          'zz20260731103000_deploy_operations',
          'zz20260731104000_backup_schema_alignment',
        ].includes(entry.name),
    )
    .map((entry) => entry.name)
    .sort();

  for (const migrationName of migrationNames) {
    const sql = await readFile(
      join(prismaMigrationsDir, migrationName, 'migration.sql'),
      'utf8',
    );
    await runSqliteScript(dbPath, sql);
  }
}

async function createLegacyFixture(dbPath) {
  await applyHistoricalSchema(dbPath);
  await runSqliteScript(dbPath, legacyFixtureSql);
  await runSqliteScript(
    dbPath,
    `INSERT INTO "server_path_backup_configs" (
       "id", "name", "path", "warning_acknowledged", "enabled"
     ) VALUES (
       'alignment-server-config', 'Alignment server config', '/var/log', 1, 1
     );
     INSERT INTO "server_path_backups" (
       "id", "config_id", "status", "engine", "file_path"
     ) VALUES (
       'alignment-server-backup', 'alignment-server-config',
       'COMPLETED', 'TAR', '/tmp/alignment-server.tar.gz'
     );
     INSERT INTO "panel_data_backup_configs" (
       "id", "name", "enabled"
     ) VALUES (
       'alignment-panel-config', 'Alignment panel config', 0
     );
     INSERT INTO "panel_data_backups" (
       "id", "config_id", "status", "engine"
     ) VALUES (
       'alignment-panel-backup', 'alignment-panel-config',
       'FAILED', 'RESTIC'
     );
     INSERT INTO "site_backup_schedules" (
       "id", "name", "enabled", "check_enabled", "check_read_data"
     ) VALUES (
       'alignment-schedule', 'Alignment schedule', 1, 1, 0
     );
     INSERT INTO "notification_digest_queue" (
       "id", "config_type", "config_id", "config_name", "event",
       "resource_label"
     ) VALUES (
       'alignment-digest', 'SITE_SCHEDULE', 'alignment-schedule',
       'Alignment schedule', 'BACKUP_COMPLETED', 'fixture'
     );`,
  );
}

async function prismaMigrateDeploy(dbPath) {
  assertTemporaryPath(dbPath);
  return execFileP(
    prismaBin,
    ['migrate', 'deploy', '--schema', prismaSchema],
    {
      cwd: apiDir,
      env: {
        ...process.env,
        DATABASE_URL: pathToFileURL(dbPath).href,
      },
      maxBuffer: 2 * 1024 * 1024,
      timeout: 120_000,
    },
  );
}

async function runSystemMigrationRunner(dbPath, args) {
  assertTemporaryPath(dbPath);
  return execFileP(process.execPath, [join(migrationsDir, 'dist', 'runner.js'), ...args], {
    cwd: migrationsDir,
    env: {
      ...process.env,
      DATABASE_URL: pathToFileURL(dbPath).href,
      MEOWBOX_RELEASE_LOCK_HELD: '1',
    },
    maxBuffer: 2 * 1024 * 1024,
    timeout: 120_000,
  });
}

async function columns(dbPath, table) {
  const rows = await querySqliteJson(dbPath, `PRAGMA table_xinfo("${table}");`);
  return rows.map((row) => row.name);
}

async function scalar(dbPath, sql, column) {
  const rows = await querySqliteJson(dbPath, sql);
  assert.equal(rows.length, 1);
  return rows[0][column];
}

test('release path validation matches API and agent runtime contracts', () => {
  assert.equal(normalizeRelativePath('./www//public'), 'www/public');
  assert.equal(normalizeRelativePath('www\\public'), 'www/public');
  assert.equal(normalizeRelativePath('../outside').code, 'PATH_TRAVERSAL');
  assert.equal(normalizeRelativePath('/etc').code, 'PATH_ABSOLUTE');
  assert.equal(normalizeRelativePath('C:\\Windows').code, 'PATH_ABSOLUTE');
  assert.equal(
    normalizeRelativePath('www/public folder').code,
    'PATH_CHARACTERS',
  );
});

test(
  'legacy fixture maps deterministically, blocks missing map, migrates once, and preserves ownership',
  { timeout: 180_000 },
  async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), 'meowbox-domain-release-test-'),
    );
    const legacyDb = join(tempRoot, 'legacy.db');
    const missingMapDb = join(tempRoot, 'missing-map.db');
    const unsafeMapDb = join(tempRoot, 'unsafe-map.db');
    const historyGapDb = join(tempRoot, 'history-gap.db');

    try {
      await createLegacyFixture(legacyDb);
      const contract = await loadBaselineContract(baselineContractPath);
      const baselineCounts = {
        sites: 4,
        siteDomains: 7,
        databases: 4,
      };

      const beforeReadOnly = await fingerprintDatabaseFiles(legacyDb);
      const assessment = await assessBaseline({
        dbPath: legacyDb,
        apiDir,
        contract,
      });
      assert.equal(assessment.ok, true, JSON.stringify(assessment.blockers));
      assert.equal(assessment.decision, 'baseline-required');
      assert.equal(assessment.legacyMappingRequired, true);

      const firstMap = await buildLegacyMigrationMap({
        dbPath: legacyDb,
        runtimeEvidence,
      });
      const secondMap = await buildLegacyMigrationMap({
        dbPath: legacyDb,
        runtimeEvidence,
      });
      assert.equal(firstMap.ok, true, JSON.stringify(firstMap.blockers));
      assert.equal(secondMap.ok, true, JSON.stringify(secondMap.blockers));
      assert.equal(firstMap.envelope.mapSha256, secondMap.envelope.mapSha256);
      assert.deepEqual(firstMap.envelope.rows, secondMap.envelope.rows);
      assert.deepEqual(await fingerprintDatabaseFiles(legacyDb), beforeReadOnly);

      const baseline = await applyBaseline({
        dbPath: legacyDb,
        apiDir,
        contract,
        writeMode: 'clone',
      });
      assert.equal(baseline.changed, true);

      await copyFile(legacyDb, missingMapDb);
      await assert.rejects(
        prismaMigrateDeploy(missingMapDb),
        /migration|constraint|failed/i,
      );
      assert.ok((await columns(missingMapDb, 'sites')).includes('type'));
      assert.equal(
        await scalar(
          missingMapDb,
          'SELECT COUNT(*) AS count FROM "site_domains";',
          'count',
        ),
        7,
      );

      const appliedMap = await applyLegacyMigrationMap({
        dbPath: legacyDb,
        runtimeEvidence,
        writeMode: 'clone',
      });
      assert.equal(appliedMap.report.ok, true);
      assert.equal(appliedMap.changed, true);

      const repeatedMap = await applyLegacyMigrationMap({
        dbPath: legacyDb,
        runtimeEvidence,
        writeMode: 'clone',
      });
      assert.equal(repeatedMap.report.ok, true);
      assert.equal(repeatedMap.changed, false);

      await copyFile(legacyDb, unsafeMapDb);
      await runSqliteScript(
        unsafeMapDb,
        `UPDATE "_meowbox_domain_migration_map"
         SET "files_rel_path" = 'www/unsafe path'
         WHERE "row_kind" = 'DOMAIN'
           AND "source_id" = '${IDS.multiPrimary}';`,
      );
      await assert.rejects(
        prismaMigrateDeploy(unsafeMapDb),
        /migration|constraint|failed/i,
      );
      assert.ok((await columns(unsafeMapDb, 'sites')).includes('type'));

      const guardDiagnostics = await querySqliteJson(
        legacyDb,
        `SELECT
          ((SELECT COUNT(*) FROM "sites") > 0
            AND (SELECT COUNT(*) FROM "_meowbox_domain_migration_map") =
              (SELECT COUNT(*) FROM "sites") +
              (SELECT COUNT(*) FROM "site_domains") +
              (SELECT COUNT(*) FROM "databases")) AS coverage,
          (NOT EXISTS (
            SELECT 1 FROM "_meowbox_domain_migration_map" AS m
            WHERE m."contract_version" <> 1
               OR m."row_kind" NOT IN ('SITE', 'DOMAIN', 'DATABASE')
               OR length(trim(m."source_id")) = 0
               OR length(trim(m."site_id")) = 0
               OR length(trim(m."primary_site_domain_id")) = 0
               OR length(trim(m."source_db_checksum")) = 0
               OR length(trim(m."source_fingerprint")) = 0
          )) AS map_shape,
          (NOT EXISTS (
            SELECT 1 FROM "sites" AS s
            LEFT JOIN "users" AS u ON u."id" = s."user_id"
            WHERE s."user_id" IS NULL OR u."id" IS NULL
          )) AS site_users,
          (NOT EXISTS (
            SELECT 1 FROM "sites" AS s
            WHERE (
              SELECT COUNT(*) FROM "site_domains" AS d
              WHERE d."site_id" = s."id" AND d."is_primary" = 1
            ) <> 1
          )) AS primary_count,
          (NOT EXISTS (
            SELECT 1 FROM "sites" AS s
            LEFT JOIN "_meowbox_domain_migration_map" AS m
              ON m."row_kind" = 'SITE' AND m."source_id" = s."id"
            LEFT JOIN "site_domains" AS p
              ON p."id" = m."primary_site_domain_id"
             AND p."site_id" = s."id"
             AND p."is_primary" = 1
            WHERE m."source_id" IS NULL
               OR m."site_id" <> s."id"
               OR m."site_domain_id" IS NULL
               OR m."site_domain_id" <> m."primary_site_domain_id"
               OR p."id" IS NULL
          )) AS site_rows,
          (NOT EXISTS (
            SELECT 1
            FROM "site_domains" AS d
            JOIN "sites" AS s ON s."id" = d."site_id"
            LEFT JOIN "_meowbox_domain_migration_map" AS m
              ON m."row_kind" = 'DOMAIN' AND m."source_id" = d."id"
            WHERE m."source_id" IS NULL
               OR m."site_id" <> d."site_id"
               OR m."site_domain_id" IS NULL
               OR m."site_domain_id" <> d."id"
               OR m."database_id" IS NOT NULL
               OR m."preset" IS NULL
               OR m."preset" NOT IN ('MODX_REVO', 'MODX_3', 'CUSTOM')
               OR m."app_status" IS NULL
               OR m."app_status" NOT IN ('RUNNING', 'ERROR')
               OR m."files_rel_path" IS NULL
               OR m."runtime_key" IS NULL
               OR (
                 d."is_primary" = 1 AND (
                   m."preset" <> s."type"
                   OR m."runtime_key" <> s."name"
                   OR NOT (m."app_port" IS COALESCE(d."app_port", s."app_port"))
                   OR NOT (m."php_version" IS s."php_version")
                 )
               )
               OR (
                 d."is_primary" = 0 AND (
                   m."preset" <> 'CUSTOM'
                   OR NOT (m."app_port" IS d."app_port")
                 )
               )
          )) AS domain_rows,
          (NOT EXISTS (
            SELECT 1
            FROM "databases" AS db
            LEFT JOIN "_meowbox_domain_migration_map" AS m
              ON m."row_kind" = 'DATABASE' AND m."source_id" = db."id"
            LEFT JOIN "site_domains" AS d ON d."id" = m."site_domain_id"
            WHERE m."source_id" IS NULL
               OR db."site_id" IS NULL
               OR m."database_id" IS NULL
               OR m."database_id" <> db."id"
               OR m."site_id" <> db."site_id"
               OR m."site_domain_id" IS NULL
               OR d."id" IS NULL
               OR d."site_id" <> db."site_id"
               OR m."purpose" IS NULL
               OR m."purpose" NOT IN ('APP_PRIMARY', 'AUXILIARY')
          )) AS database_rows,
          (NOT EXISTS (
            SELECT 1
            FROM "_meowbox_domain_migration_map" AS dm
            WHERE dm."row_kind" = 'DOMAIN'
              AND dm."preset" IN ('MODX_REVO', 'MODX_3')
              AND (
                SELECT COUNT(*)
                FROM "_meowbox_domain_migration_map" AS bm
                JOIN "databases" AS db ON db."id" = bm."database_id"
                WHERE bm."row_kind" = 'DATABASE'
                  AND bm."site_domain_id" = dm."site_domain_id"
                  AND bm."purpose" = 'APP_PRIMARY'
                  AND db."type" IN ('MARIADB', 'MYSQL')
              ) <> 1
          )) AS modx_databases,
          ((SELECT "integrity_check" FROM pragma_integrity_check LIMIT 1) = 'ok') AS integrity_ok,
          (NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)) AS foreign_keys_ok;`,
      );
      const domainMapDebug = await querySqliteJson(
        legacyDb,
        `SELECT
           d."id", d."is_primary", d."app_port" AS domain_app_port,
           s."type" AS site_preset, s."name" AS site_runtime_key,
           s."app_port" AS site_app_port, s."php_version" AS site_php_version,
           s."php_pool_custom" AS site_php_pool_custom,
           m."preset", m."app_status", m."files_rel_path", m."runtime_key",
           m."app_port", m."php_version", m."php_pool_custom"
         FROM "site_domains" AS d
         JOIN "sites" AS s ON s."id" = d."site_id"
         LEFT JOIN "_meowbox_domain_migration_map" AS m
           ON m."row_kind" = 'DOMAIN' AND m."source_id" = d."id"
         ORDER BY d."id";`,
      );
      assert.deepEqual(guardDiagnostics, [
        {
          coverage: 1,
          map_shape: 1,
          site_users: 1,
          primary_count: 1,
          site_rows: 1,
          domain_rows: 1,
          database_rows: 1,
          modx_databases: 1,
          integrity_ok: 1,
          foreign_keys_ok: 1,
        },
      ], JSON.stringify(domainMapDebug));

      await prismaMigrateDeploy(legacyDb);
      const invariants = await checkMigrationInvariants({
        dbPath: legacyDb,
        phase: 'final',
        baselineCounts,
      });
      assert.equal(invariants.ok, true, JSON.stringify(invariants.blockers));
      assert.deepEqual(invariants.counts, baselineCounts);

      const siteColumns = await columns(legacyDb, 'sites');
      for (const removed of [
        'domain',
        'aliases',
        'type',
        'php_version',
        'files_rel_path',
        'app_port',
        'env_vars',
      ]) {
        assert.equal(siteColumns.includes(removed), false, removed);
      }
      const backupColumns = await columns(legacyDb, 'backups');
      assert.ok(backupColumns.includes('manifest'));
      assert.ok(backupColumns.includes('restore_context'));
      assert.equal(
        await scalar(
          legacyDb,
          `SELECT
             (SELECT COUNT(*) FROM "server_path_backup_configs"
              WHERE "id" = 'alignment-server-config') +
             (SELECT COUNT(*) FROM "server_path_backups"
              WHERE "id" = 'alignment-server-backup') +
             (SELECT COUNT(*) FROM "panel_data_backup_configs"
              WHERE "id" = 'alignment-panel-config') +
             (SELECT COUNT(*) FROM "panel_data_backups"
              WHERE "id" = 'alignment-panel-backup') +
             (SELECT COUNT(*) FROM "site_backup_schedules"
              WHERE "id" = 'alignment-schedule') +
             (SELECT COUNT(*) FROM "notification_digest_queue"
              WHERE "id" = 'alignment-digest') AS count;`,
          'count',
        ),
        6,
      );
      assert.deepEqual(
        await querySqliteJson(
          legacyDb,
          `SELECT "name", "type", "notnull"
           FROM pragma_table_info('server_path_backup_configs')
           WHERE "name" IN ('id', 'warning_acknowledged', 'enabled')
           ORDER BY "name";`,
        ),
        [
          { name: 'enabled', type: 'BOOLEAN', notnull: 1 },
          { name: 'id', type: 'TEXT', notnull: 1 },
          { name: 'warning_acknowledged', type: 'BOOLEAN', notnull: 1 },
        ],
      );

      const domains = await querySqliteJson(
        legacyDb,
        `SELECT "id", "preset", "app_status", "app_error_message",
                "files_rel_path", "php_version", "php_pool_custom",
                "runtime_key", "app_port"
         FROM "site_domains"
         ORDER BY "position", "id";`,
      );
      const byId = new Map(domains.map((domain) => [domain.id, domain]));

      assert.equal(byId.get(IDS.modx2Domain).preset, 'MODX_REVO');
      assert.equal(byId.get(IDS.modx2Domain).runtime_key, 'modx2app');
      assert.match(byId.get(IDS.modx2Domain).php_pool_custom, /pm\.max_children = 4/);
      assert.match(
        byId.get(IDS.modx2Domain).php_pool_custom,
        /request_terminate_timeout = 300/,
      );
      assert.doesNotMatch(
        byId.get(IDS.modx2Domain).php_pool_custom,
        /legacy\/modx2/,
      );
      assert.equal(byId.get(IDS.modx3Domain).preset, 'MODX_3');
      assert.equal(byId.get(IDS.modx3Domain).app_status, 'ERROR');
      assert.equal(
        byId.get(IDS.modx3Domain).app_error_message,
        'Fixture deployment interrupted',
      );

      assert.equal(byId.get(IDS.multiPrimary).preset, 'CUSTOM');
      assert.equal(byId.get(IDS.multiPrimary).files_rel_path, 'www');
      assert.equal(byId.get(IDS.multiPrimary).php_version, '8.1');
      assert.match(
        byId.get(IDS.multiPrimary).php_pool_custom,
        /pm\.max_children = 3/,
      );
      assert.equal(byId.get(IDS.multiPhpSecondary).preset, 'CUSTOM');
      assert.equal(byId.get(IDS.multiPhpSecondary).files_rel_path, 'www');
      assert.equal(byId.get(IDS.multiPhpSecondary).php_version, '8.1');
      assert.match(
        byId.get(IDS.multiPhpSecondary).php_pool_custom,
        /pm\.max_children = 2/,
      );
      assert.equal(byId.get(IDS.multiNodeSecondary).php_version, null);
      assert.equal(byId.get(IDS.multiNodeSecondary).app_port, 3100);
      assert.equal(byId.get(IDS.sharedPrimary).files_rel_path, 'www');
      assert.equal(byId.get(IDS.sharedSecondary).files_rel_path, 'www');
      assert.equal(byId.get(IDS.sharedSecondary).app_port, 4200);

      const databases = await querySqliteJson(
        legacyDb,
        `SELECT "id", "site_domain_id", "purpose"
         FROM "databases"
         ORDER BY "id";`,
      );
      const databaseById = new Map(
        databases.map((database) => [database.id, database]),
      );
      assert.deepEqual(
        [
          databaseById.get(IDS.modx2Database).site_domain_id,
          databaseById.get(IDS.modx2Database).purpose,
        ],
        [IDS.modx2Domain, 'APP_PRIMARY'],
      );
      assert.deepEqual(
        [
          databaseById.get(IDS.modx3Database).site_domain_id,
          databaseById.get(IDS.modx3Database).purpose,
        ],
        [IDS.modx3Domain, 'APP_PRIMARY'],
      );
      assert.deepEqual(
        [
          databaseById.get(IDS.multiPrimaryDatabase).site_domain_id,
          databaseById.get(IDS.multiPrimaryDatabase).purpose,
        ],
        [IDS.multiPrimary, 'APP_PRIMARY'],
      );
      assert.deepEqual(
        [
          databaseById.get(IDS.multiAuxDatabase).site_domain_id,
          databaseById.get(IDS.multiAuxDatabase).purpose,
        ],
        [IDS.multiPrimary, 'AUXILIARY'],
      );

      assert.equal(
        await scalar(
          legacyDb,
          `SELECT "site_domain_id" AS domain_id
           FROM "deploy_logs"
           WHERE "id" = '60000000-0000-4000-8000-000000000001';`,
          'domain_id',
        ),
        IDS.multiPrimary,
      );
      assert.equal(
        await scalar(
          legacyDb,
          `SELECT COUNT(*) AS count
           FROM "ssl_certificates"
           WHERE "domain_id" = '${IDS.modx2Domain}'
             AND "status" = 'ACTIVE';`,
          'count',
        ),
        1,
      );
      assert.equal(
        await scalar(
          legacyDb,
          `SELECT COUNT(*) AS count
           FROM sqlite_schema
           WHERE name = '_meowbox_domain_migration_map';`,
          'count',
        ),
        0,
      );

      assert.equal(
        await scalar(
          legacyDb,
          `SELECT COUNT(*) AS count
           FROM sqlite_schema
           WHERE type = 'index'
             AND name LIKE 'operations_active_%';`,
          'count',
        ),
        0,
      );

      assert.equal(
        await scalar(
          legacyDb,
          `SELECT COUNT(*) AS count
           FROM "hostname_claims"
           WHERE "kind" = 'CANONICAL';`,
          'count',
        ),
        7,
      );
      assert.equal(
        await scalar(
          legacyDb,
          `SELECT COUNT(*) AS count
           FROM "site_domains" AS domain_row
           LEFT JOIN "hostname_claims" AS claim
             ON claim."hostname" = lower(domain_row."domain")
            AND claim."site_domain_id" = domain_row."id"
            AND claim."kind" = 'CANONICAL'
           WHERE claim."hostname" IS NULL;`,
          'count',
        ),
        0,
      );

      await runSqliteScript(
        legacyDb,
        `INSERT INTO "operations" (
           "id", "idempotency_key", "request_hash", "type", "status",
           "site_id", "site_domain_id", "global_lock_key", "created_by_user_id",
           "progress", "created_at", "updated_at"
         ) VALUES (
           'operation-site-lock-1', 'fixture-lock-key-0001', 'fixture-hash-1',
           'DOMAIN_UPDATE', 'RUNNING', '${IDS.multiSite}',
           NULL, 'hostname-registry', '${IDS.user}', 20,
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
         );`,
      );
      await runSqliteScript(
        legacyDb,
        `INSERT INTO "operation_locks" (
           "resource_key", "operation_id", "kind"
         ) VALUES
           ('site:${IDS.multiSite}', 'operation-site-lock-1', 'SITE'),
           ('global:hostname-registry', 'operation-site-lock-1', 'GLOBAL');`,
      );
      await assert.rejects(
        runSqliteScript(
          legacyDb,
          `BEGIN;
           INSERT INTO "operations" (
             "id", "idempotency_key", "request_hash", "type", "status",
             "global_lock_key", "created_by_user_id",
             "progress", "created_at", "updated_at"
           ) VALUES (
             'operation-global-lock-2', 'fixture-global-key-0002', 'fixture-global-hash-2',
             'SITE_CREATE', 'PENDING', 'hostname-registry',
             '${IDS.user}', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
           );
           INSERT INTO "operation_locks" (
             "resource_key", "operation_id", "kind"
           ) VALUES (
             'global:hostname-registry', 'operation-global-lock-2', 'GLOBAL'
           );
           COMMIT;`,
        ),
        /UNIQUE constraint failed: operation_locks\.resource_key/,
      );
      assert.equal(
        await scalar(
          legacyDb,
          `SELECT COUNT(*) AS count
           FROM "operations"
           WHERE "id" = 'operation-global-lock-2';`,
          'count',
        ),
        0,
      );
      await runSqliteScript(
        legacyDb,
        `INSERT INTO "operations" (
           "id", "idempotency_key", "request_hash", "type", "status",
           "site_id", "site_domain_id", "parent_operation_id",
           "created_by_user_id", "progress", "created_at", "updated_at"
         ) VALUES (
           'operation-domain-child-1', 'fixture-child-key-0001', 'fixture-child-hash-1',
           'DOMAIN_PROVISION', 'RUNNING', '${IDS.multiSite}',
           '${IDS.multiPrimary}', 'operation-site-lock-1',
           '${IDS.user}', 30, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
         );`,
      );
      assert.equal(
        await scalar(
          legacyDb,
          `SELECT COUNT(*) AS count
           FROM "operations"
           WHERE "parent_operation_id" = 'operation-site-lock-1';`,
          'count',
        ),
        1,
      );
      await assert.rejects(
        runSqliteScript(
          legacyDb,
          `INSERT INTO "operation_locks" (
             "resource_key", "operation_id", "kind"
           ) VALUES (
             'site:${IDS.multiSite}', 'operation-domain-child-1', 'SITE'
           );`,
        ),
        /UNIQUE constraint failed: operation_locks\.resource_key/,
      );
      await runSqliteScript(
        legacyDb,
        `DELETE FROM "operation_locks"
         WHERE "operation_id" = 'operation-site-lock-1';
         UPDATE "operations"
         SET "status" = 'SUCCEEDED', "completed_at" = CURRENT_TIMESTAMP
         WHERE "id" = 'operation-site-lock-1';
         UPDATE "operations"
         SET "status" = 'SUCCEEDED', "completed_at" = CURRENT_TIMESTAMP
         WHERE "id" = 'operation-domain-child-1';

         INSERT INTO "operations" (
           "id", "idempotency_key", "request_hash", "type", "status",
           "site_id", "site_domain_id", "created_by_user_id",
           "progress", "created_at", "updated_at"
         ) VALUES
           (
             'operation-domain-lock-1', 'fixture-lock-key-0002', 'fixture-hash-2',
             'DOMAIN_UPDATE', 'PENDING', '${IDS.multiSite}',
             '${IDS.multiPrimary}', '${IDS.user}', 0,
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
           ),
           (
             'operation-domain-lock-2', 'fixture-lock-key-0003', 'fixture-hash-3',
             'DOMAIN_UPDATE', 'PENDING', '${IDS.multiSite}',
             '${IDS.multiPhpSecondary}', '${IDS.user}', 0,
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
           );
         INSERT INTO "operation_locks" (
           "resource_key", "operation_id", "kind"
         ) VALUES
           ('domain:${IDS.multiPrimary}', 'operation-domain-lock-1', 'DOMAIN'),
           ('domain:${IDS.multiPhpSecondary}', 'operation-domain-lock-2', 'DOMAIN');`,
      );
      assert.equal(
        await scalar(
          legacyDb,
          `SELECT COUNT(*) AS count
           FROM "operation_locks"
           WHERE "resource_key" LIKE 'domain:%';`,
          'count',
        ),
        2,
      );

      await prismaMigrateDeploy(legacyDb);
      assert.equal(
        await scalar(
          legacyDb,
          'SELECT COUNT(*) AS count FROM "site_domains";',
          'count',
        ),
        7,
      );
      assert.deepEqual(
        await querySqliteJson(legacyDb, 'PRAGMA foreign_key_check;'),
        [],
      );

      await runSqliteScript(
        legacyDb,
        `UPDATE "_prisma_migrations"
         SET "started_at" = CASE "migration_name"
           WHEN '0_init' THEN '2000-01-01T00:00:00.000Z'
           WHEN '1_system_migration_tables' THEN '2000-01-02T00:00:00.000Z'
           WHEN '10_backup_scopes' THEN '2000-01-03T00:00:00.000Z'
           ELSE "started_at"
         END;`,
      );
      const trackedAssessment = await assessBaseline({
        dbPath: legacyDb,
        apiDir,
        contract,
      });
      assert.equal(
        trackedAssessment.ok,
        true,
        JSON.stringify(trackedAssessment.blockers),
      );
      assert.equal(trackedAssessment.decision, 'already-tracked');
      assert.equal(trackedAssessment.legacyMappingRequired, false);

      await copyFile(legacyDb, historyGapDb);
      await runSqliteScript(
        historyGapDb,
        `DELETE FROM "_prisma_migrations"
         WHERE "migration_name" = '8_country_blocks';`,
      );
      const historyGapAssessment = await assessBaseline({
        dbPath: historyGapDb,
        apiDir,
        contract,
      });
      assert.equal(historyGapAssessment.ok, false);
      assert.ok(
        historyGapAssessment.blockers.some(
          (blocker) =>
            blocker.code === 'PRISMA_HISTORY_LEGACY_BASELINE_MISSING',
        ),
      );
    } finally {
      assertTemporaryPath(tempRoot);
      await rm(tempRoot, { recursive: true, force: true });
    }
  },
);

test(
  'mapper fails closed when runtime evidence is missing and leaves clone untouched',
  { timeout: 60_000 },
  async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), 'meowbox-domain-release-test-'),
    );
    const dbPath = join(tempRoot, 'legacy.db');
    try {
      await createLegacyFixture(dbPath);
      const before = await fingerprintDatabaseFiles(dbPath);
      const result = await applyLegacyMigrationMap({
        dbPath,
        runtimeEvidence: { domains: {} },
        writeMode: 'clone',
      });
      assert.equal(result.changed, false);
      assert.equal(result.report.ok, false);
      const codes = new Set(result.report.blockers.map((blocker) => blocker.code));
      assert.ok(codes.has('SECONDARY_PHP_EVIDENCE_REQUIRED'));
      assert.ok(codes.has('PHP_POOL_BUDGET_EVIDENCE_REQUIRED'));
      assert.deepEqual(await fingerprintDatabaseFiles(dbPath), before);

      const tooSmallBudget = await applyLegacyMigrationMap({
        dbPath,
        runtimeEvidence: {
          domains: {
            ...runtimeEvidence.domains,
            [IDS.multiPrimary]: {
              ...runtimeEvidence.domains[IDS.multiPrimary],
              poolMaxChildren: 1,
            },
          },
        },
        writeMode: 'clone',
      });
      assert.equal(tooSmallBudget.changed, false);
      assert.equal(tooSmallBudget.report.ok, false);
      assert.ok(
        tooSmallBudget.report.blockers.some(
          (blocker) => blocker.code === 'PHP_POOL_BUDGET_TOO_SMALL',
        ),
      );
      assert.deepEqual(await fingerprintDatabaseFiles(dbPath), before);

      assert.equal(
        await scalar(
          dbPath,
          `SELECT COUNT(*) AS count
           FROM sqlite_schema
           WHERE name = '_meowbox_domain_migration_map';`,
          'count',
        ),
        0,
      );
    } finally {
      assertTemporaryPath(tempRoot);
      await rm(tempRoot, { recursive: true, force: true });
    }
  },
);

test(
  'fresh install applies Prisma migrations and baselines exact system artifacts',
  { timeout: 120_000 },
  async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), 'meowbox-domain-release-test-'),
    );
    const dbPath = join(tempRoot, 'fresh.db');
    try {
      await prismaMigrateDeploy(dbPath);
      const finalColumns = await columns(dbPath, 'site_domains');
      for (const required of [
        'preset',
        'app_status',
        'files_rel_path',
        'runtime_key',
        'php_version',
      ]) {
        assert.ok(finalColumns.includes(required), required);
      }
      const backupColumns = await columns(dbPath, 'backups');
      assert.ok(backupColumns.includes('manifest'));
      assert.ok(backupColumns.includes('restore_context'));
      assert.equal(
        await scalar(dbPath, 'SELECT COUNT(*) AS count FROM "sites";', 'count'),
        0,
      );
      assert.deepEqual(
        await querySqliteJson(dbPath, 'PRAGMA foreign_key_check;'),
        [],
      );

      const firstBaseline = await runSystemMigrationRunner(dbPath, [
        'baseline-fresh-install',
        '--fresh-install',
      ]);
      const systemFiles = (await readdir(join(migrationsDir, 'dist', 'system')))
        .filter((file) => file.endsWith('.js') && !file.startsWith('_'))
        .sort();
      const expected = new Map();
      for (const file of systemFiles) {
        const content = await readFile(join(migrationsDir, 'dist', 'system', file));
        expected.set(
          file.replace(/\.js$/, ''),
          createHash('sha256').update(content).digest('hex'),
        );
      }
      const applied = await querySqliteJson(
        dbPath,
        `SELECT "id", "checksum", "duration_ms", "ok", "error_log"
         FROM "system_migrations"
         ORDER BY "id";`,
      );
      assert.equal(applied.length, expected.size);
      for (const row of applied) {
        assert.equal(row.checksum, expected.get(row.id), row.id);
        assert.equal(row.duration_ms, 0, row.id);
        assert.equal(row.ok, 1, row.id);
        assert.equal(row.error_log, null, row.id);
      }
      assert.match(firstBaseline.stdout, new RegExp(`${expected.size} added`));

      const repeatedBaseline = await runSystemMigrationRunner(dbPath, [
        'baseline-fresh-install',
        '--fresh-install',
      ]);
      assert.match(repeatedBaseline.stdout, /0 added/);

      const dryRun = await runSystemMigrationRunner(dbPath, ['up', '--dry-run']);
      assert.match(dryRun.stdout, /Pending: 0/);

      await runSqliteScript(
        dbPath,
        `INSERT INTO "users" (
           "id", "username", "email", "password_hash", "role",
           "totp_enabled", "created_at", "updated_at"
         ) VALUES (
           'fresh-install-rejection-user', 'operator', 'operator@example.test',
           'not-a-real-password-hash', 'ADMIN', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
         );`,
      );
      await assert.rejects(
        runSystemMigrationRunner(dbPath, [
          'baseline-fresh-install',
          '--fresh-install',
        ]),
        (error) =>
          /refuses non-empty application table users/.test(
            `${error.stderr ?? ''}\n${error.message ?? ''}`,
          ),
      );
      assert.equal(
        await scalar(
          dbPath,
          'SELECT COUNT(*) AS count FROM "system_migrations";',
          'count',
        ),
        expected.size,
      );
    } finally {
      assertTemporaryPath(tempRoot);
      await rm(tempRoot, { recursive: true, force: true });
    }
  },
);

test('test harness is anchored to the migrations package', () => {
  assert.equal(basename(migrationsDir), 'migrations');
});
