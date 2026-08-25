-- CreateTable
CREATE TABLE "agent_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "operation_id" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "action_id" TEXT NOT NULL,
    "protocol_version" INTEGER NOT NULL DEFAULT 1,
    "state" TEXT NOT NULL DEFAULT 'STARTING',
    "request_hash" TEXT NOT NULL,
    "agent_boot_id" TEXT,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "current_step" TEXT,
    "cancel_safe" BOOLEAN NOT NULL DEFAULT false,
    "cancel_requested_at" DATETIME,
    "cancel_outcome" TEXT,
    "result" TEXT,
    "error_message" TEXT,
    "started_at" DATETIME,
    "heartbeat_at" DATETIME,
    "completed_at" DATETIME,
    "deadline_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "agent_jobs_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "operations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "agent_jobs_operation_id_state_idx" ON "agent_jobs"("operation_id", "state");

-- CreateIndex
CREATE INDEX "agent_jobs_agent_boot_id_state_idx" ON "agent_jobs"("agent_boot_id", "state");

-- CreateIndex
CREATE INDEX "agent_jobs_state_heartbeat_at_idx" ON "agent_jobs"("state", "heartbeat_at");

-- CreateIndex
CREATE INDEX "agent_jobs_deadline_at_idx" ON "agent_jobs"("deadline_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_jobs_operation_id_step_key" ON "agent_jobs"("operation_id", "step");
