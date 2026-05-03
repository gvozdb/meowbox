-- Hostpanel migration — Phase 1 schema:
--   1) Site.metadata — JSON-маркер для контракта cleanup'а при миграциях
--   2) system_cron_jobs — задачи в crontab юзера root (вне привязки к Site)
--   3) hostpanel_migrations + hostpanel_migration_items — состояние миграций
--      сайтов со старой hostPanel на текущий slave-сервер meowbox.
--
-- См. /opt/meowbox/docs/specs/2026-05-01-hostpanel-migration.md

-- =====================================================================
-- 1) Site.metadata — добавление колонки в существующую таблицу sites
-- =====================================================================
ALTER TABLE "sites" ADD COLUMN "metadata" TEXT;

-- =====================================================================
-- 2) system_cron_jobs
-- =====================================================================
CREATE TABLE "system_cron_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "comment" TEXT,
    "last_output" TEXT,
    "last_run_at" DATETIME,
    "last_exit_code" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- =====================================================================
-- 3) hostpanel_migrations
-- =====================================================================
CREATE TABLE "hostpanel_migrations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "source" TEXT NOT NULL,
    "discovery" TEXT,
    "total_sites" INTEGER NOT NULL DEFAULT 0,
    "done_sites" INTEGER NOT NULL DEFAULT 0,
    "failed_sites" INTEGER NOT NULL DEFAULT 0,
    "log" TEXT NOT NULL DEFAULT '',
    "error_message" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" DATETIME,
    "finished_at" DATETIME,
    "created_by" TEXT NOT NULL
);

CREATE INDEX "hostpanel_migrations_status_idx" ON "hostpanel_migrations"("status");
CREATE INDEX "hostpanel_migrations_created_at_idx" ON "hostpanel_migrations"("created_at");

-- =====================================================================
-- 4) hostpanel_migration_items
-- =====================================================================
CREATE TABLE "hostpanel_migration_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "migration_id" TEXT NOT NULL,
    "source_site_id" INTEGER NOT NULL,
    "source_data" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "new_site_id" TEXT,
    "error_msg" TEXT,
    "started_at" DATETIME,
    "finished_at" DATETIME,
    "progress_percent" INTEGER NOT NULL DEFAULT 0,
    "current_stage" TEXT,
    "log" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "hostpanel_migration_items_migration_id_fkey"
        FOREIGN KEY ("migration_id") REFERENCES "hostpanel_migrations" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "hostpanel_migration_items_migration_id_idx" ON "hostpanel_migration_items"("migration_id");
CREATE INDEX "hostpanel_migration_items_status_idx" ON "hostpanel_migration_items"("status");
