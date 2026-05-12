-- Множественные шедули для per-site бэкапов + дайджест-уведомления.
-- См. spec: переделка вкладки «Расписание» по образцу server-path/panel-data.
--
-- Изменения:
--   1. CREATE site_backup_schedules — множественные конфиги (заменяют
--      одиночный backup-defaults в panel_settings).
--   2. CREATE notification_digest_queue — очередь событий для дайджеста.
--   3. ALTER server_path_backup_configs + panel_data_backup_configs:
--      ADD notification_mode/digest_schedule.
--   4. CREATE join-таблица SiteBackupSchedule ↔ StorageLocation (M2M).
--
-- Данные backup-defaults из panel_settings переносятся в site_backup_schedules
-- отдельной системной миграцией (migrations/system/2026-05-12-001-migrate-backup-defaults).

-- =============================================================================
-- 1. SiteBackupSchedule
-- =============================================================================
CREATE TABLE "site_backup_schedules" (
    "id"                         TEXT PRIMARY KEY,
    "name"                       TEXT NOT NULL,
    "enabled"                    INTEGER NOT NULL DEFAULT 1,
    "type"                       TEXT NOT NULL DEFAULT 'FULL',
    "engine"                     TEXT NOT NULL DEFAULT 'RESTIC',
    "storage_location_ids"       TEXT NOT NULL DEFAULT '[]',
    "schedule"                   TEXT,
    "keep_daily"                 INTEGER NOT NULL DEFAULT 7,
    "keep_weekly"                INTEGER NOT NULL DEFAULT 4,
    "keep_monthly"               INTEGER NOT NULL DEFAULT 6,
    "keep_yearly"                INTEGER NOT NULL DEFAULT 1,
    "retention_days"             INTEGER NOT NULL DEFAULT 7,
    "exclude_paths"              TEXT NOT NULL DEFAULT '[]',
    "exclude_table_data"         TEXT NOT NULL DEFAULT '[]',
    "check_enabled"              INTEGER NOT NULL DEFAULT 0,
    "check_schedule"             TEXT,
    "check_read_data"            INTEGER NOT NULL DEFAULT 0,
    "check_read_data_subset"     TEXT,
    "check_min_interval_hours"   INTEGER NOT NULL DEFAULT 168,
    "notification_mode"          TEXT NOT NULL DEFAULT 'INSTANT',
    "digest_schedule"            TEXT,
    "created_at"                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "site_backup_schedules_enabled_idx" ON "site_backup_schedules"("enabled");

-- Implicit M2M join: SiteBackupSchedule ↔ StorageLocation
CREATE TABLE "_SiteBackupScheduleToStorageLocation" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    FOREIGN KEY ("A") REFERENCES "site_backup_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY ("B") REFERENCES "storage_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "_SiteBackupScheduleToStorageLocation_AB_unique"
    ON "_SiteBackupScheduleToStorageLocation"("A" ASC, "B" ASC);
CREATE INDEX "_SiteBackupScheduleToStorageLocation_B_index"
    ON "_SiteBackupScheduleToStorageLocation"("B" ASC);

-- =============================================================================
-- 2. NotificationDigestQueue
-- =============================================================================
CREATE TABLE "notification_digest_queue" (
    "id"             TEXT PRIMARY KEY,
    "config_type"    TEXT NOT NULL,
    "config_id"      TEXT NOT NULL,
    "config_name"    TEXT NOT NULL,
    "event"          TEXT NOT NULL,
    "resource_label" TEXT NOT NULL,
    "size_bytes"     BIGINT,
    "message"        TEXT,
    "created_at"     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at"        DATETIME
);
CREATE INDEX "notification_digest_queue_config_type_config_id_sent_at_idx"
    ON "notification_digest_queue"("config_type", "config_id", "sent_at");
CREATE INDEX "notification_digest_queue_sent_at_idx"
    ON "notification_digest_queue"("sent_at");

-- =============================================================================
-- 3. ALTER server_path_backup_configs + panel_data_backup_configs
-- =============================================================================
ALTER TABLE "server_path_backup_configs" ADD COLUMN "notification_mode" TEXT NOT NULL DEFAULT 'INSTANT';
ALTER TABLE "server_path_backup_configs" ADD COLUMN "digest_schedule"   TEXT;

ALTER TABLE "panel_data_backup_configs" ADD COLUMN "notification_mode" TEXT NOT NULL DEFAULT 'INSTANT';
ALTER TABLE "panel_data_backup_configs" ADD COLUMN "digest_schedule"   TEXT;
