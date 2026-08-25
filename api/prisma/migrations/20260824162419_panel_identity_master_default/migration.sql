-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_panel_identities" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT '_',
    "installation_id" TEXT NOT NULL,
    "installation_role" TEXT NOT NULL DEFAULT 'MASTER',
    "manifest_kid" TEXT,
    "manifest_public_key_spki" TEXT,
    "manifest_private_key_enc" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_panel_identities" ("created_at", "id", "installation_id", "installation_role", "manifest_kid", "manifest_private_key_enc", "manifest_public_key_spki", "updated_at") SELECT "created_at", "id", "installation_id", "installation_role", "manifest_kid", "manifest_private_key_enc", "manifest_public_key_spki", "updated_at" FROM "panel_identities";
DROP TABLE "panel_identities";
ALTER TABLE "new_panel_identities" RENAME TO "panel_identities";
CREATE UNIQUE INDEX "panel_identities_installation_id_key" ON "panel_identities"("installation_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
