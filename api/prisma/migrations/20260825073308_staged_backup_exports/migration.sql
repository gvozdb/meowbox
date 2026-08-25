-- Additive columns avoid rebuilding a potentially large production table.
-- Bindings are fail-closed in BackupExportsService and protected by unique
-- indexes; old-compatible releases ignore both nullable columns.
ALTER TABLE "backup_exports" ADD COLUMN "operation_id" TEXT;
ALTER TABLE "backup_exports" ADD COLUMN "artifact_id" TEXT;
CREATE UNIQUE INDEX "backup_exports_operation_id_key" ON "backup_exports"("operation_id");
CREATE UNIQUE INDEX "backup_exports_artifact_id_key" ON "backup_exports"("artifact_id");
CREATE INDEX "backup_exports_mode_status_created_at_idx" ON "backup_exports"("mode", "status", "created_at");
