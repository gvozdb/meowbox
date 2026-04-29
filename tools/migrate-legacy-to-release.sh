#!/usr/bin/env bash
# =============================================================================
# Migration: legacy → release layout (одноразовый, идемпотентный)
#
# Запускается автоматически из tools/update.sh при детекте legacy-раскладки
# (нет current/ симлинка, но есть api/ и web/ в корне MEOWBOX_DIR).
#
# Что делает:
#   1. Создаёт state/{data,logs,backups,snapshots} (если нет).
#   2. Перемещает БД: data/  → state/data/  (если ещё в корне).
#   3. Перемещает .env: .env → state/.env  (если ещё в корне).
#   4. Перемещает logs/: logs/ → state/logs/ (если есть).
#   5. Перемещает Adminer: tools/adminer → state/adminer (стабильный путь).
#   6. Создаёт начальный релиз из текущего checkout'а:
#        cp -a {api,agent,web,shared,migrations,tools,Makefile,ecosystem.config.js,VERSION}
#        → releases/<VERSION>/
#   7. Симлинки persistent: release/.env → state/.env, release/data → state/data
#   8. Симлинк current → releases/<VERSION>
#   9. Корневые симлинки: ecosystem.config.js, Makefile, tools, VERSION → current/...
#  10. Чистит legacy-каталоги в корне (api/, agent/, web/, shared/, migrations/).
#  11. pm2 reload ecosystem.config.js (через симлинк → current/...).
#  12. Обновляет DATABASE_URL в state/.env (file:../../state/data/meowbox.db).
#
# Идемпотентность: проверяет каждый шаг через `if [[ -e ... ]]`, безопасно к
# повторному запуску после падения.
# =============================================================================
set -euo pipefail

PANEL_DIR="${MEOWBOX_DIR:-/opt/meowbox}"
STATE_DIR="$PANEL_DIR/state"
RELEASES_DIR="$PANEL_DIR/releases"

GREEN='\033[0;32m'
RED='\033[0;31m'
AMBER='\033[0;33m'
NC='\033[0m'

log()   { echo -e "${GREEN}[migrate]${NC} $1"; }
warn()  { echo -e "${AMBER}[migrate]${NC} $1"; }
error() { echo -e "${RED}[migrate]${NC} $1" >&2; exit 1; }

# ----- Pre-flight -----
[[ $EUID -eq 0 ]] || error "Запусти под root"
[[ -d "$PANEL_DIR" ]] || error "$PANEL_DIR не существует"

# Если уже в release-раскладке — просто выходим.
if [[ -L "$PANEL_DIR/current" ]] && [[ -d "$(readlink -f "$PANEL_DIR/current")" ]]; then
  log "current/ уже есть → миграция не нужна"
  exit 0
fi

VERSION=""
if [[ -f "$PANEL_DIR/VERSION" ]]; then
  VERSION="$(cat "$PANEL_DIR/VERSION")"
fi
[[ -n "$VERSION" ]] || error "VERSION файл пуст или отсутствует — нечего создавать как initial release"
log "Source version: $VERSION"

RELEASE_DIR="$RELEASES_DIR/$VERSION"

# ----- 1. Layout dirs -----
log "Готовлю $STATE_DIR/{data,logs,backups,snapshots}, $RELEASES_DIR"
mkdir -p "$STATE_DIR/data" "$STATE_DIR/logs" "$STATE_DIR/backups" "$STATE_DIR/snapshots" "$RELEASES_DIR"

# ----- 2. Перемещаем БД -----
if [[ -d "$PANEL_DIR/data" ]] && [[ ! -L "$PANEL_DIR/data" ]]; then
  if [[ -e "$STATE_DIR/data" ]] && [[ -n "$(ls -A "$STATE_DIR/data" 2>/dev/null)" ]]; then
    warn "$STATE_DIR/data уже не пуст — оставляю $PANEL_DIR/data на месте, разбирайся вручную"
  else
    log "Перемещаю data/ → state/data/"
    rmdir "$STATE_DIR/data" 2>/dev/null || true
    mv "$PANEL_DIR/data" "$STATE_DIR/data"
  fi
fi

# ----- 3. Перемещаем .env -----
if [[ -f "$PANEL_DIR/.env" ]] && [[ ! -L "$PANEL_DIR/.env" ]]; then
  if [[ -e "$STATE_DIR/.env" ]]; then
    warn "$STATE_DIR/.env уже существует — оставляю $PANEL_DIR/.env"
  else
    log "Перемещаю .env → state/.env"
    mv "$PANEL_DIR/.env" "$STATE_DIR/.env"
    chmod 600 "$STATE_DIR/.env"
  fi
