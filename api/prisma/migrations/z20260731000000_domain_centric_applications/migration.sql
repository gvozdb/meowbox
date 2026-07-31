-- Domain-centric applications: SiteDomain becomes the one and only
-- application boundary.
--
-- The `z` prefix is intentional. Historical applied migration directories use
-- non-timestamp names such as `2_*` through `9_*`, and Prisma sorts directory
-- names lexically. A normal `20260731000000_*` name would run before those
-- migrations on a fresh install and they would reintroduce legacy Site fields.
-- Do not rename the already-applied historical migrations; this new migration
-- must remain lexically last until that history is replaced by a baseline.
--
-- IMPORTANT BLOCKER / staging-map contract
-- ----------------------------------------
-- SQLite SQL cannot read managed MODX configuration, resolve filesystem paths,
-- calculate the release snapshot checksum, or derive a secondary runtime key
-- safely. Therefore a non-empty legacy database MUST be pre-populated by the
-- release mapper with `_meowbox_domain_migration_map` before this migration
-- starts. The mapper must verify source_db_checksum against the quiesced SQLite
-- snapshot outside SQL. This migration intentionally aborts before any table
-- copy when the map is missing, stale, incomplete, ambiguous, or inconsistent.
--
-- Map rows are version 1 and use one row per source Site, SiteDomain, and
-- Database:
--   SITE:     source_id/site_id are Site.id; site_domain_id and
--             primary_site_domain_id are the selected primary SiteDomain.id.
--   DOMAIN:   source_id/site_domain_id are SiteDomain.id; application payload
--             holds the resolved explicit path, runtime facts and status.
--   DATABASE: source_id/database_id are Database.id; site_domain_id and
--             purpose carry the validated owner / APP_PRIMARY choice.
-- All rows share the source checksum and supported-schema fingerprint. The
-- mapper never writes secrets to this table: encrypted Site/Database values are
-- copied directly below without decrypting or transforming their bytes.

CREATE TABLE IF NOT EXISTS "_meowbox_domain_migration_map" (
    "contract_version" INTEGER NOT NULL,
    "row_kind" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "site_domain_id" TEXT,
    "database_id" TEXT,
    "primary_site_domain_id" TEXT NOT NULL,
    "source_db_checksum" TEXT NOT NULL,
    "source_fingerprint" TEXT NOT NULL,
    "preset" TEXT,
    "app_status" TEXT,
    "app_error_message" TEXT,
    "files_rel_path" TEXT,
    "php_version" TEXT,
    "php_pool_custom" TEXT,
    "runtime_key" TEXT,
    "app_port" INTEGER,
    "purpose" TEXT,
    PRIMARY KEY ("row_kind", "source_id")
);

