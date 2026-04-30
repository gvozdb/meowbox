#!/usr/bin/env bash
# =============================================================================
# Update — главный скрипт обновления панели.
#
# Скачивает релиз с GitHub Releases, проверяет подпись, разворачивает в
# releases/<version>/, прогоняет миграции, переключает симлинк current,
# делает pm2 reload, healthcheck. При фейле — автоматический rollback.
#
# Usage:
#   bash tools/update.sh                  # latest stable release
#   bash tools/update.sh v1.4.2           # конкретная версия
#   bash tools/update.sh --check          # только проверить, есть ли обновление
#   bash tools/update.sh --dry-run        # симуляция без изменений
#
# Stages (выводятся в stdout префиксом [stage:NAME]):
#   preflight, snapshot, download, verify, extract, install, migrate, switch,
#   reload, healthcheck, cleanup
#
# Env:
#   GITHUB_REPO=gvozdb/meowbox
#   MEOWBOX_KEEP_RELEASES=5
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANEL_DIR="$(dirname "$SCRIPT_DIR")"
RELEASES_DIR="$PANEL_DIR/releases"
# STATE_DIR строго привязан к PANEL_DIR/state. НЕ берём из env, потому что
# старый PM2-процесс (который и спавнит update.sh через UI-trigger) выставляет
# MEOWBOX_STATE_DIR на release dir предыдущей версии (releases/<old_v>/state),
# и эта дрянь наследуется в update.sh → миграции пишут в неправильный путь.
STATE_DIR="$PANEL_DIR/state"
LOCK_FILE="${MEOWBOX_UPDATE_LOCK:-/var/run/meowbox-update.lock}"
GITHUB_REPO="${GITHUB_REPO:-gvozdb/meowbox}"
KEEP_RELEASES="${MEOWBOX_KEEP_RELEASES:-3}"

# CLI
TARGET=""
DRY_RUN=false
CHECK_ONLY=false
TRIGGERED_BY="${MEOWBOX_TRIGGERED_BY:-cli}"
for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN=true ;;
    --check)    CHECK_ONLY=true ;;
    --triggered-by=*) TRIGGERED_BY="${arg#--triggered-by=}" ;;
    v*)         TARGET="$arg" ;;
    *)          ;;
  esac
done

# ----- Hookable stage logging -----
stage()  { echo "[stage:$1] $2"; }
say()    { echo "[update] $*"; }
err()    { echo "[update] ✗ $*" >&2; }
abort()  { err "$1"; exit 1; }

# ----- Lock -----
acquire_lock() {
  if [[ -e "$LOCK_FILE" ]]; then
    pid="$(cat "$LOCK_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      abort "Другой update.sh уже идёт (pid $pid). Подожди или убей вручную."
    fi
    say "Stale lock (pid $pid) — удаляю"
    rm -f "$LOCK_FILE"
  fi
  echo $$ > "$LOCK_FILE"
  trap 'rm -f "$LOCK_FILE"' EXIT
}

# ----- 0. Preflight -----
stage preflight "Проверка окружения"
acquire_lock

command -v curl >/dev/null    || abort "curl не установлен"
command -v tar >/dev/null     || abort "tar не установлен"
command -v sha256sum >/dev/null || abort "sha256sum не установлен"
command -v node >/dev/null    || abort "node не установлен"
command -v pm2 >/dev/null     || abort "pm2 не установлен"

