-- CreateTable
CREATE TABLE "system_migrations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applied_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "duration_ms" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "error_log" TEXT
);

-- CreateTable
CREATE TABLE "panel_update_state" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'current',
    "status" TEXT NOT NULL DEFAULT 'idle',
    "from_version" TEXT,
    "to_version" TEXT,
    "started_at" DATETIME,
    "finished_at" DATETIME,
    "pid" INTEGER,
    "current_stage" TEXT,
    "error_message" TEXT,
    "log_tail" TEXT
);

-- CreateTable
CREATE TABLE "panel_update_history" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "from_version" TEXT,
    "to_version" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "started_at" DATETIME NOT NULL,
    "finished_at" DATETIME NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "triggered_by" TEXT,
    "error_message" TEXT
);

-- CreateIndex
CREATE INDEX "panel_update_history_started_at_idx" ON "panel_update_history"("started_at");