-- This guard deliberately leaves the helper map in place after an aborted
-- migration, so an operator never has to recreate it manually. Prisma records
-- a failed migration attempt, however: after correcting the map the release
-- procedure must run `prisma migrate resolve --rolled-back
-- z20260731000000_domain_centric_applications` before retrying. Production
-- preflight is expected to catch this named constraint before migrate deploy.
CREATE TABLE IF NOT EXISTS "_meowbox_domain_migration_guard" (
    "ok" INTEGER NOT NULL CONSTRAINT "meowbox_domain_map_validation_failed" CHECK ("ok" = 1)
);
DELETE FROM "_meowbox_domain_migration_guard";
INSERT INTO "_meowbox_domain_migration_guard" ("ok")
SELECT CASE WHEN
  -- A pristine Prisma install has no legacy ownership rows and must not carry
  -- stale map rows. User/audit rows are irrelevant when there are no Sites.
  (
    (SELECT COUNT(*) FROM "sites") = 0
    AND (SELECT COUNT(*) FROM "site_domains") = 0
    AND (SELECT COUNT(*) FROM "databases") = 0
    AND (SELECT COUNT(*) FROM "deploy_logs") = 0
    AND (SELECT COUNT(*) FROM "_meowbox_domain_migration_map") = 0
  )
  OR
  (
    -- Exact, versioned map coverage for every legacy ownership source.
    (SELECT COUNT(*) FROM "sites") > 0
    AND (SELECT COUNT(*) FROM "_meowbox_domain_migration_map") =
      (SELECT COUNT(*) FROM "sites") +
      (SELECT COUNT(*) FROM "site_domains") +
      (SELECT COUNT(*) FROM "databases")
    AND NOT EXISTS (
      SELECT 1
      FROM "_meowbox_domain_migration_map" AS m
      WHERE m."contract_version" <> 1
         OR m."row_kind" NOT IN ('SITE', 'DOMAIN', 'DATABASE')
         OR length(trim(m."source_id")) = 0
         OR length(trim(m."site_id")) = 0
         OR length(trim(m."primary_site_domain_id")) = 0
         OR length(trim(m."source_db_checksum")) = 0
         OR length(trim(m."source_fingerprint")) = 0
    )
    AND (SELECT COUNT(DISTINCT "source_db_checksum") FROM "_meowbox_domain_migration_map") = 1
    AND (SELECT COUNT(DISTINCT "source_fingerprint") FROM "_meowbox_domain_migration_map") = 1

    -- Source rows must be internally valid before final non-null/FK rebuilds.
    AND NOT EXISTS (
      SELECT 1
      FROM "sites" AS s
      LEFT JOIN "users" AS u ON u."id" = s."user_id"
      WHERE s."user_id" IS NULL OR u."id" IS NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "site_domains" AS d
      LEFT JOIN "sites" AS s ON s."id" = d."site_id"
      WHERE s."id" IS NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "sites" AS s
      WHERE (
        SELECT COUNT(*)
        FROM "site_domains" AS d
        WHERE d."site_id" = s."id" AND d."is_primary" = 1
      ) <> 1
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "site_domains" AS d
      WHERE d."is_primary" = 1 AND d."position" <> 0
    )

    -- SITE rows select exactly the real primary domain for their Site.
    AND NOT EXISTS (
      SELECT 1
      FROM "sites" AS s
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
    )

    -- DOMAIN rows contain every application fact needed by the table copy.
    AND NOT EXISTS (
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
         OR m."primary_site_domain_id" <> (
           SELECT p."id"
           FROM "site_domains" AS p
           WHERE p."site_id" = d."site_id" AND p."is_primary" = 1
         )
         OR m."preset" IS NULL
         OR m."preset" NOT IN ('MODX_REVO', 'MODX_3', 'CUSTOM')
         OR m."app_status" IS NULL
         OR m."app_status" NOT IN ('RUNNING', 'ERROR')
         OR m."files_rel_path" IS NULL
         OR m."files_rel_path" = ''
         OR length(m."files_rel_path") > 255
         OR trim(m."files_rel_path") <> m."files_rel_path"
         OR substr(m."files_rel_path", 1, 1) = '/'
         OR substr(m."files_rel_path", -1) = '/'
         OR instr(m."files_rel_path", char(0)) <> 0
         OR instr(m."files_rel_path", '\') <> 0
         OR m."files_rel_path" GLOB '*[^A-Za-z0-9._/-]*'
         OR m."files_rel_path" IN ('.', '..')
         OR instr(m."files_rel_path", '//') <> 0
         OR instr('/' || m."files_rel_path" || '/', '/./') <> 0
         OR instr('/' || m."files_rel_path" || '/', '/../') <> 0
         OR m."runtime_key" IS NULL
         OR length(m."runtime_key") < 1
         OR length(m."runtime_key") > 64
         OR m."runtime_key" GLOB '*[^a-z0-9._-]*'
         OR (m."app_port" IS NOT NULL AND (m."app_port" < 1 OR m."app_port" > 65535))
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
             OR length(m."runtime_key") <> 21
             OR substr(m."runtime_key", 1, 1) <> 'd'
             OR substr(m."runtime_key", 2) GLOB '*[^0-9a-f]*'
           )
         )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "_meowbox_domain_migration_map"
      WHERE "row_kind" = 'DOMAIN'
      GROUP BY "runtime_key"
      HAVING COUNT(*) <> 1
    )

    -- DATABASE rows are exhaustive, same-Site, and carry an explicit purpose.
    AND NOT EXISTS (
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
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "_meowbox_domain_migration_map"
      WHERE "row_kind" = 'DATABASE' AND "purpose" = 'APP_PRIMARY'
      GROUP BY "site_domain_id"
      HAVING COUNT(*) > 1
    )
    AND NOT EXISTS (
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
    )

    -- Legacy deploy history always follows the selected primary domain.
    AND NOT EXISTS (
      SELECT 1
      FROM "deploy_logs" AS l
      LEFT JOIN "_meowbox_domain_migration_map" AS m
        ON m."row_kind" = 'SITE' AND m."source_id" = l."site_id"
      WHERE m."source_id" IS NULL
    )
    -- Preserve the primary domain's JSON bytes exactly; a drifted NULL must
    -- block rather than be silently rewritten to an empty object.
    AND NOT EXISTS (SELECT 1 FROM "sites" WHERE "env_vars" IS NULL)
    -- Do not start a table-copy on an already-corrupt source snapshot. This
    -- complements the transactional post-copy check and gives the mapper an
    -- actionable pre-copy blocker for unrelated legacy FK damage.
    AND (SELECT "integrity_check" FROM pragma_integrity_check LIMIT 1) = 'ok'
    AND NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)
  )