# Auto-trigger миграции legacy → release раскладки.
# Если current/ нет, но в корне лежат api/, web/ и VERSION — мы в legacy
# layout. Прогоняем migrate-legacy-to-release.sh ОДИН раз перед download.
if [[ ! -L "$PANEL_DIR/current" ]] && \
   [[ -d "$PANEL_DIR/api" ]] && \
   [[ -d "$PANEL_DIR/web" ]] && \
   [[ -f "$PANEL_DIR/VERSION" ]]; then
  stage migrate-legacy "Detected legacy layout — конвертирую в release"
  bash "$SCRIPT_DIR/migrate-legacy-to-release.sh" || abort "migrate-legacy-to-release.sh упал"
  # После миграции $PANEL_DIR/tools стал симлинком → current/tools. Дальше
  # все подскрипты вызываются через $SCRIPT_DIR, который остаётся логическим
  # путём ($PANEL_DIR/tools). НЕ резолвим pwd -P — иначе snapshot.sh и прочие
  # пойдут от physical-пути releases/<v>/, а не от /opt/meowbox/, и сложат
  # данные в /opt/meowbox/releases/<v>/state/, что бесполезно.
  SCRIPT_DIR="$PANEL_DIR/tools"
  RELEASES_DIR="$PANEL_DIR/releases"
fi

# Свободное место — минимум 2GB
avail_kb="$(df -P "$PANEL_DIR" | awk 'NR==2{print $4}')"
[[ "$avail_kb" -gt $((2 * 1024 * 1024)) ]] || abort "Свободного места <2GB на $PANEL_DIR"

# Текущая версия
CURRENT_VERSION="unknown"
if [[ -L "$PANEL_DIR/current" ]] && [[ -f "$PANEL_DIR/current/VERSION" ]]; then
  CURRENT_VERSION="$(cat "$PANEL_DIR/current/VERSION")"
fi
say "Текущая версия: $CURRENT_VERSION"

# Latest version из GitHub (только tag_name, без скачивания tarball)
fetch_latest() {
  local auth=()
  [[ -n "${GITHUB_TOKEN:-}" ]] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
  curl -sfL "${auth[@]}" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$GITHUB_REPO/releases/latest" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('tag_name',''))"
}

if [[ -z "$TARGET" ]]; then
  TARGET="$(fetch_latest || true)"
  [[ -n "$TARGET" ]] || abort "Не удалось получить latest release с GitHub. Проверь GITHUB_REPO=$GITHUB_REPO"
fi
say "Target: $TARGET"

if [[ "$CURRENT_VERSION" == "$TARGET" ]] && [[ "$CHECK_ONLY" == "true" ]]; then
  say "Уже на $TARGET — обновление не требуется"
  exit 0
fi

if [[ "$CHECK_ONLY" == "true" ]]; then
  say "Доступно обновление: $CURRENT_VERSION → $TARGET"
  exit 0
fi

if [[ "$DRY_RUN" == "true" ]]; then
  say "DRY-RUN: установил бы $TARGET. Выход."
  exit 0
fi

# ----- 1. Snapshot -----
stage snapshot "Создаю snapshot БД и конфигов"
SNAP_PATH="$(bash "$SCRIPT_DIR/snapshot.sh" | tail -1)"
say "Snapshot: $SNAP_PATH"

# ----- 2. Download -----
stage download "Скачиваю tarball $TARGET"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"; rm -f "$LOCK_FILE"' EXIT
TARBALL="$TMP_DIR/meowbox-$TARGET.tar.gz"
SUMS="$TMP_DIR/SHA256SUMS"

# Для приватных репо используем `gh release download` (он умеет авторизоваться через GITHUB_TOKEN/gh auth).
# Для публичных fall-back на curl.
if command -v gh >/dev/null 2>&1; then
  (cd "$TMP_DIR" && gh release download "$TARGET" --repo "$GITHUB_REPO" \
    --pattern "meowbox-$TARGET.tar.gz" --pattern "SHA256SUMS" --skip-existing) \
    || abort "gh release download $TARGET упал"
