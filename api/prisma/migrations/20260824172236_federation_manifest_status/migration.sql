-- AlterTable
ALTER TABLE "remote_servers" ADD COLUMN "browser_checked_at" DATETIME;
ALTER TABLE "remote_servers" ADD COLUMN "browser_fresh_until" DATETIME;
ALTER TABLE "remote_servers" ADD COLUMN "browser_reason_code" TEXT;
ALTER TABLE "remote_servers" ADD COLUMN "capability_reason_code" TEXT;
ALTER TABLE "remote_servers" ADD COLUMN "target_manifest_kid" TEXT;
ALTER TABLE "remote_servers" ADD COLUMN "target_manifest_pinned_at" DATETIME;
ALTER TABLE "remote_servers" ADD COLUMN "target_manifest_public_key_spki" TEXT;
ALTER TABLE "remote_servers" ADD COLUMN "transport_fresh_until" DATETIME;
ALTER TABLE "remote_servers" ADD COLUMN "transport_reason_code" TEXT;
ALTER TABLE "remote_servers" ADD COLUMN "trust_checked_at" DATETIME;
ALTER TABLE "remote_servers" ADD COLUMN "trust_fresh_until" DATETIME;
ALTER TABLE "remote_servers" ADD COLUMN "trust_reason_code" TEXT;