THEN 1 ELSE 0 END;
DROP TABLE "_meowbox_domain_migration_guard";

-- SQLite requires a table copy for moved/dropped fields and final FK/NOT NULL
-- constraints. Every INSERT has an explicit column list to preserve UUIDs,
-- timestamps and encrypted blobs byte-for-byte. Keep the destructive work and
-- its final invariant check in one explicit transaction: Prisma's SQLite
-- migration runner does not otherwise roll back a failed table-copy script.
-- `foreign_keys` must be disabled before BEGIN because SQLite cannot change
-- that setting inside a transaction; `foreign_key_check` below remains usable.
PRAGMA foreign_keys=OFF;
BEGIN IMMEDIATE;
PRAGMA defer_foreign_keys=ON;

CREATE TABLE "new_site_domains" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "site_id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "aliases" TEXT NOT NULL DEFAULT '[]',
    "files_rel_path" TEXT NOT NULL,
    "preset" TEXT NOT NULL,
    "app_status" TEXT NOT NULL DEFAULT 'PROVISIONING',
    "app_error_message" TEXT,
    "php_version" TEXT,
    "php_pool_custom" TEXT,
    "runtime_key" TEXT NOT NULL,
    "git_repository" TEXT,
    "deploy_branch" TEXT,
    "env_vars" TEXT NOT NULL DEFAULT '{}',
    "cms_admin_user" TEXT,
    "cms_admin_password_enc" TEXT,
    "manager_path" TEXT,
    "connectors_path" TEXT,
    "cms_table_prefix" TEXT,
    "modx_version" TEXT,
    "app_port" INTEGER,
    "https_redirect" BOOLEAN NOT NULL DEFAULT true,
    "nginx_client_max_body_size" TEXT,
    "nginx_fastcgi_read_timeout" INTEGER,
    "nginx_fastcgi_send_timeout" INTEGER,
    "nginx_fastcgi_connect_timeout" INTEGER,
    "nginx_fastcgi_buffer_size_kb" INTEGER,
    "nginx_fastcgi_buffer_count" INTEGER,
    "nginx_http2" BOOLEAN NOT NULL DEFAULT true,
    "nginx_hsts" BOOLEAN NOT NULL DEFAULT false,
    "nginx_gzip" BOOLEAN NOT NULL DEFAULT true,
    "nginx_rate_limit_enabled" BOOLEAN NOT NULL DEFAULT true,
    "nginx_rate_limit_rps" INTEGER,
    "nginx_rate_limit_burst" INTEGER,
    "nginx_custom_config" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "site_domains_site_id_fkey"
      FOREIGN KEY ("site_id") REFERENCES "sites" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_site_domains" (
    "id", "site_id", "domain", "is_primary", "position", "aliases",
    "files_rel_path", "preset", "app_status", "app_error_message",
    "php_version", "php_pool_custom", "runtime_key", "git_repository",
    "deploy_branch", "env_vars", "cms_admin_user", "cms_admin_password_enc",
    "manager_path", "connectors_path", "cms_table_prefix", "modx_version",
    "app_port", "https_redirect", "nginx_client_max_body_size",
    "nginx_fastcgi_read_timeout", "nginx_fastcgi_send_timeout",
    "nginx_fastcgi_connect_timeout", "nginx_fastcgi_buffer_size_kb",
    "nginx_fastcgi_buffer_count", "nginx_http2", "nginx_hsts", "nginx_gzip",
    "nginx_rate_limit_enabled", "nginx_rate_limit_rps", "nginx_rate_limit_burst",
    "nginx_custom_config", "created_at", "updated_at"
)
SELECT
    d."id", d."site_id", d."domain", d."is_primary", d."position", d."aliases",
    m."files_rel_path", m."preset", m."app_status", m."app_error_message",
    m."php_version", m."php_pool_custom", m."runtime_key",
    CASE WHEN d."is_primary" = 1 THEN s."git_repository" END,
    CASE WHEN d."is_primary" = 1 THEN s."deploy_branch" END,
    CASE WHEN d."is_primary" = 1 THEN s."env_vars" ELSE '{}' END,
    CASE WHEN d."is_primary" = 1 THEN s."cms_admin_user" END,
    CASE WHEN d."is_primary" = 1 THEN s."cms_admin_password_enc" END,
    CASE WHEN d."is_primary" = 1 THEN s."manager_path" END,
    CASE WHEN d."is_primary" = 1 THEN s."connectors_path" END,
    CASE WHEN d."is_primary" = 1 THEN s."cms_table_prefix" END,
    CASE WHEN d."is_primary" = 1 THEN s."modx_version" END,
    m."app_port", d."https_redirect", d."nginx_client_max_body_size",
    d."nginx_fastcgi_read_timeout", d."nginx_fastcgi_send_timeout",
    d."nginx_fastcgi_connect_timeout", d."nginx_fastcgi_buffer_size_kb",
    d."nginx_fastcgi_buffer_count", d."nginx_http2", d."nginx_hsts", d."nginx_gzip",
    d."nginx_rate_limit_enabled", d."nginx_rate_limit_rps", d."nginx_rate_limit_burst",
    d."nginx_custom_config", d."created_at", d."updated_at"
