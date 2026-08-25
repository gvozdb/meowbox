-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_federation_enrollments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "remote_server_id" TEXT,
    "enrollment_role" TEXT NOT NULL DEFAULT 'TARGET_BOOTSTRAP',
    "requested_by_user_id" TEXT,
    "requested_display_name" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PREPARED',
    "ssh_host" TEXT NOT NULL,
    "ssh_port" INTEGER NOT NULL DEFAULT 22,
    "ssh_fingerprint" TEXT NOT NULL,
    "bootstrap_hash" TEXT NOT NULL,
    "bootstrap_secret_enc" TEXT,
    "candidate_endpoint_json" TEXT,
    "target_installation_id" TEXT,
    "target_manifest_kid" TEXT,
    "target_manifest_key_spki" TEXT,
    "delegation_issuer_id" TEXT,
    "sanitized_error_code" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" DATETIME,
    "expires_at" DATETIME NOT NULL,
    "completed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "federation_enrollments_remote_server_id_fkey" FOREIGN KEY ("remote_server_id") REFERENCES "remote_servers" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_federation_enrollments" ("bootstrap_hash", "candidate_endpoint_json", "completed_at", "created_at", "expires_at", "id", "remote_server_id", "requested_display_name", "sanitized_error_code", "ssh_fingerprint", "ssh_host", "ssh_port", "state", "target_installation_id", "updated_at") SELECT "bootstrap_hash", "candidate_endpoint_json", "completed_at", "created_at", "expires_at", "id", "remote_server_id", "requested_display_name", "sanitized_error_code", "ssh_fingerprint", "ssh_host", "ssh_port", "state", "target_installation_id", "updated_at" FROM "federation_enrollments";
DROP TABLE "federation_enrollments";
ALTER TABLE "new_federation_enrollments" RENAME TO "federation_enrollments";
CREATE UNIQUE INDEX "federation_enrollments_bootstrap_hash_key" ON "federation_enrollments"("bootstrap_hash");
CREATE INDEX "federation_enrollments_state_updated_at_idx" ON "federation_enrollments"("state", "updated_at");
CREATE INDEX "federation_enrollments_enrollment_role_state_updated_at_idx" ON "federation_enrollments"("enrollment_role", "state", "updated_at");
CREATE INDEX "federation_enrollments_remote_server_id_idx" ON "federation_enrollments"("remote_server_id");
CREATE INDEX "federation_enrollments_requested_by_user_id_created_at_idx" ON "federation_enrollments"("requested_by_user_id", "created_at");
CREATE INDEX "federation_enrollments_delegation_issuer_id_idx" ON "federation_enrollments"("delegation_issuer_id");
CREATE INDEX "federation_enrollments_expires_at_idx" ON "federation_enrollments"("expires_at");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
