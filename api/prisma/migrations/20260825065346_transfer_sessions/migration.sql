-- CreateTable
CREATE TABLE "transfer_artifacts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "target_installation_id" TEXT NOT NULL,
    "source_kind" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'STAGING',
    "relative_path" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "size_bytes" BIGINT,
    "sha256" TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "ready_at" DATETIME,
    "deleted_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "transfer_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "target_installation_id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "source_kind" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "transfer_mode" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "actor_role" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "artifact_id" TEXT,
    "content_length" BIGINT,
    "sha256" TEXT,
    "expires_at" DATETIME NOT NULL,
    "started_at" DATETIME,
    "completed_at" DATETIME,
    "consumed_at" DATETIME,
    "failure_code" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "transfer_sessions_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "transfer_artifacts" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "transfer_artifacts_state_expires_at_idx" ON "transfer_artifacts"("state", "expires_at");

-- CreateIndex
CREATE INDEX "transfer_artifacts_source_kind_resource_id_created_at_idx" ON "transfer_artifacts"("source_kind", "resource_id", "created_at");

-- CreateIndex
CREATE INDEX "transfer_artifacts_created_by_user_id_created_at_idx" ON "transfer_artifacts"("created_by_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "transfer_sessions_secret_hash_key" ON "transfer_sessions"("secret_hash");

-- CreateIndex
CREATE INDEX "transfer_sessions_actor_user_id_expires_at_completed_at_idx" ON "transfer_sessions"("actor_user_id", "expires_at", "completed_at");

-- CreateIndex
CREATE INDEX "transfer_sessions_target_installation_id_expires_at_completed_at_idx" ON "transfer_sessions"("target_installation_id", "expires_at", "completed_at");

-- CreateIndex
CREATE INDEX "transfer_sessions_source_kind_resource_id_created_at_idx" ON "transfer_sessions"("source_kind", "resource_id", "created_at");

-- CreateIndex
CREATE INDEX "transfer_sessions_artifact_id_expires_at_idx" ON "transfer_sessions"("artifact_id", "expires_at");

-- CreateIndex
CREATE INDEX "transfer_sessions_expires_at_consumed_at_idx" ON "transfer_sessions"("expires_at", "consumed_at");
