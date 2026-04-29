-- CreateTable
CREATE TABLE "_BackupConfigToStorageLocation" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    FOREIGN KEY ("B") REFERENCES "storage_locations" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY ("A") REFERENCES "backup_configs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ai_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "claude_session_id" TEXT NOT NULL,
    "title" TEXT,
    "cwd" TEXT NOT NULL DEFAULT '/',
    "messages" TEXT NOT NULL DEFAULT '[]',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT,
    "details" TEXT,
    "ip_address" TEXT NOT NULL,
    "user_agent" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "backup_configs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "site_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "engine" TEXT NOT NULL DEFAULT 'TAR',
    "storage_location_ids" TEXT NOT NULL DEFAULT '[]',
    "storage_type" TEXT,
    "storage_config" TEXT,
    "schedule" TEXT,
    "retention" INTEGER NOT NULL DEFAULT 7,
    "keep_daily" INTEGER NOT NULL DEFAULT 7,
    "keep_weekly" INTEGER NOT NULL DEFAULT 4,
    "keep_monthly" INTEGER NOT NULL DEFAULT 6,
    "keep_yearly" INTEGER NOT NULL DEFAULT 1,
    "exclude_paths" TEXT NOT NULL DEFAULT '[]',
    "exclude_table_data" TEXT NOT NULL DEFAULT '[]',
    "keep_local_copy" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    FOREIGN KEY ("site_id") REFERENCES "sites" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "backup_exports" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "backup_id" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'STREAM',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "s3_key" TEXT,
    "download_url" TEXT,
    "expires_at" DATETIME NOT NULL,
    "size_bytes" BIGINT,
    "error_message" TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    FOREIGN KEY ("created_by_user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY ("backup_id") REFERENCES "backups" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "backups" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "site_id" TEXT NOT NULL,
    "config_id" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "engine" TEXT NOT NULL DEFAULT 'TAR',
    "storage_location_id" TEXT,
    "restic_snapshot_id" TEXT,
    "storage_type" TEXT,
    "file_path" TEXT NOT NULL DEFAULT '',
    "size_bytes" BIGINT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "started_at" DATETIME,
    "completed_at" DATETIME,
    "base_backup_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("base_backup_id") REFERENCES "backups" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    FOREIGN KEY ("storage_location_id") REFERENCES "storage_locations" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    FOREIGN KEY ("config_id") REFERENCES "backup_configs" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    FOREIGN KEY ("site_id") REFERENCES "sites" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "basic_auth_config" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT '_',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "username" TEXT NOT NULL DEFAULT '',
    "password_hash" TEXT NOT NULL DEFAULT '',
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "cron_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "site_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "last_output" TEXT,
    "last_run_at" DATETIME,
    "last_exit_code" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    FOREIGN KEY ("site_id") REFERENCES "sites" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "databases" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "db_user" TEXT NOT NULL,
    "db_password_hash" TEXT NOT NULL,
    "site_id" TEXT,
    "size_bytes" BIGINT NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "db_password_enc" TEXT,
    FOREIGN KEY ("site_id") REFERENCES "sites" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "deploy_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "site_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "commit_sha" TEXT,
    "commit_message" TEXT,
    "branch" TEXT NOT NULL,
    "output" TEXT NOT NULL DEFAULT '',
    "triggered_by" TEXT,
    "duration_ms" INTEGER,
    "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("site_id") REFERENCES "sites" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "dns_provider_accounts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "credentials_enc" TEXT NOT NULL,
    "scope_id" TEXT,
    "api_base_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "last_error" TEXT,
    "last_sync_at" DATETIME,
    "zones_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "dns_records" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "zone_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "ttl" INTEGER NOT NULL,
    "priority" INTEGER,
    "proxied" BOOLEAN,
    "comment" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    FOREIGN KEY ("zone_id") REFERENCES "dns_zones" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "dns_zones" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "account_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "nameservers" TEXT,
    "records_count" INTEGER NOT NULL DEFAULT 0,
    "records_cached_at" DATETIME,
    "linked_site_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    FOREIGN KEY ("linked_site_id") REFERENCES "sites" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    FOREIGN KEY ("account_id") REFERENCES "dns_provider_accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "firewall_rules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "action" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "port" TEXT,
    "source_ip" TEXT,
    "comment" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "health_check_pings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "site_id" TEXT NOT NULL,
    "reachable" BOOLEAN NOT NULL,
    "status_code" INTEGER,
    "response_time_ms" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("site_id") REFERENCES "sites" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "login_attempts" (
    "ip" TEXT NOT NULL PRIMARY KEY,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" DATETIME NOT NULL,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "metrics_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cpu_percent" REAL NOT NULL,
    "memory_percent" REAL NOT NULL,
    "memory_used" BIGINT NOT NULL,
    "memory_total" BIGINT NOT NULL,
    "disk_percent" REAL NOT NULL,
    "disk_used" BIGINT NOT NULL,
    "disk_total" BIGINT NOT NULL,
    "network_rx" BIGINT NOT NULL,
    "network_tx" BIGINT NOT NULL
);

-- CreateTable
CREATE TABLE "notification_settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "events" TEXT NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" TEXT NOT NULL DEFAULT '{}',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "panel_settings" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "restic_checks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storage_location_id" TEXT NOT NULL,
    "site_name" TEXT NOT NULL,
    "site_id" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "error_message" TEXT,
    "output" TEXT,
    "read_data" BOOLEAN NOT NULL DEFAULT false,
    "read_data_subset" TEXT,
    "duration_ms" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" DATETIME,
    FOREIGN KEY ("storage_location_id") REFERENCES "storage_locations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "server_services" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "service_key" TEXT NOT NULL,
    "installed" BOOLEAN NOT NULL DEFAULT false,
    "version" TEXT,
    "installed_at" DATETIME,
    "last_error" TEXT,
    "config" TEXT NOT NULL DEFAULT '{}',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "sessions" (
    "jti" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "user_agent" TEXT,
    "expires_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "site_disk_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "site_id" TEXT NOT NULL,
    "www_bytes" BIGINT NOT NULL DEFAULT 0,
    "logs_bytes" BIGINT NOT NULL DEFAULT 0,
    "tmp_bytes" BIGINT NOT NULL DEFAULT 0,
    "db_bytes" BIGINT NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("site_id") REFERENCES "sites" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "site_services" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "site_id" TEXT NOT NULL,
    "service_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'STOPPED',
    "config" TEXT NOT NULL DEFAULT '{}',
    "last_error" TEXT,
    "installed_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    FOREIGN KEY ("site_id") REFERENCES "sites" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "sites" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "aliases" TEXT NOT NULL DEFAULT '[]',
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'STOPPED',
    "php_version" TEXT,
    "git_repository" TEXT,
    "deploy_branch" TEXT,
    "app_port" INTEGER,
    "env_vars" TEXT NOT NULL DEFAULT '{}',
    "root_path" TEXT NOT NULL,
    "nginx_config_path" TEXT NOT NULL,
    "site_user" TEXT,
    "ssh_password" TEXT,
    "cms_admin_user" TEXT,
    "cms_admin_password" TEXT,
    "manager_path" TEXT,
    "connectors_path" TEXT,
    "db_enabled" BOOLEAN NOT NULL DEFAULT false,
    "https_redirect" BOOLEAN NOT NULL DEFAULT true,
    "files_rel_path" TEXT NOT NULL DEFAULT 'www',
    "user_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "modx_version" TEXT,
    "display_name" TEXT,
    "error_message" TEXT,
    "php_pool_custom" TEXT,
    "backup_excludes" TEXT,
    "backup_exclude_tables" TEXT,
    FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ssl_certificates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "site_id" TEXT NOT NULL,
    "domains" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'NONE',
    "issuer" TEXT NOT NULL DEFAULT '',
    "is_wildcard" BOOLEAN NOT NULL DEFAULT false,
    "issued_at" DATETIME,
    "expires_at" DATETIME,
    "days_remaining" INTEGER,
    "cert_path" TEXT,
    "key_path" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    FOREIGN KEY ("site_id") REFERENCES "sites" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "storage_locations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" TEXT NOT NULL DEFAULT '{}',
    "restic_password" TEXT,
    "restic_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "token_blacklist" (
    "jti" TEXT NOT NULL PRIMARY KEY,
    "expires_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'ADMIN',
    "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "totp_secret" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "_BackupConfigToStorageLocation_B_index" ON "_BackupConfigToStorageLocation"("B" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "_BackupConfigToStorageLocation_AB_unique" ON "_BackupConfigToStorageLocation"("A" ASC, "B" ASC);

-- CreateIndex
CREATE INDEX "ai_sessions_user_id_updated_at_idx" ON "ai_sessions"("user_id" ASC, "updated_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "ai_sessions_claude_session_id_key" ON "ai_sessions"("claude_session_id" ASC);

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at" ASC);

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action" ASC);

-- CreateIndex
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs"("user_id" ASC);

-- CreateIndex
CREATE INDEX "backup_configs_site_id_idx" ON "backup_configs"("site_id" ASC);

-- CreateIndex
CREATE INDEX "backup_exports_expires_at_idx" ON "backup_exports"("expires_at" ASC);

-- CreateIndex
CREATE INDEX "backup_exports_status_idx" ON "backup_exports"("status" ASC);

-- CreateIndex
CREATE INDEX "backup_exports_backup_id_idx" ON "backup_exports"("backup_id" ASC);

-- CreateIndex
CREATE INDEX "backups_status_idx" ON "backups"("status" ASC);

-- CreateIndex
CREATE INDEX "backups_site_id_idx" ON "backups"("site_id" ASC);

-- CreateIndex
CREATE INDEX "cron_jobs_site_id_idx" ON "cron_jobs"("site_id" ASC);

-- CreateIndex
CREATE INDEX "databases_site_id_idx" ON "databases"("site_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "databases_name_key" ON "databases"("name" ASC);

-- CreateIndex
CREATE INDEX "deploy_logs_status_idx" ON "deploy_logs"("status" ASC);

-- CreateIndex
CREATE INDEX "deploy_logs_site_id_idx" ON "deploy_logs"("site_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "dns_records_zone_id_external_id_key" ON "dns_records"("zone_id" ASC, "external_id" ASC);

-- CreateIndex
CREATE INDEX "dns_records_zone_id_type_name_idx" ON "dns_records"("zone_id" ASC, "type" ASC, "name" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "dns_zones_account_id_external_id_key" ON "dns_zones"("account_id" ASC, "external_id" ASC);

-- CreateIndex
CREATE INDEX "dns_zones_domain_idx" ON "dns_zones"("domain" ASC);

-- CreateIndex
CREATE INDEX "health_check_pings_site_id_created_at_idx" ON "health_check_pings"("site_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "login_attempts_expires_at_idx" ON "login_attempts"("expires_at" ASC);

-- CreateIndex
CREATE INDEX "metrics_snapshots_timestamp_idx" ON "metrics_snapshots"("timestamp" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "notification_settings_user_id_channel_key" ON "notification_settings"("user_id" ASC, "channel" ASC);

-- CreateIndex
CREATE INDEX "restic_checks_started_at_idx" ON "restic_checks"("started_at" ASC);

-- CreateIndex
CREATE INDEX "restic_checks_storage_location_id_site_name_idx" ON "restic_checks"("storage_location_id" ASC, "site_name" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "server_services_service_key_key" ON "server_services"("service_key" ASC);

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at" ASC);

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id" ASC);

-- CreateIndex
CREATE INDEX "site_disk_snapshots_site_id_created_at_idx" ON "site_disk_snapshots"("site_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "site_services_site_id_service_key_key" ON "site_services"("site_id" ASC, "service_key" ASC);

-- CreateIndex
CREATE INDEX "site_services_service_key_idx" ON "site_services"("service_key" ASC);

-- CreateIndex
CREATE INDEX "site_services_site_id_idx" ON "site_services"("site_id" ASC);

-- CreateIndex
CREATE INDEX "sites_type_idx" ON "sites"("type" ASC);

-- CreateIndex
CREATE INDEX "sites_status_idx" ON "sites"("status" ASC);

-- CreateIndex
CREATE INDEX "sites_user_id_idx" ON "sites"("user_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "sites_domain_key" ON "sites"("domain" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "sites_name_key" ON "sites"("name" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "ssl_certificates_site_id_key" ON "ssl_certificates"("site_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "storage_locations_name_key" ON "storage_locations"("name" ASC);

-- CreateIndex
CREATE INDEX "token_blacklist_expires_at_idx" ON "token_blacklist"("expires_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username" ASC);

