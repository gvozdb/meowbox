-- Operation v2 is ordered after the legacy zz deploy-operation baseline.
-- CreateTable
CREATE TABLE "remote_operation_links" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "remote_server_id" TEXT NOT NULL,
    "target_operation_id" TEXT NOT NULL,
    "master_user_id" TEXT NOT NULL,
    "action_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "last_polled_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "remote_operation_links_remote_server_id_fkey" FOREIGN KEY ("remote_server_id") REFERENCES "remote_servers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "remote_operation_links_master_user_id_fkey" FOREIGN KEY ("master_user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_operations" (
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
    "action_id" TEXT,
    "execution_mode" TEXT NOT NULL DEFAULT 'INLINE',
    "policy_snapshot" TEXT,
    "request_payload_enc" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 1,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "recovery_policy" TEXT NOT NULL DEFAULT 'MANUAL',
    "lease_owner" TEXT,
    "lease_expires_at" DATETIME,
    "heartbeat_at" DATETIME,
    "claimed_at" DATETIME,
    "deadline_at" DATETIME,
    "cancel_requested_at" DATETIME,
    "cancel_outcome" TEXT,
    "result" TEXT,
    "error_message" TEXT,
    "started_at" DATETIME,
    "completed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "operations_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "operations_site_domain_id_fkey" FOREIGN KEY ("site_domain_id") REFERENCES "site_domains" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "operations_database_id_fkey" FOREIGN KEY ("database_id") REFERENCES "databases" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "operations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "operations_parent_operation_id_fkey" FOREIGN KEY ("parent_operation_id") REFERENCES "operations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_operations" ("completed_at", "created_at", "created_by_user_id", "current_step", "database_id", "error_message", "global_lock_key", "id", "idempotency_key", "parent_operation_id", "progress", "request_hash", "result", "site_domain_id", "site_id", "started_at", "status", "type", "updated_at") SELECT "completed_at", "created_at", "created_by_user_id", "current_step", "database_id", "error_message", "global_lock_key", "id", "idempotency_key", "parent_operation_id", "progress", "request_hash", "result", "site_domain_id", "site_id", "started_at", "status", "type", "updated_at" FROM "operations";
DROP TABLE "operations";
ALTER TABLE "new_operations" RENAME TO "operations";
CREATE UNIQUE INDEX "operations_idempotency_key_key" ON "operations"("idempotency_key");
CREATE INDEX "operations_site_id_status_idx" ON "operations"("site_id", "status");
CREATE INDEX "operations_site_domain_id_status_idx" ON "operations"("site_domain_id", "status");
CREATE INDEX "operations_database_id_status_idx" ON "operations"("database_id", "status");
CREATE INDEX "operations_global_lock_key_status_idx" ON "operations"("global_lock_key", "status");
CREATE INDEX "operations_parent_operation_id_created_at_idx" ON "operations"("parent_operation_id", "created_at");
CREATE INDEX "operations_execution_mode_status_lease_expires_at_created_at_idx" ON "operations"("execution_mode", "status", "lease_expires_at", "created_at");
CREATE INDEX "operations_created_by_user_id_status_created_at_idx" ON "operations"("created_by_user_id", "status", "created_at");
CREATE INDEX "operations_action_id_status_idx" ON "operations"("action_id", "status");
CREATE INDEX "operations_created_at_idx" ON "operations"("created_at");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "remote_operation_links_master_user_id_created_at_idx" ON "remote_operation_links"("master_user_id", "created_at");

-- CreateIndex
CREATE INDEX "remote_operation_links_correlation_id_idx" ON "remote_operation_links"("correlation_id");

-- CreateIndex
CREATE UNIQUE INDEX "remote_operation_links_remote_server_id_target_operation_id_key" ON "remote_operation_links"("remote_server_id", "target_operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "remote_operation_links_remote_server_id_request_id_key" ON "remote_operation_links"("remote_server_id", "request_id");
