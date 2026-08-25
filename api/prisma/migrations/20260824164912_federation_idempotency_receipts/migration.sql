-- CreateTable
CREATE TABLE "federation_idempotency_receipts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "issuer_id" TEXT NOT NULL,
    "actor_kind" TEXT NOT NULL,
    "subject_hash" TEXT NOT NULL,
    "action_id" TEXT NOT NULL,
    "idempotency_key_hash" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'CLAIMED',
    "expires_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "federation_idempotency_receipts_issuer_id_fkey" FOREIGN KEY ("issuer_id") REFERENCES "federation_issuers" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "federation_idempotency_receipts_issuer_id_expires_at_idx" ON "federation_idempotency_receipts"("issuer_id", "expires_at");

-- CreateIndex
CREATE INDEX "federation_idempotency_receipts_expires_at_idx" ON "federation_idempotency_receipts"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "federation_idempotency_receipts_issuer_id_actor_kind_subject_hash_action_id_idempotency_key_hash_key" ON "federation_idempotency_receipts"("issuer_id", "actor_kind", "subject_hash", "action_id", "idempotency_key_hash");
