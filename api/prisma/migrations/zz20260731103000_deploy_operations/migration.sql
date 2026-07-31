-- Durable deploy/rollback operation linkage. Existing logs remain readable.
ALTER TABLE "deploy_logs" ADD COLUMN "operation_id" TEXT
  REFERENCES "operations" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "deploy_logs_operation_id_key"
  ON "deploy_logs"("operation_id");
