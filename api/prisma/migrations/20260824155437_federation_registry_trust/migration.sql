-- CreateTable
CREATE TABLE "panel_identities" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT '_',
    "installation_id" TEXT NOT NULL,
    "installation_role" TEXT NOT NULL DEFAULT 'TARGET',
    "manifest_kid" TEXT,
    "manifest_public_key_spki" TEXT,
    "manifest_private_key_enc" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "remote_servers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "installation_id" TEXT,
    "display_name" TEXT NOT NULL,
    "registry_generation" INTEGER NOT NULL DEFAULT 1,
    "activation_mode" TEXT NOT NULL DEFAULT 'DISABLED',
    "topology_mode" TEXT NOT NULL DEFAULT 'PUBLIC',
    "protocol_version" INTEGER,
    "manifest_revision" TEXT,
    "product_version" TEXT,
    "transport_state" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "trust_state" TEXT NOT NULL DEFAULT 'UNENROLLED',
    "capability_state" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "browser_state" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "reason_code" TEXT,
    "status_checked_at" DATETIME,
    "manifest_fetched_at" DATETIME,
    "active_endpoint_generation" INTEGER,
    "candidate_endpoint_generation" INTEGER,
    "previous_endpoint_generation" INTEGER,
    "http_enabled" BOOLEAN NOT NULL DEFAULT false,
    "ws_enabled" BOOLEAN NOT NULL DEFAULT false,
    "public_enabled" BOOLEAN NOT NULL DEFAULT false,
    "legacy_enabled" BOOLEAN NOT NULL DEFAULT false,
    "legacy_token_enc" TEXT,
    "mutation_frozen_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "remote_endpoints" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "remote_server_id" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'CANDIDATE',
    "api_origin" TEXT NOT NULL,
    "ws_origin" TEXT NOT NULL,
    "ws_path" TEXT NOT NULL DEFAULT '/socket.io',
    "browser_public_origin" TEXT,
    "direct_transfer_origin" TEXT,
    "ssh_host" TEXT NOT NULL,
    "ssh_port" INTEGER NOT NULL DEFAULT 22,
    "spki_sha256" TEXT NOT NULL,
    "ca_certificate_pem" TEXT,
    "normalized_hash" TEXT NOT NULL,
    "verified_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "remote_endpoints_remote_server_id_fkey" FOREIGN KEY ("remote_server_id") REFERENCES "remote_servers" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "remote_manifest_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "remote_server_id" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "revision" TEXT NOT NULL,
    "protocol_min" INTEGER NOT NULL,
    "protocol_max" INTEGER NOT NULL,
    "accepted_master_range" TEXT NOT NULL,
    "capabilities_json" TEXT NOT NULL,
    "endpoints_json" TEXT NOT NULL,
    "signing_kid" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "validation_state" TEXT NOT NULL,
    "valid_until" DATETIME NOT NULL,
    "fetched_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "remote_manifest_snapshots_remote_server_id_fkey" FOREIGN KEY ("remote_server_id") REFERENCES "remote_servers" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "federation_issuers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "remote_server_id" TEXT,
    "issuer_installation_id" TEXT NOT NULL,
    "target_installation_id" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "max_role" TEXT NOT NULL DEFAULT 'MANAGER',
    "permission_policy_json" TEXT NOT NULL DEFAULT '[]',
    "principal_version" INTEGER NOT NULL DEFAULT 1,
    "revoked_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "federation_issuers_remote_server_id_fkey" FOREIGN KEY ("remote_server_id") REFERENCES "remote_servers" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "federation_keys" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "issuer_id" TEXT NOT NULL,
    "kid" TEXT NOT NULL,
    "public_key_spki" TEXT NOT NULL,
    "encrypted_private_key" TEXT,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "valid_from" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME,
    "revoked_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "federation_keys_issuer_id_fkey" FOREIGN KEY ("issuer_id") REFERENCES "federation_issuers" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "federation_enrollments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "remote_server_id" TEXT,
    "requested_display_name" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PREPARED',
    "ssh_host" TEXT NOT NULL,
    "ssh_port" INTEGER NOT NULL DEFAULT 22,
    "ssh_fingerprint" TEXT NOT NULL,
    "bootstrap_hash" TEXT NOT NULL,
    "candidate_endpoint_json" TEXT,
    "target_installation_id" TEXT,
    "sanitized_error_code" TEXT,
    "expires_at" DATETIME NOT NULL,
    "completed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "federation_enrollments_remote_server_id_fkey" FOREIGN KEY ("remote_server_id") REFERENCES "remote_servers" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "federation_replays" (
    "replay_hash" TEXT NOT NULL PRIMARY KEY,
    "issuer_id" TEXT NOT NULL,
    "kid" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "action_id" TEXT NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "federation_replays_issuer_id_fkey" FOREIGN KEY ("issuer_id") REFERENCES "federation_issuers" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "registry_projection_journal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "registry_generation" INTEGER NOT NULL,
    "source_digest" TEXT NOT NULL,
    "projection_digest" TEXT,
    "state" TEXT NOT NULL DEFAULT 'PREPARED',
    "sanitized_error_code" TEXT,
    "committed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "remote_endpoint_cutovers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "remote_server_id" TEXT NOT NULL,
    "from_generation" INTEGER NOT NULL,
    "to_generation" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PREPARED',
    "deadline_at" DATETIME NOT NULL,
    "activated_at" DATETIME,
    "finalized_at" DATETIME,
    "rolled_back_at" DATETIME,
    "sanitized_error_code" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "remote_endpoint_cutovers_remote_server_id_fkey" FOREIGN KEY ("remote_server_id") REFERENCES "remote_servers" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "panel_identities_installation_id_key" ON "panel_identities"("installation_id");

