#!/usr/bin/env bash
# =============================================================================
# Dev update — пуллим изменения, пересобираем только то что задело, релоудим PM2.
#
# Запускается на dev-сервере (где лежит .dev-mode), вместо `make update`.
# В отличие от update.sh — НЕ скачивает tarball'ы, НЕ создаёт releases/, работает
# прямо в git workspace.
#
# Usage:
#   bash tools/dev.sh                  # git pull + умная пересборка + reload
#   bash tools/dev.sh --no-pull        # без git pull (только пересборка)
#   bash tools/dev.sh --force          # пересобрать ВСЁ независимо от диффа
#   bash tools/dev.sh --skip-migrate   # без prisma migrate deploy / system migrations
#
# Stages:
#   guard, pull, deps, shared, prisma, migrate, api, agent, web, reload, healthcheck
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANEL_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PANEL_DIR"

# ----- CLI -----
DO_PULL=true
FORCE=false
SKIP_MIGRATE=false
for arg in "$@"; do
  case "$arg" in
    --no-pull)      DO_PULL=false ;;
    --force)        FORCE=true ;;
    --skip-migrate) SKIP_MIGRATE=true ;;
    -h|--help)
      grep -E "^# (Usage|  bash)" "$0" | sed 's/^# //'
      exit 0
      ;;
  esac
done

stage() { echo "[stage:$1] $2"; }
say()   { echo "[dev] $*"; }
err()   { echo "[dev] ✗ $*" >&2; }
abort() { err "$1"; exit 1; }

# ----- Guard: только на dev (с .dev-mode) -----
stage guard "проверка .dev-mode"
[[ -f "$PANEL_DIR/.dev-mode" ]] || abort \
  "Этот скрипт только для dev-серверов (нет $PANEL_DIR/.dev-mode). Для прода используй 'make update'."

# ----- Pull -----
OLD_HEAD="$(git rev-parse HEAD 2>/dev/null || echo none)"
if $DO_PULL; then
  stage pull "git pull --rebase --autostash"
  git fetch origin
  git pull --rebase --autostash
fi
NEW_HEAD="$(git rev-parse HEAD)"

# Список изменившихся файлов между OLD_HEAD и NEW_HEAD (или весь репо если --force)
CHANGED=""
if $FORCE; then
  say "--force: пересобираем всё независимо от диффа"
elif [[ "$OLD_HEAD" != "$NEW_HEAD" && "$OLD_HEAD" != "none" ]]; then
  CHANGED="$(git diff --name-only "$OLD_HEAD" "$NEW_HEAD")"
  say "Изменилось $(echo "$CHANGED" | wc -l) файлов"
else
  say "HEAD не двинулся — проверяю uncommitted/working-tree changes"
  CHANGED="$(git diff --name-only HEAD; git ls-files --others --exclude-standard)"
fi

# Что задето?
touched() { $FORCE && return 0; echo "$CHANGED" | grep -q "^$1" ; }

NEED_DEPS=false
NEED_SHARED=false
NEED_PRISMA=false
NEED_MIGRATE=false
NEED_API=false
NEED_AGENT=false
NEED_WEB=false
NEED_MIGRATIONS_PKG=false

# Изменения в package*.json → переустановить deps
if $FORCE; then
  NEED_DEPS=true
else
  echo "$CHANGED" | grep -qE '(^|/)package(-lock)?\.json$' && NEED_DEPS=true || true
fi

touched "shared/"   && NEED_SHARED=true || true
touched "api/prisma/schema.prisma" && NEED_PRISMA=true || true
touched "api/prisma/migrations/" && NEED_MIGRATE=true || true
touched "migrations/system/" && NEED_MIGRATE=true || true
touched "api/" && NEED_API=true || true
touched "agent/" && NEED_AGENT=true || true
touched "web/" && NEED_WEB=true || true
touched "migrations/" && NEED_MIGRATIONS_PKG=true || true

