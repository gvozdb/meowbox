-- CreateTable
CREATE TABLE "federated_principals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "issuer_id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "principal_version" INTEGER NOT NULL DEFAULT 1,
    "display_label" TEXT,
    "tombstoned_at" DATETIME,
    "last_seen_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "federated_principals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "federated_principals_issuer_id_fkey" FOREIGN KEY ("issuer_id") REFERENCES "federation_issuers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "service_principals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "issuer_id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "purpose_namespace" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "principal_version" INTEGER NOT NULL DEFAULT 1,
    "permissions_json" TEXT NOT NULL DEFAULT '[]',
    "deactivated_at" DATETIME,
    "last_seen_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "service_principals_issuer_id_fkey" FOREIGN KEY ("issuer_id") REFERENCES "federation_issuers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "identity_kind" TEXT NOT NULL DEFAULT 'LOCAL',
    "role" TEXT NOT NULL DEFAULT 'ADMIN',
    "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "totp_secret" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_users" ("created_at", "email", "id", "password_hash", "role", "totp_enabled", "totp_secret", "updated_at", "username") SELECT "created_at", "email", "id", "password_hash", "role", "totp_enabled", "totp_secret", "updated_at", "username" FROM "users";
DROP TABLE "users";
ALTER TABLE "new_users" RENAME TO "users";
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE INDEX "users_identity_kind_idx" ON "users"("identity_kind");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "federated_principals_user_id_key" ON "federated_principals"("user_id");

-- CreateIndex
CREATE INDEX "federated_principals_issuer_id_tombstoned_at_idx" ON "federated_principals"("issuer_id", "tombstoned_at");

-- CreateIndex
CREATE INDEX "federated_principals_last_seen_at_idx" ON "federated_principals"("last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "federated_principals_issuer_id_subject_key" ON "federated_principals"("issuer_id", "subject");

-- CreateIndex
CREATE INDEX "service_principals_issuer_id_state_idx" ON "service_principals"("issuer_id", "state");

-- CreateIndex
CREATE INDEX "service_principals_purpose_namespace_state_idx" ON "service_principals"("purpose_namespace", "state");

-- CreateIndex
CREATE UNIQUE INDEX "service_principals_issuer_id_subject_key" ON "service_principals"("issuer_id", "subject");