-- CreateIndex
CREATE UNIQUE INDEX "remote_servers_installation_id_key" ON "remote_servers"("installation_id");

-- CreateIndex
CREATE UNIQUE INDEX "remote_servers_display_name_key" ON "remote_servers"("display_name");

-- CreateIndex
CREATE INDEX "remote_servers_activation_mode_transport_state_idx" ON "remote_servers"("activation_mode", "transport_state");

-- CreateIndex
CREATE INDEX "remote_servers_trust_state_capability_state_idx" ON "remote_servers"("trust_state", "capability_state");

-- CreateIndex
CREATE INDEX "remote_servers_updated_at_idx" ON "remote_servers"("updated_at");

-- CreateIndex
CREATE INDEX "remote_endpoints_remote_server_id_state_idx" ON "remote_endpoints"("remote_server_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "remote_endpoints_remote_server_id_generation_key" ON "remote_endpoints"("remote_server_id", "generation");

-- CreateIndex
CREATE INDEX "remote_manifest_snapshots_remote_server_id_fetched_at_idx" ON "remote_manifest_snapshots"("remote_server_id", "fetched_at");

-- CreateIndex
CREATE INDEX "remote_manifest_snapshots_valid_until_idx" ON "remote_manifest_snapshots"("valid_until");

-- CreateIndex
CREATE UNIQUE INDEX "remote_manifest_snapshots_remote_server_id_revision_key" ON "remote_manifest_snapshots"("remote_server_id", "revision");

-- CreateIndex
CREATE INDEX "federation_issuers_remote_server_id_state_idx" ON "federation_issuers"("remote_server_id", "state");

-- CreateIndex
CREATE INDEX "federation_issuers_state_updated_at_idx" ON "federation_issuers"("state", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "federation_issuers_issuer_installation_id_target_installation_id_key" ON "federation_issuers"("issuer_installation_id", "target_installation_id");

-- CreateIndex
CREATE UNIQUE INDEX "federation_keys_kid_key" ON "federation_keys"("kid");

-- CreateIndex
CREATE INDEX "federation_keys_issuer_id_state_idx" ON "federation_keys"("issuer_id", "state");

-- CreateIndex
CREATE INDEX "federation_keys_expires_at_idx" ON "federation_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "federation_enrollments_bootstrap_hash_key" ON "federation_enrollments"("bootstrap_hash");

-- CreateIndex
CREATE INDEX "federation_enrollments_state_updated_at_idx" ON "federation_enrollments"("state", "updated_at");

-- CreateIndex
CREATE INDEX "federation_enrollments_remote_server_id_idx" ON "federation_enrollments"("remote_server_id");

-- CreateIndex
CREATE INDEX "federation_enrollments_expires_at_idx" ON "federation_enrollments"("expires_at");

-- CreateIndex
CREATE INDEX "federation_replays_issuer_id_expires_at_idx" ON "federation_replays"("issuer_id", "expires_at");

-- CreateIndex
CREATE INDEX "federation_replays_expires_at_idx" ON "federation_replays"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "federation_replays_issuer_id_request_id_key" ON "federation_replays"("issuer_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "registry_projection_journal_registry_generation_key" ON "registry_projection_journal"("registry_generation");

-- CreateIndex
CREATE INDEX "registry_projection_journal_state_updated_at_idx" ON "registry_projection_journal"("state", "updated_at");

-- CreateIndex
CREATE INDEX "remote_endpoint_cutovers_remote_server_id_state_idx" ON "remote_endpoint_cutovers"("remote_server_id", "state");

-- CreateIndex
CREATE INDEX "remote_endpoint_cutovers_deadline_at_idx" ON "remote_endpoint_cutovers"("deadline_at");