FROM "site_domains" AS d
JOIN "sites" AS s ON s."id" = d."site_id"
JOIN "_meowbox_domain_migration_map" AS m
  ON m."row_kind" = 'DOMAIN' AND m."source_id" = d."id";

DROP TABLE "site_domains";
ALTER TABLE "new_site_domains" RENAME TO "site_domains";

CREATE TABLE "new_databases" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "db_user" TEXT NOT NULL,
    "db_password_hash" TEXT NOT NULL,
    "db_password_enc" TEXT,
    "site_id" TEXT NOT NULL,
    "site_domain_id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "databases_site_id_fkey"
      FOREIGN KEY ("site_id") REFERENCES "sites" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "databases_site_domain_id_fkey"
      FOREIGN KEY ("site_domain_id") REFERENCES "site_domains" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "new_databases" (
    "id", "name", "type", "db_user", "db_password_hash", "db_password_enc",
    "site_id", "site_domain_id", "purpose", "size_bytes", "created_at", "updated_at"
)
SELECT
    db."id", db."name", db."type", db."db_user", db."db_password_hash", db."db_password_enc",
    db."site_id", m."site_domain_id", m."purpose", db."size_bytes", db."created_at", db."updated_at"
FROM "databases" AS db
JOIN "_meowbox_domain_migration_map" AS m
  ON m."row_kind" = 'DATABASE' AND m."source_id" = db."id";

DROP TABLE "databases";
ALTER TABLE "new_databases" RENAME TO "databases";

CREATE TABLE "new_deploy_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "site_id" TEXT NOT NULL,
    "site_domain_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "commit_sha" TEXT,
    "commit_message" TEXT,
    "branch" TEXT NOT NULL,
    "output" TEXT NOT NULL DEFAULT '',
    "triggered_by" TEXT,
    "duration_ms" INTEGER,
    "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "deploy_logs_site_id_fkey"
      FOREIGN KEY ("site_id") REFERENCES "sites" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "deploy_logs_site_domain_id_fkey"
      FOREIGN KEY ("site_domain_id") REFERENCES "site_domains" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_deploy_logs" (
    "id", "site_id", "site_domain_id", "status", "commit_sha", "commit_message",
    "branch", "output", "triggered_by", "duration_ms", "started_at", "completed_at", "created_at"
)
SELECT
    l."id", l."site_id", m."primary_site_domain_id", l."status", l."commit_sha", l."commit_message",
    l."branch", l."output", l."triggered_by", l."duration_ms", l."started_at", l."completed_at", l."created_at"