# Если shared задет — нужно пересобрать всё что от него зависит
if $NEED_SHARED; then
  NEED_API=true
  NEED_AGENT=true
  NEED_WEB=true
  NEED_MIGRATIONS_PKG=true
fi

# First-time setup — нет node_modules?
for pkg in shared api agent web migrations; do
  [[ -d "$PANEL_DIR/$pkg/node_modules" ]] || { NEED_DEPS=true; break; }
done

# ----- Deps -----
if $NEED_DEPS; then
  stage deps "npm ci во всех пакетах"
  if [[ -f "$PANEL_DIR/package.json" ]] && grep -q '"workspaces"' "$PANEL_DIR/package.json"; then
    (cd "$PANEL_DIR" && npm install --no-audit --no-fund) || abort "npm install (workspace) failed"
  else
    for pkg in shared api agent web migrations; do
      (cd "$PANEL_DIR/$pkg" && npm ci --no-audit --no-fund) || abort "npm ci $pkg failed"
    done
    # Линкуем @meowbox/shared, если нет workspace'а — npm ci его не добавит
    for pkg in api agent web migrations; do
      mkdir -p "$PANEL_DIR/$pkg/node_modules/@meowbox"
      ln -sfn "$PANEL_DIR/shared" "$PANEL_DIR/$pkg/node_modules/@meowbox/shared"
    done
  fi
fi

# ----- Shared build (нужно ДО api/agent/migrations build) -----
if $NEED_SHARED || $FORCE; then
  stage shared "tsc shared/"
  (cd "$PANEL_DIR/shared" && npx tsc) || abort "shared build failed"
fi

# ----- Prisma generate -----
if $NEED_PRISMA || $FORCE; then
  stage prisma "prisma generate"
  (cd "$PANEL_DIR/api" && npx prisma generate) || abort "prisma generate failed"
fi

# ----- Prisma + system migrations -----
if ! $SKIP_MIGRATE && ($NEED_MIGRATE || $FORCE); then
  stage migrate "prisma migrate deploy"
  (cd "$PANEL_DIR/api" && npx prisma migrate deploy) || abort "prisma migrate deploy failed"
  if [[ -d "$PANEL_DIR/migrations/system" ]]; then
    stage migrate "system migrations"
    (cd "$PANEL_DIR/migrations" && npx tsc && node dist/runner.js) \
      || say "⚠ system migrations упали — проверь логи"
  fi
fi

# ----- Builds -----
if $NEED_API || $FORCE; then
  stage api "tsc api/"
  (cd "$PANEL_DIR/api" && npx tsc -p tsconfig.build.json --incremental false) \
    || abort "api build failed"
fi

if $NEED_AGENT || $FORCE; then
  stage agent "tsc agent/"
  (cd "$PANEL_DIR/agent" && npx tsc) || abort "agent build failed"
fi

if $NEED_WEB || $FORCE; then
  stage web "nuxt build"
  (cd "$PANEL_DIR/web" && npx nuxt build) || abort "web build failed"
fi

# ----- PM2 reload -----
stage reload "pm2 reload all"
pm2 reload "$PANEL_DIR/ecosystem.config.js" --update-env >/dev/null \
  || pm2 start "$PANEL_DIR/ecosystem.config.js"
pm2 save >/dev/null 2>&1 || true

# ----- Healthcheck -----
stage healthcheck "проверка панели"
sleep 3
API_PORT="$(grep -E '^API_PORT=' "$PANEL_DIR/state/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' || echo 11860)"
if curl -fsS -o /dev/null "http://127.0.0.1:${API_PORT}/api/health" 2>/dev/null \
   || [[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${API_PORT}/api/health")" =~ ^(200|401)$ ]]; then
  say "✓ API отвечает"
else
  err "API не отвечает на http://127.0.0.1:${API_PORT}/api/health — проверь pm2 logs"
  exit 2
fi

say "✓ Dev update OK ($OLD_HEAD → $NEW_HEAD)"
