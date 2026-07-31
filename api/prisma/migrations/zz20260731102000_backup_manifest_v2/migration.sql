-- Site backup manifest v2 and restart-safe restore finalization state.
--
-- This migration is intentionally lexically after the domain-centric table
-- copies. Both columns are nullable so existing backups remain restorable via
-- the legacy current-topology path.
ALTER TABLE "backups" ADD COLUMN "manifest" TEXT;
ALTER TABLE "backups" ADD COLUMN "restore_context" TEXT;
