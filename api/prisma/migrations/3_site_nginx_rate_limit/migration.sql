-- Per-site nginx rate limiting (limit_req_zone + limit_req).
-- См. agent/src/nginx/templates.ts (chunk50Security) и nginx.manager.ts (writeGlobalZones).

ALTER TABLE "sites" ADD COLUMN "nginx_rate_limit_enabled" BOOLEAN NOT NULL DEFAULT 1;
ALTER TABLE "sites" ADD COLUMN "nginx_rate_limit_rps" INTEGER;
ALTER TABLE "sites" ADD COLUMN "nginx_rate_limit_burst" INTEGER;
