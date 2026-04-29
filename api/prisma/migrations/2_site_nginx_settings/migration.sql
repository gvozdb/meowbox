-- Layered nginx settings — параметризуют шаблоны в /etc/nginx/meowbox/{siteName}/*.conf.
-- См. agent/src/nginx/templates.ts и agent/src/nginx/nginx.manager.ts.

ALTER TABLE "sites" ADD COLUMN "nginx_client_max_body_size" TEXT;
ALTER TABLE "sites" ADD COLUMN "nginx_fastcgi_read_timeout" INTEGER;
ALTER TABLE "sites" ADD COLUMN "nginx_fastcgi_send_timeout" INTEGER;
ALTER TABLE "sites" ADD COLUMN "nginx_fastcgi_connect_timeout" INTEGER;
ALTER TABLE "sites" ADD COLUMN "nginx_fastcgi_buffer_size_kb" INTEGER;
ALTER TABLE "sites" ADD COLUMN "nginx_fastcgi_buffer_count" INTEGER;
ALTER TABLE "sites" ADD COLUMN "nginx_http2" BOOLEAN NOT NULL DEFAULT 1;
ALTER TABLE "sites" ADD COLUMN "nginx_hsts" BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE "sites" ADD COLUMN "nginx_gzip" BOOLEAN NOT NULL DEFAULT 1;
ALTER TABLE "sites" ADD COLUMN "nginx_custom_config" TEXT;
