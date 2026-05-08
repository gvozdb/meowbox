-- CreateTable
CREATE TABLE "vpn_services" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT,
    "protocol" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DEPLOYING',
    "error_message" TEXT,
    "config_blob" TEXT NOT NULL,
    "sni_mask" TEXT,
    "sni_last_check_ok" BOOLEAN,
    "sni_last_checked_at" DATETIME,
    "sni_last_error" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "vpn_users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "sub_token" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "vpn_user_creds" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "creds_blob" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "vpn_user_creds_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "vpn_users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "vpn_user_creds_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "vpn_services" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "vpn_services_protocol_idx" ON "vpn_services"("protocol");

-- CreateIndex
CREATE UNIQUE INDEX "vpn_services_protocol_port_key" ON "vpn_services"("protocol", "port");

-- CreateIndex
CREATE UNIQUE INDEX "vpn_users_name_key" ON "vpn_users"("name");

-- CreateIndex
CREATE UNIQUE INDEX "vpn_users_sub_token_key" ON "vpn_users"("sub_token");

-- CreateIndex
CREATE INDEX "vpn_user_creds_user_id_idx" ON "vpn_user_creds"("user_id");

-- CreateIndex
CREATE INDEX "vpn_user_creds_service_id_idx" ON "vpn_user_creds"("service_id");

-- CreateIndex
CREATE UNIQUE INDEX "vpn_user_creds_user_id_service_id_key" ON "vpn_user_creds"("user_id", "service_id");
