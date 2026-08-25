-- CreateTable
CREATE TABLE "adminer_handoffs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "target_installation_id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "resource_kind" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "payload_enc" TEXT NOT NULL,
    "actor_kind" TEXT NOT NULL,
    "actor_subject_hash" TEXT NOT NULL,
    "actor_role" TEXT NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "consumed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "adminer_handoffs_secret_hash_key" ON "adminer_handoffs"("secret_hash");

-- CreateIndex
CREATE INDEX "adminer_handoffs_expires_at_consumed_at_idx" ON "adminer_handoffs"("expires_at", "consumed_at");

-- CreateIndex
CREATE INDEX "adminer_handoffs_target_installation_id_created_at_idx" ON "adminer_handoffs"("target_installation_id", "created_at");

-- CreateIndex
CREATE INDEX "adminer_handoffs_actor_subject_hash_created_at_idx" ON "adminer_handoffs"("actor_subject_hash", "created_at");
