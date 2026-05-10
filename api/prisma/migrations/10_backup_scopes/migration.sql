-- Новые таблицы для расширенных типов бэкапов:
--   ServerPathBackupConfig + ServerPathBackup — бэкап произвольных путей сервера.
--   PanelDataBackupConfig + PanelDataBackup — preset для данных самой панели.
--
-- Существующие BackupConfig/Backup (per-site) остаются как есть — это чище
-- архитектурно, чем общая таблица с nullable siteId.
--
-- См. docs/specs/2026-05-10-unified-backups.md.

-- ServerPathBackupConfig
CREATE TABLE "server_path_backup_configs" (
  "id"                    TEXT PRIMARY KEY,
  "name"                  TEXT NOT NULL,
  "path"                  TEXT NOT NULL,
  "warning_acknowledged"  INTEGER NOT NULL DEFAULT 0,
  "engine"                TEXT NOT NULL DEFAULT 'RESTIC',
  "storage_location_ids"  TEXT NOT NULL DEFAULT '[]',
  "schedule"              TEXT,
  "retention"             INTEGER NOT NULL DEFAULT 7,
  "keep_daily"            INTEGER NOT NULL DEFAULT 7,
  "keep_weekly"           INTEGER NOT NULL DEFAULT 4,
  "keep_monthly"          INTEGER NOT NULL DEFAULT 6,
  "keep_yearly"           INTEGER NOT NULL DEFAULT 1,
  "exclude_paths"         TEXT NOT NULL DEFAULT '[]',
  "enabled"               INTEGER NOT NULL DEFAULT 1,
  "created_at"            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "server_path_backup_configs_enabled_idx" ON "server_path_backup_configs"("enabled");

-- ServerPathBackup
CREATE TABLE "server_path_backups" (
  "id"                  TEXT PRIMARY KEY,
  "config_id"           TEXT NOT NULL,
  "status"              TEXT NOT NULL DEFAULT 'PENDING',
  "engine"              TEXT NOT NULL DEFAULT 'RESTIC',
  "storage_location_id" TEXT,
  "restic_snapshot_id"  TEXT,
  "file_path"           TEXT NOT NULL DEFAULT '',
  "size_bytes"          BIGINT,
  "progress"            INTEGER NOT NULL DEFAULT 0,
  "error_message"       TEXT,
  "started_at"          DATETIME,
  "completed_at"        DATETIME,
  "created_at"          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("config_id")           REFERENCES "server_path_backup_configs" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("storage_location_id") REFERENCES "storage_locations"          ("id") ON DELETE SET NULL
);
CREATE INDEX "server_path_backups_config_id_idx" ON "server_path_backups"("config_id");
CREATE INDEX "server_path_backups_status_idx"    ON "server_path_backups"("status");

-- PanelDataBackupConfig
CREATE TABLE "panel_data_backup_configs" (
  "id"                    TEXT PRIMARY KEY,
  "name"                  TEXT NOT NULL,
  "engine"                TEXT NOT NULL DEFAULT 'RESTIC',
  "storage_location_ids"  TEXT NOT NULL DEFAULT '[]',
  "schedule"              TEXT,
  "retention"             INTEGER NOT NULL DEFAULT 7,
  "keep_daily"            INTEGER NOT NULL DEFAULT 24,
  "keep_weekly"           INTEGER NOT NULL DEFAULT 7,
  "keep_monthly"          INTEGER NOT NULL DEFAULT 12,
  "keep_yearly"           INTEGER NOT NULL DEFAULT 5,
  "enabled"               INTEGER NOT NULL DEFAULT 1,
  "created_at"            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "panel_data_backup_configs_enabled_idx" ON "panel_data_backup_configs"("enabled");

-- PanelDataBackup
CREATE TABLE "panel_data_backups" (
  "id"                  TEXT PRIMARY KEY,
  "config_id"           TEXT NOT NULL,
  "status"              TEXT NOT NULL DEFAULT 'PENDING',
  "engine"              TEXT NOT NULL DEFAULT 'RESTIC',
  "storage_location_id" TEXT,
  "restic_snapshot_id"  TEXT,
  "file_path"           TEXT NOT NULL DEFAULT '',
  "size_bytes"          BIGINT,
  "progress"            INTEGER NOT NULL DEFAULT 0,
  "error_message"       TEXT,
  "started_at"          DATETIME,
  "completed_at"        DATETIME,
  "created_at"          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("config_id")           REFERENCES "panel_data_backup_configs" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("storage_location_id") REFERENCES "storage_locations"         ("id") ON DELETE SET NULL
);
CREATE INDEX "panel_data_backups_config_id_idx" ON "panel_data_backups"("config_id");
CREATE INDEX "panel_data_backups_status_idx"    ON "panel_data_backups"("status");
