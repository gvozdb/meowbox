-- Generated with `prisma migrate dev --name backup_schema_alignment` against
-- an isolated database. The `zz` prefix keeps this migration after the legacy
-- non-timestamp migration names and the domain/application migrations.
--
-- Historical hand-written backup migrations used SQLite INTEGER declarations
-- for Boolean fields, omitted ON UPDATE CASCADE on four foreign keys, allowed
-- nullable TEXT primary keys through SQLite's legacy syntax, and left
-- `updated_at` with a database default although Prisma owns that field.

CREATE TABLE IF NOT EXISTS "_meowbox_backup_alignment_guard" (
    "ok" INTEGER NOT NULL
      CONSTRAINT "meowbox_backup_schema_alignment_validation_failed"
      CHECK ("ok" = 1)
);
DELETE FROM "_meowbox_backup_alignment_guard";
INSERT INTO "_meowbox_backup_alignment_guard" ("ok")
SELECT CASE WHEN
  NOT EXISTS (
    SELECT 1 FROM "notification_digest_queue" WHERE "id" IS NULL
    UNION ALL
    SELECT 1 FROM "panel_data_backup_configs"
      WHERE "id" IS NULL OR "enabled" NOT IN (0, 1)
    UNION ALL
    SELECT 1 FROM "panel_data_backups" WHERE "id" IS NULL
    UNION ALL
    SELECT 1 FROM "server_path_backup_configs"
      WHERE "id" IS NULL
         OR "enabled" NOT IN (0, 1)
         OR "warning_acknowledged" NOT IN (0, 1)
    UNION ALL
    SELECT 1 FROM "server_path_backups" WHERE "id" IS NULL
    UNION ALL
    SELECT 1 FROM "site_backup_schedules"
      WHERE "id" IS NULL
         OR "enabled" NOT IN (0, 1)
         OR "check_enabled" NOT IN (0, 1)
         OR "check_read_data" NOT IN (0, 1)
  )
  THEN 1 ELSE 0 END;
DROP TABLE "_meowbox_backup_alignment_guard";

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_notification_digest_queue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "config_type" TEXT NOT NULL,
    "config_id" TEXT NOT NULL,
    "config_name" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "resource_label" TEXT NOT NULL,
    "size_bytes" BIGINT,
    "message" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" DATETIME
);
INSERT INTO "new_notification_digest_queue" (
    "config_id",
    "config_name",
    "config_type",
    "created_at",
    "event",
    "id",
    "message",
    "resource_label",
    "sent_at",
    "size_bytes"
)
SELECT
    "config_id",
    "config_name",
    "config_type",
    "created_at",
    "event",
    "id",
    "message",
    "resource_label",
    "sent_at",
    "size_bytes"
FROM "notification_digest_queue";
DROP TABLE "notification_digest_queue";
ALTER TABLE "new_notification_digest_queue"
  RENAME TO "notification_digest_queue";
CREATE INDEX "notification_digest_queue_config_type_config_id_sent_at_idx"
  ON "notification_digest_queue"("config_type", "config_id", "sent_at");
CREATE INDEX "notification_digest_queue_sent_at_idx"
  ON "notification_digest_queue"("sent_at");

CREATE TABLE "new_panel_data_backup_configs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "engine" TEXT NOT NULL DEFAULT 'RESTIC',
    "storage_location_ids" TEXT NOT NULL DEFAULT '[]',
    "schedule" TEXT,
    "retention" INTEGER NOT NULL DEFAULT 7,
    "keep_daily" INTEGER NOT NULL DEFAULT 24,
    "keep_weekly" INTEGER NOT NULL DEFAULT 7,
    "keep_monthly" INTEGER NOT NULL DEFAULT 12,
    "keep_yearly" INTEGER NOT NULL DEFAULT 5,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notification_mode" TEXT NOT NULL DEFAULT 'INSTANT',
    "digest_schedule" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_panel_data_backup_configs" (
    "created_at",
    "digest_schedule",
    "enabled",
    "engine",
    "id",
    "keep_daily",
    "keep_monthly",
    "keep_weekly",
    "keep_yearly",
    "name",
    "notification_mode",
    "retention",
    "schedule",
    "storage_location_ids",
    "updated_at"
)
SELECT
    "created_at",
    "digest_schedule",
    "enabled",
    "engine",
    "id",
    "keep_daily",
    "keep_monthly",
    "keep_weekly",
    "keep_yearly",
    "name",
    "notification_mode",
    "retention",
    "schedule",
    "storage_location_ids",
    "updated_at"