fi

# Обновляем DATABASE_URL в state/.env (legacy: ../../data/, release: ../../state/data/)
if [[ -f "$STATE_DIR/.env" ]]; then
  if grep -q '^DATABASE_URL="file:\.\./\.\./data/' "$STATE_DIR/.env"; then
    log "Обновляю DATABASE_URL → state/data/meowbox.db"
    sed -i 's#^DATABASE_URL="file:\.\./\.\./data/#DATABASE_URL="file:../../state/data/#' "$STATE_DIR/.env"
  fi
fi

# ----- 4. Перемещаем logs/ (если есть в корне) -----
if [[ -d "$PANEL_DIR/logs" ]] && [[ ! -L "$PANEL_DIR/logs" ]]; then
  if [[ -n "$(ls -A "$PANEL_DIR/logs" 2>/dev/null)" ]]; then
    log "Перемещаю logs/ → state/logs/"
    cp -a "$PANEL_DIR/logs/." "$STATE_DIR/logs/"
  fi
  rm -rf "$PANEL_DIR/logs"
fi

# ----- 5. Перемещаем Adminer -----
if [[ -d "$PANEL_DIR/tools/adminer" ]] && [[ ! -L "$PANEL_DIR/tools/adminer" ]]; then
  if [[ -e "$STATE_DIR/adminer" ]] && [[ -n "$(ls -A "$STATE_DIR/adminer" 2>/dev/null)" ]]; then
    warn "$STATE_DIR/adminer уже не пуст — пропускаю"
  else
    log "Перемещаю tools/adminer → state/adminer"
    rmdir "$STATE_DIR/adminer" 2>/dev/null || true
    mv "$PANEL_DIR/tools/adminer" "$STATE_DIR/adminer"
  fi
fi

# ----- 6. Создаём initial release из текущего checkout -----
if [[ ! -d "$RELEASE_DIR" ]]; then
  log "Создаю $RELEASE_DIR из текущего legacy checkout"
  mkdir -p "$RELEASE_DIR"

  for item in api agent web shared migrations tools install.sh Makefile ecosystem.config.js VERSION CHANGELOG.md .env.example; do
    if [[ -e "$PANEL_DIR/$item" ]]; then
      cp -a "$PANEL_DIR/$item" "$RELEASE_DIR/"
    fi
  done

  # release/data, release/.env — симлинки на state/
  ln -sfn "$STATE_DIR/.env" "$RELEASE_DIR/.env"
  ln -sfn "$STATE_DIR/data" "$RELEASE_DIR/data"

  # tools/adminer внутри release → state/adminer
  if [[ -d "$RELEASE_DIR/tools/adminer" ]]; then
    rm -rf "$RELEASE_DIR/tools/adminer"
  fi
  mkdir -p "$RELEASE_DIR/tools"
  ln -sfn "$STATE_DIR/adminer" "$RELEASE_DIR/tools/adminer"
fi

# ----- 7. Переключаем current → releases/<VERSION> -----
ln -sfn "$RELEASE_DIR" "$PANEL_DIR/current"
log "current → releases/$VERSION"

# ----- 8. Корневые симлинки для эргономики (make / pm2) -----
log "Создаю корневые симлинки → current/..."
for item in ecosystem.config.js Makefile tools VERSION; do
  if [[ -e "$PANEL_DIR/$item" ]] && [[ ! -L "$PANEL_DIR/$item" ]]; then
    rm -rf "$PANEL_DIR/$item"
  fi
  ln -sfn "current/$item" "$PANEL_DIR/$item"
done

# ----- 9. Удаляем legacy-каталоги исходников -----
log "Чищу legacy api/, agent/, web/, shared/, migrations/, install.sh из корня"
for d in api agent web shared migrations install.sh; do
  if [[ -e "$PANEL_DIR/$d" ]] && [[ ! -L "$PANEL_DIR/$d" ]]; then
    rm -rf "$PANEL_DIR/$d"
  fi
done

# .gitignore / .git если есть — оставляем (это репо для разработки)
# Любые dotfiles (.gitignore, .env.example, .github) остаются.

# ----- 10. PM2 reload -----
log "PM2 reload..."
if command -v pm2 >/dev/null 2>&1; then
  pm2 reload "$PANEL_DIR/ecosystem.config.js" --update-env || true
fi

log "✓ Миграция legacy → release завершена. current → releases/$VERSION"