else
  AUTH_HDR=()
  [[ -n "${GITHUB_TOKEN:-}" ]] && AUTH_HDR=(-H "Authorization: Bearer $GITHUB_TOKEN")
  # Existence-probe: HEAD на metadata-эндпоинт с правильным Accept.
  # NB: НЕ слать Accept: application/octet-stream сюда — GitHub отвечает 415.
  http_code="$(curl -sIL -o /dev/null -w '%{http_code}' "${AUTH_HDR[@]}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$GITHUB_REPO/releases/tags/$TARGET" || echo 000)"
  if [[ "$http_code" != "200" ]]; then
    abort "Релиз $TARGET не найден на GitHub (HTTP $http_code, repo=$GITHUB_REPO)"
  fi
  curl -sfL "${AUTH_HDR[@]}" \
    "https://github.com/$GITHUB_REPO/releases/download/$TARGET/meowbox-$TARGET.tar.gz" \
    -o "$TARBALL" || abort "Не удалось скачать tarball (для приватных репо нужен gh CLI или GITHUB_TOKEN)"
  curl -sfL "${AUTH_HDR[@]}" \
    "https://github.com/$GITHUB_REPO/releases/download/$TARGET/SHA256SUMS" \
    -o "$SUMS" || abort "Не удалось скачать SHA256SUMS"
fi

# ----- 3. Verify -----
stage verify "Проверка checksum + attestation"
(cd "$TMP_DIR" && sha256sum -c SHA256SUMS) || abort "Checksum не совпал — релиз повреждён или подменён!"
say "✓ SHA256 OK"

if command -v gh >/dev/null 2>&1; then
  if gh attestation verify "$TARBALL" --owner "$(echo "$GITHUB_REPO" | cut -d/ -f1)" 2>/dev/null; then
    say "✓ Attestation verified"
  else
    say "⚠ Attestation не проверилась (gh не аутентифицирован?). Продолжаю на свой риск."
  fi
else
  say "⚠ gh CLI не установлен — пропускаю attestation verify"
fi

# ----- 4. Extract -----
stage extract "Распаковка в releases/$TARGET"
RELEASE_DIR="$RELEASES_DIR/$TARGET"
if [[ -d "$RELEASE_DIR" ]]; then
  say "Релиз $TARGET уже существует — удаляю и переразворачиваю"
  rm -rf "$RELEASE_DIR"
fi
mkdir -p "$RELEASE_DIR"
# Тарболл собирается в CI как `meowbox/...` на верхнем уровне (см. release.yml).
# Разворачиваем напрямую в RELEASE_DIR со --strip-components=1, чтобы убрать
# верхний `meowbox/`. Если по какой-то причине формат другой — fallback через
# временный каталог + cp.
if ! tar -xzf "$TARBALL" -C "$RELEASE_DIR" --strip-components=1; then
  err "tar --strip-components=1 не сработал, пробую fallback через TMP_DIR"
  rm -rf "$RELEASE_DIR"
  mkdir -p "$RELEASE_DIR"
  tar -xzf "$TARBALL" -C "$TMP_DIR" || abort "Не удалось распаковать tarball"
  if [[ -d "$TMP_DIR/meowbox" ]]; then
    cp -a "$TMP_DIR/meowbox/." "$RELEASE_DIR/"
  else
    abort "В tarball нет ожидаемой папки meowbox/ — релиз повреждён"
  fi
fi
# Sanity check: должны быть основные пакеты после распаковки.
for required in api/dist/main.js shared/dist/index.js VERSION; do
  [[ -e "$RELEASE_DIR/$required" ]] || abort "После распаковки нет $required — релиз повреждён"
done

# Симлинки на shared state
ln -sfn "$STATE_DIR/data" "$RELEASE_DIR/data" 2>/dev/null || true
ln -sfn "$STATE_DIR/.env" "$RELEASE_DIR/.env" 2>/dev/null || true

# ----- 5. Install prod deps -----
# shared/ и migrations/ — собранные артефакты без runtime-deps (зависимости
# резолвятся через симлинки), поэтому npm ci там не нужен и упадёт без
# package-lock.json в тарболле.
stage install "Установка production-зависимостей"
for pkg in agent api web; do
  if [[ -f "$RELEASE_DIR/$pkg/package-lock.json" ]]; then
    (cd "$RELEASE_DIR/$pkg" && npm ci --omit=dev --no-audit --no-fund) \
      || abort "npm ci провалился в $pkg"
  fi