FROM "deploy_logs" AS l
JOIN "_meowbox_domain_migration_map" AS m
  ON m."row_kind" = 'SITE' AND m."source_id" = l."site_id";

DROP TABLE "deploy_logs";
ALTER TABLE "new_deploy_logs" RENAME TO "deploy_logs";

-- Legacy pings/audit entries have no reliable application target. Leave them
-- nullable rather than guessing a primary domain.
CREATE TABLE "new_health_check_pings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "site_id" TEXT NOT NULL,
    "site_domain_id" TEXT,
    "reachable" BOOLEAN NOT NULL,
    "status_code" INTEGER,
    "response_time_ms" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "health_check_pings_site_id_fkey"
      FOREIGN KEY ("site_id") REFERENCES "sites" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "health_check_pings_site_domain_id_fkey"
      FOREIGN KEY ("site_domain_id") REFERENCES "site_domains" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_health_check_pings" (
    "id", "site_id", "site_domain_id", "reachable", "status_code", "response_time_ms", "created_at"
)
SELECT
    "id", "site_id", NULL, "reachable", "status_code", "response_time_ms", "created_at"
FROM "health_check_pings";

DROP TABLE "health_check_pings";
ALTER TABLE "new_health_check_pings" RENAME TO "health_check_pings";

CREATE TABLE "new_audit_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "site_domain_id" TEXT,
    "operation_id" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT,
    "details" TEXT,
    "ip_address" TEXT NOT NULL,
    "user_agent" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_logs_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "audit_logs_site_domain_id_fkey"
      FOREIGN KEY ("site_domain_id") REFERENCES "site_domains" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_audit_logs" (
    "id", "user_id", "site_domain_id", "operation_id", "action", "entity", "entity_id",
    "details", "ip_address", "user_agent", "created_at"
)
SELECT
    "id", "user_id", NULL, NULL, "action", "entity", "entity_id",
    "details", "ip_address", "user_agent", "created_at"
FROM "audit_logs";

DROP TABLE "audit_logs";
ALTER TABLE "new_audit_logs" RENAME TO "audit_logs";

-- Remove all legacy application columns only after their primary-domain values
-- were copied above. Site-level routing/backup defaults intentionally remain;
-- they are outside the explicit application-field removal contract.
CREATE TABLE "new_sites" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "display_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'STOPPED',
    "error_message" TEXT,
    "root_path" TEXT NOT NULL,
    "nginx_config_path" TEXT NOT NULL,
    "site_user" TEXT,
    "ssh_password_enc" TEXT,
    "backup_excludes" TEXT,
    "backup_exclude_tables" TEXT,
    "metadata" TEXT,
    "user_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "sites_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_sites" (
    "id", "name", "display_name", "status", "error_message", "root_path", "nginx_config_path",
    "site_user", "ssh_password_enc", "backup_excludes", "backup_exclude_tables", "metadata", "user_id",
    "created_at", "updated_at"
)
SELECT
    "id", "name", "display_name", "status", "error_message", "root_path", "nginx_config_path",
    "site_user", "ssh_password_enc", "backup_excludes", "backup_exclude_tables", "metadata", "user_id",
    "created_at", "updated_at"
FROM "sites";

DROP TABLE "sites";
ALTER TABLE "new_sites" RENAME TO "sites";

