-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_remote_servers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "installation_id" TEXT,
    "display_name" TEXT NOT NULL,
    "registry_generation" INTEGER NOT NULL DEFAULT 1,
    "activation_mode" TEXT NOT NULL DEFAULT 'DISABLED',
    "topology_mode" TEXT NOT NULL DEFAULT 'PUBLIC',
    "protocol_version" INTEGER,
    "manifest_revision" TEXT,
    "target_manifest_kid" TEXT,
    "target_manifest_public_key_spki" TEXT,
    "target_manifest_pinned_at" DATETIME,
    "product_version" TEXT,
    "transport_state" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "trust_state" TEXT NOT NULL DEFAULT 'UNENROLLED',
    "capability_state" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "browser_state" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "reason_code" TEXT,
    "transport_reason_code" TEXT,
    "trust_reason_code" TEXT,
    "capability_reason_code" TEXT,
    "browser_reason_code" TEXT,
    "status_checked_at" DATETIME,
    "transport_fresh_until" DATETIME,
    "trust_checked_at" DATETIME,
    "trust_fresh_until" DATETIME,
    "manifest_fetched_at" DATETIME,
    "browser_checked_at" DATETIME,
    "browser_fresh_until" DATETIME,
    "active_endpoint_generation" INTEGER,
    "candidate_endpoint_generation" INTEGER,
    "previous_endpoint_generation" INTEGER,
    "http_enabled" BOOLEAN NOT NULL DEFAULT false,
    "ws_enabled" BOOLEAN NOT NULL DEFAULT false,
    "public_enabled" BOOLEAN NOT NULL DEFAULT false,
    "legacy_enabled" BOOLEAN NOT NULL DEFAULT false,
    "rollout_stage" TEXT NOT NULL DEFAULT 'DISABLED',
    "rollout_stage_started_at" DATETIME,
    "rollout_evidence_json" TEXT,
    "rollout_approved_at" DATETIME,
    "legacy_url" TEXT,
    "legacy_token_enc" TEXT,
    "mutation_frozen_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_remote_servers" ("activation_mode", "active_endpoint_generation", "browser_checked_at", "browser_fresh_until", "browser_reason_code", "browser_state", "candidate_endpoint_generation", "capability_reason_code", "capability_state", "created_at", "display_name", "http_enabled", "id", "installation_id", "legacy_enabled", "legacy_token_enc", "legacy_url", "manifest_fetched_at", "manifest_revision", "mutation_frozen_at", "previous_endpoint_generation", "product_version", "protocol_version", "public_enabled", "reason_code", "registry_generation", "status_checked_at", "target_manifest_kid", "target_manifest_pinned_at", "target_manifest_public_key_spki", "topology_mode", "transport_fresh_until", "transport_reason_code", "transport_state", "trust_checked_at", "trust_fresh_until", "trust_reason_code", "trust_state", "updated_at", "ws_enabled") SELECT "activation_mode", "active_endpoint_generation", "browser_checked_at", "browser_fresh_until", "browser_reason_code", "browser_state", "candidate_endpoint_generation", "capability_reason_code", "capability_state", "created_at", "display_name", "http_enabled", "id", "installation_id", "legacy_enabled", "legacy_token_enc", "legacy_url", "manifest_fetched_at", "manifest_revision", "mutation_frozen_at", "previous_endpoint_generation", "product_version", "protocol_version", "public_enabled", "reason_code", "registry_generation", "status_checked_at", "target_manifest_kid", "target_manifest_pinned_at", "target_manifest_public_key_spki", "topology_mode", "transport_fresh_until", "transport_reason_code", "transport_state", "trust_checked_at", "trust_fresh_until", "trust_reason_code", "trust_state", "updated_at", "ws_enabled" FROM "remote_servers";
DROP TABLE "remote_servers";
ALTER TABLE "new_remote_servers" RENAME TO "remote_servers";
CREATE UNIQUE INDEX "remote_servers_installation_id_key" ON "remote_servers"("installation_id");
CREATE UNIQUE INDEX "remote_servers_display_name_key" ON "remote_servers"("display_name");
CREATE INDEX "remote_servers_activation_mode_transport_state_idx" ON "remote_servers"("activation_mode", "transport_state");
CREATE INDEX "remote_servers_trust_state_capability_state_idx" ON "remote_servers"("trust_state", "capability_state");
CREATE INDEX "remote_servers_rollout_stage_updated_at_idx" ON "remote_servers"("rollout_stage", "updated_at");
CREATE INDEX "remote_servers_updated_at_idx" ON "remote_servers"("updated_at");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
