.PHONY: start stop restart logs logs-api logs-web logs-agent status install build deploy seed \
        migrate migrate-prisma migrate-system migrate-status new-migration link-shared \
        snapshot rollback update update-check healthcheck ip-allow ip-allow-list ip-allow-clear

# =============================================================================
# Meowbox Management Commands
# SQLite-only — никаких внешних сервисов (PostgreSQL и Redis выпилены).
# =============================================================================

# --- Symlinks (внутренний пакет @meowbox/shared не объявлен в dependencies) ---
# tsc и runtime ищут его в node_modules/@meowbox/shared, поэтому линкуем вручную.
# Идемпотентно: ln -sfn перезаписывает старые ссылки.
link-shared:
	@for pkg in api agent web migrations; do \
		mkdir -p $$pkg/node_modules/@meowbox; \
		ln -sfn ../../../shared $$pkg/node_modules/@meowbox/shared; \
	done
	@mkdir -p migrations/node_modules/@prisma
	@if [ -d api/node_modules/@prisma/client ]; then \
		ln -sfn ../../../api/node_modules/@prisma/client migrations/node_modules/@prisma/client; \
	fi

# --- Install (для dev / первой настройки) ---
install:
	cd shared && npm install
	cd api && npm install && npx prisma generate
	cd agent && npm install
	cd web && npm install
	cd migrations && npm install
	@$(MAKE) link-shared
	@$(MAKE) build
	@echo "Meowbox installed. Run 'make migrate' to apply pending migrations."

# --- Migrations ---
# Применяет pending Prisma + system миграции. Используется в make deploy и при первом install.
migrate: migrate-prisma migrate-system

migrate-prisma:
	cd api && npx prisma migrate deploy

migrate-system:
	@if [ ! -f migrations/dist/runner.js ]; then \
		echo "[migrate-system] runner not built — building..."; \
		cd migrations && npm run build; \
	fi
	@node migrations/dist/runner.js up

migrate-status:
	@cd api && npx prisma migrate status || true
	@echo "---"
	@if [ -f migrations/dist/runner.js ]; then node migrations/dist/runner.js status; fi

new-migration:
	@if [ -z "$(SLUG)" ]; then echo "Usage: make new-migration SLUG=my-slug-name"; exit 2; fi
	@bash tools/new-migration.sh "$(SLUG)"

seed:
	cd api && npx ts-node prisma/seed.ts

# --- Build (все пакеты) ---
# link-shared первым шагом, чтобы tsc нашёл @meowbox/shared.
build: link-shared
	@echo "▸ Building shared..."
	@cd shared && npm run build
	@echo "▸ Building agent..."
	@cd agent && npm run build
	@echo "▸ Building API..."
	@cd api && npm run build
	@echo "▸ Building web..."
	@cd web && npm run build
	@echo "▸ Building migrations runner..."
	@cd migrations && npm run build

# --- Deploy (build + migrate + restart + verify) ---
# Главная команда после правок кода / схемы. Применяет всё за один заход.
deploy: build migrate
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

# --- IP allowlist (быстрый escape-hatch из терминала) ---------------------
# Используй когда страшно пилить с UI или когда заперся снаружи allowlist'а
# и зашёл по SSH. Все изменения сразу подхватываются API через `reload`,
# рестарт не требуется.
#
#   make ip-allow IP=1.2.3.4 LABEL=home   # добавить запись + включить allowlist
#   make ip-allow IP=10.0.0.0/24          # добавить целую подсеть
#   make ip-allow-list                    # посмотреть текущий список
#   make ip-allow-clear                   # ВЫРУБИТЬ allowlist (открыть всё)
ip-allow:
	@if [ -z "$(IP)" ]; then echo "Usage: make ip-allow IP=1.2.3.4[/cidr] [LABEL=home]"; exit 2; fi
	@bash tools/ip-allowlist.sh add "$(IP)" "$(LABEL)"

ip-allow-list:
	@bash tools/ip-allowlist.sh list

ip-allow-clear:
	@bash tools/ip-allowlist.sh clear