CREATE TABLE "operations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "site_id" TEXT,
    "site_domain_id" TEXT,
    "database_id" TEXT,
    "global_lock_key" TEXT,
    "parent_operation_id" TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "current_step" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "result" TEXT,
    "error_message" TEXT,
    "started_at" DATETIME,
    "completed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "operations_site_id_fkey"
      FOREIGN KEY ("site_id") REFERENCES "sites" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "operations_site_domain_id_fkey"
      FOREIGN KEY ("site_domain_id") REFERENCES "site_domains" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "operations_database_id_fkey"
      FOREIGN KEY ("database_id") REFERENCES "databases" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "operations_parent_operation_id_fkey"
      FOREIGN KEY ("parent_operation_id") REFERENCES "operations" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "operations_created_by_user_id_fkey"
      FOREIGN KEY ("created_by_user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "hostname_claims" (
    "hostname" TEXT NOT NULL PRIMARY KEY,
    "site_domain_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "hostname_claims_site_domain_id_fkey"
      FOREIGN KEY ("site_domain_id") REFERENCES "site_domains" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "operation_locks" (
    "resource_key" TEXT NOT NULL PRIMARY KEY,
    "operation_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "operation_locks_operation_id_fkey"
      FOREIGN KEY ("operation_id") REFERENCES "operations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "hostname_claims" ("hostname", "site_domain_id", "kind")
SELECT lower("domain"), "id", 'CANONICAL'
FROM "site_domains";

INSERT INTO "hostname_claims" ("hostname", "site_domain_id", "kind")
SELECT
  lower(
    CASE alias_row."type"
      WHEN 'text' THEN alias_row."value"
      ELSE json_extract(alias_row."value", '$.domain')
    END
  ),
  domain_row."id",
  'ALIAS'
FROM "site_domains" AS domain_row
JOIN json_each(domain_row."aliases") AS alias_row
WHERE trim(
  CASE alias_row."type"
    WHEN 'text' THEN alias_row."value"
    ELSE coalesce(json_extract(alias_row."value", '$.domain'), '')
  END
) <> '';

CREATE UNIQUE INDEX "sites_name_key" ON "sites"("name");
CREATE INDEX "sites_user_id_idx" ON "sites"("user_id");
CREATE INDEX "sites_status_idx" ON "sites"("status");

CREATE UNIQUE INDEX "site_domains_domain_key" ON "site_domains"("domain");
CREATE UNIQUE INDEX "site_domains_runtime_key_key" ON "site_domains"("runtime_key");
CREATE UNIQUE INDEX "site_domains_site_id_position_key"
  ON "site_domains"("site_id", "position");
CREATE INDEX "site_domains_site_id_app_status_idx" ON "site_domains"("site_id", "app_status");
CREATE INDEX "site_domains_preset_idx" ON "site_domains"("preset");
CREATE UNIQUE INDEX "site_domains_one_primary_per_site"
  ON "site_domains"("site_id") WHERE "is_primary" = 1;

CREATE UNIQUE INDEX "databases_name_type_key" ON "databases"("name", "type");
CREATE INDEX "databases_site_id_idx" ON "databases"("site_id");
CREATE INDEX "databases_site_domain_id_purpose_idx" ON "databases"("site_domain_id", "purpose");
CREATE UNIQUE INDEX "databases_one_app_primary_per_domain"
  ON "databases"("site_domain_id") WHERE "purpose" = 'APP_PRIMARY';

CREATE INDEX "deploy_logs_site_id_idx" ON "deploy_logs"("site_id");
CREATE INDEX "deploy_logs_site_domain_id_created_at_idx"
  ON "deploy_logs"("site_domain_id", "created_at");
CREATE INDEX "deploy_logs_status_idx" ON "deploy_logs"("status");

CREATE INDEX "health_check_pings_site_id_created_at_idx"
  ON "health_check_pings"("site_id", "created_at");
CREATE INDEX "health_check_pings_site_domain_id_created_at_idx"
  ON "health_check_pings"("site_domain_id", "created_at");

CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs"("user_id");
CREATE INDEX "audit_logs_site_domain_id_created_at_idx"
  ON "audit_logs"("site_domain_id", "created_at");
CREATE INDEX "audit_logs_operation_id_idx" ON "audit_logs"("operation_id");
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

CREATE UNIQUE INDEX "operations_idempotency_key_key"
  ON "operations"("idempotency_key");
CREATE INDEX "operations_site_id_status_idx"
  ON "operations"("site_id", "status");
CREATE INDEX "operations_site_domain_id_status_idx"
  ON "operations"("site_domain_id", "status");
CREATE INDEX "operations_database_id_status_idx"
  ON "operations"("database_id", "status");
CREATE INDEX "operations_global_lock_key_status_idx"
  ON "operations"("global_lock_key", "status");
CREATE INDEX "operations_parent_operation_id_created_at_idx"
  ON "operations"("parent_operation_id", "created_at");
CREATE INDEX "operations_created_at_idx" ON "operations"("created_at");

CREATE INDEX "hostname_claims_site_domain_id_idx"
  ON "hostname_claims"("site_domain_id");
CREATE INDEX "operation_locks_operation_id_idx"
  ON "operation_locks"("operation_id");

-- Final post-copy invariant check. This is intentionally separate from map
-- validation so row-count, FK and SQLite integrity failures roll back the
-- complete table copy instead of leaving a partially converted database.
CREATE TABLE IF NOT EXISTS "_meowbox_domain_migration_final_guard" (
    "ok" INTEGER NOT NULL CONSTRAINT "meowbox_domain_final_validation_failed" CHECK ("ok" = 1)
);
DELETE FROM "_meowbox_domain_migration_final_guard";
INSERT INTO "_meowbox_domain_migration_final_guard" ("ok")
SELECT CASE WHEN
  (SELECT COUNT(*) FROM "sites") = (SELECT COUNT(*) FROM "_meowbox_domain_migration_map" WHERE "row_kind" = 'SITE')
  AND (SELECT COUNT(*) FROM "site_domains") = (SELECT COUNT(*) FROM "_meowbox_domain_migration_map" WHERE "row_kind" = 'DOMAIN')
  AND (SELECT COUNT(*) FROM "databases") = (SELECT COUNT(*) FROM "_meowbox_domain_migration_map" WHERE "row_kind" = 'DATABASE')
  AND NOT EXISTS (
    SELECT 1
    FROM "sites" AS s
    WHERE (
      SELECT COUNT(*) FROM "site_domains" AS d
      WHERE d."site_id" = s."id" AND d."is_primary" = 1
    ) <> 1
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "site_domains"
    WHERE "files_rel_path" = ''
       OR length("files_rel_path") > 255
       OR "files_rel_path" GLOB '*[^A-Za-z0-9._/-]*'
       OR "preset" NOT IN ('MODX_REVO', 'MODX_3', 'CUSTOM')
       OR "app_status" NOT IN ('RUNNING', 'ERROR')
       OR length("runtime_key") < 1
       OR length("runtime_key") > 64
       OR "runtime_key" GLOB '*[^a-z0-9._-]*'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "databases" AS db
    LEFT JOIN "site_domains" AS d ON d."id" = db."site_domain_id"
    WHERE d."id" IS NULL OR db."site_id" <> d."site_id"
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "site_domains" AS d
    LEFT JOIN "hostname_claims" AS claim
      ON claim."hostname" = lower(d."domain")
     AND claim."site_domain_id" = d."id"
     AND claim."kind" = 'CANONICAL'
    WHERE claim."hostname" IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "site_domains" AS d
    JOIN json_each(d."aliases") AS alias_row
    LEFT JOIN "hostname_claims" AS claim
      ON claim."hostname" = lower(
        CASE alias_row."type"
          WHEN 'text' THEN alias_row."value"
          ELSE json_extract(alias_row."value", '$.domain')
        END
      )
     AND claim."site_domain_id" = d."id"
     AND claim."kind" = 'ALIAS'
    WHERE claim."hostname" IS NULL
  )
  AND (
    SELECT COUNT(*) FROM "hostname_claims"
  ) = (
    SELECT COUNT(*) + coalesce(SUM(json_array_length("aliases")), 0)
    FROM "site_domains"
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "site_domains" AS d
    WHERE d."preset" IN ('MODX_REVO', 'MODX_3')
      AND (
        SELECT COUNT(*)
        FROM "databases" AS db
        WHERE db."site_domain_id" = d."id"
          AND db."purpose" = 'APP_PRIMARY'
          AND db."type" IN ('MARIADB', 'MYSQL')
      ) <> 1
  )
  AND (SELECT "integrity_check" FROM pragma_integrity_check LIMIT 1) = 'ok'
  AND NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)
THEN 1 ELSE 0 END;
DROP TABLE "_meowbox_domain_migration_final_guard";
DROP TABLE "_meowbox_domain_migration_map";
COMMIT;
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
