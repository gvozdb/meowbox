-- AlterTable
ALTER TABLE "proxy_audit_logs" ADD COLUMN "action_id" TEXT;
ALTER TABLE "proxy_audit_logs" ADD COLUMN "actor_kind" TEXT;
ALTER TABLE "proxy_audit_logs" ADD COLUMN "browser_ip" TEXT;
ALTER TABLE "proxy_audit_logs" ADD COLUMN "issuer_installation_id" TEXT;
ALTER TABLE "proxy_audit_logs" ADD COLUMN "key_id" TEXT;
ALTER TABLE "proxy_audit_logs" ADD COLUMN "operation_id" TEXT;
ALTER TABLE "proxy_audit_logs" ADD COLUMN "peer_ip" TEXT;
ALTER TABLE "proxy_audit_logs" ADD COLUMN "request_id" TEXT;
ALTER TABLE "proxy_audit_logs" ADD COLUMN "target_installation_id" TEXT;
ALTER TABLE "proxy_audit_logs" ADD COLUMN "target_principal_id" TEXT;

-- CreateIndex
CREATE INDEX "proxy_audit_logs_request_id_direction_idx" ON "proxy_audit_logs"("request_id", "direction");

-- CreateIndex
CREATE INDEX "proxy_audit_logs_action_id_created_at_idx" ON "proxy_audit_logs"("action_id", "created_at");
