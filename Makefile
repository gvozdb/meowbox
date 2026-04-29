.PHONY: start stop restart logs logs-api logs-web logs-agent status install build deploy seed \
        migrate migrate-prisma migrate-system migrate-status \
        snapshot rollback update update-check healthcheck

# =============================================================================
# Meowbox Management Commands
# SQLite-only — никаких внешних сервисов (PostgreSQL и Redis выпилены).
# =============================================================================

# --- Install ---
install:
	cd shared && npm install && npm run build
	cd api && npm install && npx prisma generate
	cd agent && npm install && npm run build
	cd web && npm install && npm run build
	cd migrations && npm install && npm run build
	@echo "Meowbox dependencies installed. Run 'make migrate' to apply pending migrations."

# --- Migrations ---
# Применяет pending Prisma + system миграции. Используется в make update и при первом install.
migrate: migrate-prisma migrate-system

migrate-prisma:
	cd api && npx prisma migrate deploy

migrate-system:
	@if [ -f migrations/dist/runner.js ]; then \
		node migrations/dist/runner.js up; \
	else \
		echo "[migrate-system] runner not built — building..."; \
		cd migrations && npm run build; \
		cd .. && node migrations/dist/runner.js up; \
	fi

migrate-status:
	@cd api && npx prisma migrate status || true
	@echo "---"
	@if [ -f migrations/dist/runner.js ]; then node migrations/dist/runner.js status; fi

new-migration:
	@if [ -z "$(SLUG)" ]; then echo "Usage: make new-migration SLUG=my-slug-name"; exit 2; fi
	@bash tools/new-migration.sh "$(SLUG)"

seed:
	cd api && npx ts-node prisma/seed.ts

# --- Build ---
build:
	cd shared && npm run build
	cd api && npm run build
	cd agent && npm run build
	cd web && npm run build
	cd migrations && npm run build

# --- Deploy (build + restart + verify) ---
deploy:
	@echo "▸ Building shared..."
	cd shared && npm run build
	@echo "▸ Building agent..."
	cd agent && npm run build
	@echo "▸ Building API..."
	cd api && npm run build
	@echo "▸ Building web..."
	cd web && npm run build
	@echo "▸ Building migrations runner..."
	cd migrations && npm run build
	@echo "▸ Restarting PM2..."
	@pm2 restart ecosystem.config.js --silent
	@sleep 5
	@$(MAKE) healthcheck

# --- Start/Stop/Restart (PM2) ---
start:
	pm2 start ecosystem.config.js

stop:
	pm2 stop ecosystem.config.js

restart:
	pm2 restart ecosystem.config.js

# --- Logs ---
logs:
	pm2 logs

logs-api:
	pm2 logs meowbox-api

logs-web:
	pm2 logs meowbox-web

logs-agent:
	pm2 logs meowbox-agent

# --- Status ---
status:
	@pm2 status

# --- Snapshot / Rollback / Healthcheck ---
snapshot:
	@bash tools/snapshot.sh

rollback:
	@bash tools/rollback.sh $(MODE) $(NAME)

healthcheck:
	@bash tools/healthcheck.sh

# --- Update (release-based) ---
# make update              — обновить до latest release с GitHub
# make update v=v1.4.2     — обновить до конкретной версии
# make update-check        — только проверить, есть ли новая версия
update:
	@bash tools/update.sh $(v)

update-check:
	@bash tools/update.sh --check