FROM "panel_data_backup_configs";
DROP TABLE "panel_data_backup_configs";
ALTER TABLE "new_panel_data_backup_configs"
  RENAME TO "panel_data_backup_configs";
CREATE INDEX "panel_data_backup_configs_enabled_idx"
  ON "panel_data_backup_configs"("enabled");

CREATE TABLE "new_panel_data_backups" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "config_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "engine" TEXT NOT NULL DEFAULT 'RESTIC',
    "storage_location_id" TEXT,
    "restic_snapshot_id" TEXT,
    "file_path" TEXT NOT NULL DEFAULT '',
    "size_bytes" BIGINT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "started_at" DATETIME,
    "completed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "panel_data_backups_config_id_fkey"
      FOREIGN KEY ("config_id")
      REFERENCES "panel_data_backup_configs" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "panel_data_backups_storage_location_id_fkey"
      FOREIGN KEY ("storage_location_id")
      REFERENCES "storage_locations" ("id")
      ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_panel_data_backups" (
    "completed_at",
    "config_id",
    "created_at",
    "engine",
    "error_message",
    "file_path",
    "id",
    "progress",
    "restic_snapshot_id",
    "size_bytes",
    "started_at",
    "status",
    "storage_location_id"
)
SELECT
    "completed_at",
    "config_id",
    "created_at",
    "engine",
    "error_message",
    "file_path",
    "id",
    "progress",
    "restic_snapshot_id",
    "size_bytes",
    "started_at",
    "status",
    "storage_location_id"
FROM "panel_data_backups";
DROP TABLE "panel_data_backups";
ALTER TABLE "new_panel_data_backups" RENAME TO "panel_data_backups";
CREATE INDEX "panel_data_backups_config_id_idx"
  ON "panel_data_backups"("config_id");
CREATE INDEX "panel_data_backups_status_idx"
  ON "panel_data_backups"("status");

CREATE TABLE "new_server_path_backup_configs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "warning_acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "engine" TEXT NOT NULL DEFAULT 'RESTIC',
    "storage_location_ids" TEXT NOT NULL DEFAULT '[]',
    "schedule" TEXT,
    "retention" INTEGER NOT NULL DEFAULT 7,
    "keep_daily" INTEGER NOT NULL DEFAULT 7,
    "keep_weekly" INTEGER NOT NULL DEFAULT 4,
    "keep_monthly" INTEGER NOT NULL DEFAULT 6,
    "keep_yearly" INTEGER NOT NULL DEFAULT 1,
    "exclude_paths" TEXT NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notification_mode" TEXT NOT NULL DEFAULT 'INSTANT',
    "digest_schedule" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_server_path_backup_configs" (
    "created_at",
    "digest_schedule",
    "enabled",
    "engine",
    "exclude_paths",
    "id",
    "keep_daily",
    "keep_monthly",
    "keep_weekly",
    "keep_yearly",
    "name",
    "notification_mode",
    "path",
    "retention",
    "schedule",
    "storage_location_ids",
    "updated_at",
    "warning_acknowledged"
)
SELECT
    "created_at",
    "digest_schedule",
    "enabled",
    "engine",
    "exclude_paths",
    "id",
    "keep_daily",
    "keep_monthly",
    "keep_weekly",
    "keep_yearly",
    "name",
    "notification_mode",
    "path",
    "retention",
    "schedule",
    "storage_location_ids",
    "updated_at",
    "warning_acknowledged"
FROM "server_path_backup_configs";
DROP TABLE "server_path_backup_configs";
ALTER TABLE "new_server_path_backup_configs"
  RENAME TO "server_path_backup_configs";
CREATE INDEX "server_path_backup_configs_enabled_idx"
  ON "server_path_backup_configs"("enabled");

