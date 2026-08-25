-- CreateTable
CREATE TABLE "federated_vpn_subscriptions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dedupe_key" TEXT,
    "token_hash" TEXT NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "max_stale_seconds" INTEGER NOT NULL DEFAULT 300,
    "revoked_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "federated_vpn_subscriptions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "federated_vpn_subscription_sources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subscription_id" TEXT NOT NULL,
    "remote_server_id" TEXT,
    "target_installation_id" TEXT NOT NULL,
    "vpn_user_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "invalidated_at" DATETIME,
    "last_success_at" DATETIME,
    "last_failure_at" DATETIME,
    "last_failure_code" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "federated_vpn_subscription_sources_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "federated_vpn_subscriptions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "federated_vpn_subscription_sources_remote_server_id_fkey" FOREIGN KEY ("remote_server_id") REFERENCES "remote_servers" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "federated_vpn_subscription_cache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source_id" TEXT NOT NULL,
    "epoch" TEXT NOT NULL,
    "payload_enc" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "generated_at" DATETIME NOT NULL,
    "valid_until" DATETIME NOT NULL,
    "invalidated_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "federated_vpn_subscription_cache_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "federated_vpn_subscription_sources" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "federated_vpn_subscriptions_dedupe_key_key" ON "federated_vpn_subscriptions"("dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "federated_vpn_subscriptions_token_hash_key" ON "federated_vpn_subscriptions"("token_hash");

-- CreateIndex
CREATE INDEX "federated_vpn_subscriptions_created_by_user_id_state_updated_at_idx" ON "federated_vpn_subscriptions"("created_by_user_id", "state", "updated_at");

-- CreateIndex
CREATE INDEX "federated_vpn_subscriptions_state_revoked_at_idx" ON "federated_vpn_subscriptions"("state", "revoked_at");

-- CreateIndex
CREATE INDEX "federated_vpn_subscription_sources_remote_server_id_state_idx" ON "federated_vpn_subscription_sources"("remote_server_id", "state");

-- CreateIndex
CREATE INDEX "federated_vpn_subscription_sources_target_installation_id_state_idx" ON "federated_vpn_subscription_sources"("target_installation_id", "state");

-- CreateIndex
CREATE INDEX "federated_vpn_subscription_sources_vpn_user_id_idx" ON "federated_vpn_subscription_sources"("vpn_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "federated_vpn_subscription_sources_subscription_id_target_installation_id_vpn_user_id_key" ON "federated_vpn_subscription_sources"("subscription_id", "target_installation_id", "vpn_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "federated_vpn_subscription_sources_subscription_id_position_key" ON "federated_vpn_subscription_sources"("subscription_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "federated_vpn_subscription_cache_source_id_key" ON "federated_vpn_subscription_cache"("source_id");

-- CreateIndex
CREATE INDEX "federated_vpn_subscription_cache_valid_until_invalidated_at_idx" ON "federated_vpn_subscription_cache"("valid_until", "invalidated_at");

-- CreateIndex
CREATE INDEX "federated_vpn_subscription_cache_fingerprint_idx" ON "federated_vpn_subscription_cache"("fingerprint");

-- Existing target-side trust relationships predate purpose-scoped VPN service
-- principals. Backfill only verifier-side issuers (public key only), and only
-- when the reviewed action is already present in their issuer policy.
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
    'vpn-subscription-gateway',
    'http.get.federation-v1-vpn-fragments-vpn-user-id',
    'ACTIVE',
    issuer."principal_version",
    '["http.get.federation-v1-vpn-fragments-vpn-user-id"]',
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
    WHERE permission.value = 'http.get.federation-v1-vpn-fragments-vpn-user-id'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "service_principals" AS principal
    WHERE principal."issuer_id" = issuer."id"
      AND principal."subject" = 'vpn-subscription-gateway'
  );
