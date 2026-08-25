-- CreateTable
CREATE TABLE "webhook_routes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dedupe_key" TEXT,
    "token_version" INTEGER NOT NULL DEFAULT 1,
    "token_hash" TEXT NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "remote_server_id" TEXT,
    "target_installation_id" TEXT NOT NULL,
    "target_site_id" TEXT NOT NULL,
    "target_domain_id" TEXT NOT NULL,
    "target_domain" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "verifier_enc" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "revoked_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "webhook_routes_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "webhook_routes_remote_server_id_fkey" FOREIGN KEY ("remote_server_id") REFERENCES "remote_servers" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "route_id" TEXT NOT NULL,
    "provider_delivery_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "body_sha256" TEXT NOT NULL,
    "spool_relative_path" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ACCEPTED',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 6,
    "available_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" TEXT,
    "lease_expires_at" DATETIME,
    "last_attempt_at" DATETIME,
    "target_request_id" TEXT,
    "result" TEXT,
    "last_error_code" TEXT,
    "accepted_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" DATETIME,
    "dlq_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "webhook_deliveries_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "webhook_routes" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "webhook_delivery_receipts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "issuer_installation_id" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "route_id" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PROCESSING',
    "deploy_id" TEXT,
    "result" TEXT,
    "last_error_code" TEXT,
    "received_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" DATETIME,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "webhook_routes_dedupe_key_key" ON "webhook_routes"("dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_routes_token_hash_key" ON "webhook_routes"("token_hash");

-- CreateIndex
CREATE INDEX "webhook_routes_created_by_user_id_state_updated_at_idx" ON "webhook_routes"("created_by_user_id", "state", "updated_at");

-- CreateIndex
CREATE INDEX "webhook_routes_remote_server_id_state_idx" ON "webhook_routes"("remote_server_id", "state");

-- CreateIndex
CREATE INDEX "webhook_routes_target_installation_id_state_idx" ON "webhook_routes"("target_installation_id", "state");

-- CreateIndex
CREATE INDEX "webhook_deliveries_state_available_at_lease_expires_at_idx" ON "webhook_deliveries"("state", "available_at", "lease_expires_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_route_id_created_at_idx" ON "webhook_deliveries"("route_id", "created_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_dlq_at_idx" ON "webhook_deliveries"("dlq_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_route_id_provider_delivery_id_key" ON "webhook_deliveries"("route_id", "provider_delivery_id");

-- CreateIndex
CREATE INDEX "webhook_delivery_receipts_route_id_received_at_idx" ON "webhook_delivery_receipts"("route_id", "received_at");

-- CreateIndex
CREATE INDEX "webhook_delivery_receipts_state_updated_at_idx" ON "webhook_delivery_receipts"("state", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_delivery_receipts_issuer_installation_id_delivery_id_key" ON "webhook_delivery_receipts"("issuer_installation_id", "delivery_id");

-- Existing verifier-side relationships may already have the reviewed webhook
-- action in their issuer policy (for example after an enrollment rehearsal).
-- Add only the exact one-purpose service principal; never widen issuer policy.
INSERT INTO "service_principals" (
    "id",
    "issuer_id",
    "subject",
    "purpose_namespace",
    "state",
    "principal_version",
    "permissions_json",
    "last_seen_at",
    "created_at",
    "updated_at"
)
SELECT
    lower(hex(randomblob(4))) || '-' ||
      lower(hex(randomblob(2))) || '-4' ||
      substr(lower(hex(randomblob(2))), 2, 3) || '-8' ||
      substr(lower(hex(randomblob(2))), 2, 3) || '-' ||
      lower(hex(randomblob(6))),
    issuer."id",
    'webhook-delivery-gateway',
    'http.post.federation-v1-webhooks-deliveries-delivery-id',
    'ACTIVE',
    issuer."principal_version",
    '["http.post.federation-v1-webhooks-deliveries-delivery-id"]',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "federation_issuers" AS issuer
WHERE issuer."state" = 'ACTIVE'
  AND issuer."revoked_at" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "federation_keys" AS key
    WHERE key."issuer_id" = issuer."id"
      AND key."encrypted_private_key" IS NULL
      AND key."state" = 'ACTIVE'
      AND key."revoked_at" IS NULL
  )
  AND EXISTS (
    SELECT 1
    FROM json_each(issuer."permission_policy_json") AS permission
    WHERE permission.value = 'http.post.federation-v1-webhooks-deliveries-delivery-id'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "service_principals" AS principal
    WHERE principal."issuer_id" = issuer."id"
      AND principal."subject" = 'webhook-delivery-gateway'
  );