done

# @meowbox/shared не объявлен в dependencies — линкуем вручную после npm ci.
for pkg in api agent web migrations; do
  mkdir -p "$RELEASE_DIR/$pkg/node_modules/@meowbox"
  ln -sfn "../../../shared" "$RELEASE_DIR/$pkg/node_modules/@meowbox/shared"
done
if [[ -d "$RELEASE_DIR/api/node_modules/@prisma/client" ]]; then
  mkdir -p "$RELEASE_DIR/migrations/node_modules/@prisma"
  ln -sfn "../../../api/node_modules/@prisma/client" "$RELEASE_DIR/migrations/node_modules/@prisma/client"
fi

# Prisma client регенерация (нужен после npm ci)
if [[ -f "$RELEASE_DIR/api/prisma/schema.prisma" ]]; then
  (cd "$RELEASE_DIR/api" && DATABASE_URL="file:$STATE_DIR/data/meowbox.db" npx prisma generate) || true
fi

# ----- 6. Migrations -----
# Prisma: используем `db push` (а не `migrate deploy`), потому что install.sh
# создаёт DB через `db push` без миграционного tracking (нет _prisma_migrations
# таблицы). `migrate deploy` упал бы с P3005 на любом legacy-инстансе.
# Для self-hosted панели единый источник истины — schema.prisma; ветвление
# миграций не нужно. --skip-generate (клиент уже сгенерирован выше),
# --accept-data-loss безопасен пока мы не дропаем колонки в апдейте.
stage migrate "Применение миграций (Prisma db push + system)"
if [[ -f "$RELEASE_DIR/api/prisma/schema.prisma" ]]; then
  (cd "$RELEASE_DIR/api" && DATABASE_URL="file:$STATE_DIR/data/meowbox.db" \
    npx prisma db push --skip-generate --accept-data-loss) \
    || abort "Prisma db push провалилась"
fi
if [[ -f "$RELEASE_DIR/migrations/dist/runner.js" ]]; then
  MEOWBOX_STATE_DIR="$STATE_DIR" \
    DATABASE_URL="file:$STATE_DIR/data/meowbox.db" \
    node "$RELEASE_DIR/migrations/dist/runner.js" up \
    || abort "System migrations failed"
fi

# ----- 7. Switch -----
stage switch "Переключение current → $TARGET"
PREV_TARGET=""
if [[ -L "$PANEL_DIR/current" ]]; then
  PREV_TARGET="$(readlink -f "$PANEL_DIR/current")"
fi
ln -sfn "$RELEASE_DIR" "$PANEL_DIR/current"

# ----- 8. Reload PM2 -----
stage reload "PM2 reload"
pm2 reload "$PANEL_DIR/ecosystem.config.js" --update-env

# ----- 9. Healthcheck -----
stage healthcheck "Проверка работоспособности"
if ! bash "$SCRIPT_DIR/healthcheck.sh"; then
  err "Healthcheck failed — откатываюсь"
  if [[ -n "$PREV_TARGET" ]]; then
    ln -sfn "$PREV_TARGET" "$PANEL_DIR/current"
    pm2 reload "$PANEL_DIR/ecosystem.config.js" --update-env
    sleep 5
    bash "$SCRIPT_DIR/healthcheck.sh" || err "Откат тоже не помог!"
    abort "Update FAILED, откат на $(basename "$PREV_TARGET")"
  else
    abort "Update FAILED, отката нет (это первый релиз?)"
  fi
fi

# ----- 10. Cleanup -----
stage cleanup "Чистка старых релизов (оставляем $KEEP_RELEASES)"
ls -1t "$RELEASES_DIR" 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | while read -r old; do
  rm -rf "$RELEASES_DIR/$old"
  say "  removed: $old"
done

say "✓ Update OK: $CURRENT_VERSION → $TARGET"
