-- ProxyAuditLog: журнал проксирующих запросов (master→slave) и (slave← master).
-- userId/serverId опциональные (slave-side не знает чей сервер инициировал).
CREATE TABLE "proxy_audit_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "direction" TEXT NOT NULL,
    "user_id" TEXT,
    "server_id" TEXT,
    "server_name" TEXT,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status_code" INTEGER,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "ip_address" TEXT NOT NULL,
    "user_agent" TEXT,
    "error_msg" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "proxy_audit_logs_direction_idx" ON "proxy_audit_logs"("direction");
CREATE INDEX "proxy_audit_logs_server_id_idx" ON "proxy_audit_logs"("server_id");
CREATE INDEX "proxy_audit_logs_user_id_idx" ON "proxy_audit_logs"("user_id");
CREATE INDEX "proxy_audit_logs_created_at_idx" ON "proxy_audit_logs"("created_at");
