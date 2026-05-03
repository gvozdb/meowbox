-- CreateTable
CREATE TABLE "hostpanel_migration_sources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "ssh_user" TEXT NOT NULL,
    "ssh_pass_enc" TEXT NOT NULL,
    "mysql_host" TEXT NOT NULL,
    "mysql_port" INTEGER NOT NULL DEFAULT 3306,
    "mysql_user" TEXT NOT NULL,
    "mysql_pass_enc" TEXT NOT NULL,
    "hostpanel_db" TEXT NOT NULL,
    "hostpanel_table_prefix" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "last_used_at" DATETIME,
    "created_by" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "hostpanel_migration_sources_host_ssh_user_mysql_user_key" ON "hostpanel_migration_sources"("host", "ssh_user", "mysql_user");

-- CreateIndex
CREATE INDEX "hostpanel_migration_sources_last_used_at_idx" ON "hostpanel_migration_sources"("last_used_at");