CREATE TABLE "new_server_path_backups" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "config_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "engine" TEXT NOT NULL DEFAULT 'RESTIC',
    "storage_location_id" TEXT,
    "restic_snapshot_id" TEXT,
    "file_path" TEXT NOT NULL DEFAULT '',
    "size_bytes" BIGINT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "started_at" DATETIME,
    "completed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "server_path_backups_config_id_fkey"
      FOREIGN KEY ("config_id")
      REFERENCES "server_path_backup_configs" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "server_path_backups_storage_location_id_fkey"
      FOREIGN KEY ("storage_location_id")
      REFERENCES "storage_locations" ("id")
      ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_server_path_backups" (
    "completed_at",
    "config_id",
    "created_at",
    "engine",
    "error_message",
    "file_path",
    "id",
    "progress",
    "restic_snapshot_id",
    "size_bytes",
    "started_at",
    "status",
    "storage_location_id"
)
SELECT
    "completed_at",
    "config_id",
    "created_at",
    "engine",
    "error_message",
    "file_path",
    "id",
    "progress",
    "restic_snapshot_id",
    "size_bytes",
    "started_at",
    "status",
    "storage_location_id"
FROM "server_path_backups";
DROP TABLE "server_path_backups";
ALTER TABLE "new_server_path_backups" RENAME TO "server_path_backups";
CREATE INDEX "server_path_backups_config_id_idx"
  ON "server_path_backups"("config_id");
CREATE INDEX "server_path_backups_status_idx"
  ON "server_path_backups"("status");

CREATE TABLE "new_site_backup_schedules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "type" TEXT NOT NULL DEFAULT 'FULL',
    "engine" TEXT NOT NULL DEFAULT 'RESTIC',
    "storage_location_ids" TEXT NOT NULL DEFAULT '[]',
    "schedule" TEXT,
    "keep_daily" INTEGER NOT NULL DEFAULT 7,
    "keep_weekly" INTEGER NOT NULL DEFAULT 4,
    "keep_monthly" INTEGER NOT NULL DEFAULT 6,
    "keep_yearly" INTEGER NOT NULL DEFAULT 1,
    "retention_days" INTEGER NOT NULL DEFAULT 7,
    "exclude_paths" TEXT NOT NULL DEFAULT '[]',
    "exclude_table_data" TEXT NOT NULL DEFAULT '[]',
    "check_enabled" BOOLEAN NOT NULL DEFAULT false,
    "check_schedule" TEXT,
    "check_read_data" BOOLEAN NOT NULL DEFAULT false,
    "check_read_data_subset" TEXT,
    "check_min_interval_hours" INTEGER NOT NULL DEFAULT 168,
    "notification_mode" TEXT NOT NULL DEFAULT 'INSTANT',
    "digest_schedule" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_site_backup_schedules" (
    "check_enabled",
    "check_min_interval_hours",
    "check_read_data",
    "check_read_data_subset",
    "check_schedule",
    "created_at",
    "digest_schedule",
    "enabled",
    "engine",
    "exclude_paths",
    "exclude_table_data",
    "id",
    "keep_daily",
    "keep_monthly",
    "keep_weekly",
    "keep_yearly",
    "name",
    "notification_mode",
    "retention_days",
    "schedule",
    "storage_location_ids",
    "type",
    "updated_at"
)
SELECT
    "check_enabled",
    "check_min_interval_hours",
    "check_read_data",
    "check_read_data_subset",
    "check_schedule",
    "created_at",
    "digest_schedule",
    "enabled",
    "engine",
    "exclude_paths",
    "exclude_table_data",
    "id",
    "keep_daily",
    "keep_monthly",
    "keep_weekly",
    "keep_yearly",
    "name",
    "notification_mode",
    "retention_days",
    "schedule",
    "storage_location_ids",
    "type",
    "updated_at"
FROM "site_backup_schedules";
DROP TABLE "site_backup_schedules";
ALTER TABLE "new_site_backup_schedules" RENAME TO "site_backup_schedules";
CREATE INDEX "site_backup_schedules_enabled_idx"
  ON "site_backup_schedules"("enabled");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
