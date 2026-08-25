-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_remote_manifest_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "remote_server_id" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "revision" TEXT NOT NULL,
    "catalogue_sha256" TEXT,
    "protocol_mode" TEXT NOT NULL DEFAULT 'disabled',
    "protocol_min" INTEGER NOT NULL,
    "protocol_max" INTEGER NOT NULL,
    "accepted_master_range" TEXT NOT NULL,
    "capabilities_json" TEXT NOT NULL,
    "endpoint_state" TEXT NOT NULL DEFAULT 'UNCONFIGURED',
    "endpoints_json" TEXT NOT NULL,
    "signing_kid" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "validation_state" TEXT NOT NULL,
    "generated_at" DATETIME,
    "valid_until" DATETIME NOT NULL,
    "fetched_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "remote_manifest_snapshots_remote_server_id_fkey" FOREIGN KEY ("remote_server_id") REFERENCES "remote_servers" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_remote_manifest_snapshots" ("accepted_master_range", "capabilities_json", "endpoints_json", "fetched_at", "id", "protocol_max", "protocol_min", "remote_server_id", "revision", "schema_version", "signature", "signing_kid", "valid_until", "validation_state") SELECT "accepted_master_range", "capabilities_json", "endpoints_json", "fetched_at", "id", "protocol_max", "protocol_min", "remote_server_id", "revision", "schema_version", "signature", "signing_kid", "valid_until", "validation_state" FROM "remote_manifest_snapshots";
DROP TABLE "remote_manifest_snapshots";
ALTER TABLE "new_remote_manifest_snapshots" RENAME TO "remote_manifest_snapshots";
CREATE INDEX "remote_manifest_snapshots_remote_server_id_fetched_at_idx" ON "remote_manifest_snapshots"("remote_server_id", "fetched_at");
CREATE INDEX "remote_manifest_snapshots_valid_until_idx" ON "remote_manifest_snapshots"("valid_until");
CREATE UNIQUE INDEX "remote_manifest_snapshots_remote_server_id_revision_key" ON "remote_manifest_snapshots"("remote_server_id", "revision");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
