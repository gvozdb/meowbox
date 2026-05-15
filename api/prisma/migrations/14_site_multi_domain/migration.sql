-- Multi-domain sites: новая таблица site_domains (основные домены сайта) +
-- repoint ssl_certificates на конкретный основной домен (domain_id).
--
-- ssl_certificates.site_id перестаёт быть UNIQUE (у сайта теперь несколько
-- сертификатов — по одному на основной домен) и добавляется nullable
-- domain_id (1:1 с site_domains). Backfill существующих данных делает
-- системная миграция 2026-05-15-*-site-domains-backfill.

-- CreateTable
CREATE TABLE "site_domains" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "site_id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "aliases" TEXT NOT NULL DEFAULT '[]',
    "files_rel_path" TEXT,
    "app_port" INTEGER,
    "https_redirect" BOOLEAN NOT NULL DEFAULT true,
    "nginx_client_max_body_size" TEXT,
    "nginx_fastcgi_read_timeout" INTEGER,
    "nginx_fastcgi_send_timeout" INTEGER,
    "nginx_fastcgi_connect_timeout" INTEGER,
    "nginx_fastcgi_buffer_size_kb" INTEGER,
    "nginx_fastcgi_buffer_count" INTEGER,
    "nginx_http2" BOOLEAN NOT NULL DEFAULT true,
    "nginx_hsts" BOOLEAN NOT NULL DEFAULT false,
    "nginx_gzip" BOOLEAN NOT NULL DEFAULT true,
    "nginx_rate_limit_enabled" BOOLEAN NOT NULL DEFAULT true,
    "nginx_rate_limit_rps" INTEGER,
    "nginx_rate_limit_burst" INTEGER,
    "nginx_custom_config" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "site_domains_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables (ssl_certificates: site_id больше не UNIQUE, добавлен domain_id + FK)
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ssl_certificates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "site_id" TEXT NOT NULL,
    "domain_id" TEXT,
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
    CONSTRAINT "ssl_certificates_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ssl_certificates_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "site_domains" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ssl_certificates" ("cert_path", "created_at", "days_remaining", "domains", "expires_at", "id", "is_wildcard", "issued_at", "issuer", "key_path", "site_id", "status", "updated_at") SELECT "cert_path", "created_at", "days_remaining", "domains", "expires_at", "id", "is_wildcard", "issued_at", "issuer", "key_path", "site_id", "status", "updated_at" FROM "ssl_certificates";
DROP TABLE "ssl_certificates";
ALTER TABLE "new_ssl_certificates" RENAME TO "ssl_certificates";
CREATE UNIQUE INDEX "ssl_certificates_domain_id_key" ON "ssl_certificates"("domain_id");
CREATE INDEX "ssl_certificates_site_id_idx" ON "ssl_certificates"("site_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "site_domains_domain_key" ON "site_domains"("domain");

-- CreateIndex
CREATE INDEX "site_domains_site_id_idx" ON "site_domains"("site_id");
