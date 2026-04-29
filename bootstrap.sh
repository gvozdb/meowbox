#!/usr/bin/env bash
# =============================================================================
# Meowbox one-line bootstrap (release-based)
#
# Использование:
#   curl -fsSL https://raw.githubusercontent.com/gvozdb/meowbox/main/bootstrap.sh \
#     | sudo bash
#
# С переменными:
#   curl -fsSL https://raw.githubusercontent.com/gvozdb/meowbox/main/bootstrap.sh \
#     | sudo PANEL_PORT=18443 PANEL_DOMAIN=panel.example.com bash
#
# Что делает:
#   1. Минимальные deps (curl, tar, ca-certificates, jq, sha256sum) через apt
#   2. Создаёт layout: /opt/meowbox/{state/{data,logs,backups,snapshots},releases}
#   3. Узнаёт latest release tag из GitHub Releases
#   4. Скачивает meowbox-<ver>.tar.gz + SHA256SUMS (curl, repo публичный)
#   5. Verify checksum
#   6. Extract → /opt/meowbox/releases/<ver>/
#   7. Симлинки: current → releases/<ver>/, current/.env → state/.env, current/data → state/data
#   8. Запускает /opt/meowbox/current/install.sh (тяжёлые deps + nginx + pm2)
#
# Env-переменные (опционально):
#   MEOWBOX_DIR     — корень установки (по умолчанию /opt/meowbox)
#   MEOWBOX_VERSION — конкретная версия (по умолчанию latest)
#   GITHUB_REPO     — owner/name (по умолчанию gvozdb/meowbox)
#   GITHUB_TOKEN    — нужен только для приватных репо
#   PANEL_DOMAIN    — домен панели (по умолчанию localhost)
#   PANEL_PORT      — порт reverse proxy (по умолчанию 11862)
#   API_PORT        — порт API (по умолчанию 11860, loopback)
#   WEB_PORT        — порт Nuxt (по умолчанию 11861, loopback)
# =============================================================================
set -euo pipefail

MEOWBOX_DIR="${MEOWBOX_DIR:-/opt/meowbox}"
GITHUB_REPO="${GITHUB_REPO:-gvozdb/meowbox}"
TARGET="${MEOWBOX_VERSION:-}"

GREEN='\033[0;32m'
RED='\033[0;31m'
AMBER='\033[0;33m'
NC='\033[0m'

log()   { echo -e "${GREEN}[bootstrap]${NC} $1"; }
warn()  { echo -e "${AMBER}[bootstrap]${NC} $1"; }
error() { echo -e "${RED}[bootstrap]${NC} $1" >&2; exit 1; }

# ----- Pre-flight -----
[[ $EUID -eq 0 ]] || error "Запусти под root (через sudo)"

if ! grep -qiE 'ubuntu|debian' /etc/os-release 2>/dev/null; then
  error "Поддерживается только Ubuntu 22.04+ / Debian 12+"
fi

# ----- Базовые deps для скачивания tarball -----
log "Устанавливаю минимальные зависимости (curl, tar, jq, ca-certificates)..."
apt-get update -qq
apt-get install -y -qq curl ca-certificates tar jq coreutils >/dev/null

# ----- Создаём layout -----
log "Готовлю каталоги в $MEOWBOX_DIR..."
mkdir -p "$MEOWBOX_DIR/state/data" \
         "$MEOWBOX_DIR/state/logs" \
         "$MEOWBOX_DIR/state/backups" \
         "$MEOWBOX_DIR/state/snapshots" \
         "$MEOWBOX_DIR/releases"
chmod 700 "$MEOWBOX_DIR/state/data"

# ----- Резолвим latest release -----
api_curl() {
  local auth=()
  [[ -n "${GITHUB_TOKEN:-}" ]] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
  curl -sfL "${auth[@]}" -H "Accept: application/vnd.github+json" "$@"
}

if [[ -z "$TARGET" ]]; then
  log "Узнаю latest release из github.com/$GITHUB_REPO..."
  TARGET="$(api_curl "https://api.github.com/repos/$GITHUB_REPO/releases/latest" \
            | jq -r '.tag_name // empty')"
  [[ -n "$TARGET" ]] || error "Не удалось получить latest release. Проверь, что репозиторий публичный или задан GITHUB_TOKEN."
fi
log "Целевая версия: $TARGET"

RELEASE_DIR="$MEOWBOX_DIR/releases/$TARGET"

# ----- Идемпотентность: если current уже = TARGET, нечего качать -----
if [[ -L "$MEOWBOX_DIR/current" ]] && [[ "$(readlink -f "$MEOWBOX_DIR/current")" == "$RELEASE_DIR" ]]; then
  log "current → $TARGET уже установлен. Перезапускаю install.sh для актуализации."
  exec bash "$MEOWBOX_DIR/current/install.sh" --release-mode
fi

# ----- Download tarball + checksum -----
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
TARBALL="$TMP_DIR/meowbox-$TARGET.tar.gz"
SUMS="$TMP_DIR/SHA256SUMS"

DL_AUTH=()
[[ -n "${GITHUB_TOKEN:-}" ]] && DL_AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN")

log "Скачиваю tarball..."
curl -sfL "${DL_AUTH[@]}" \
  "https://github.com/$GITHUB_REPO/releases/download/$TARGET/meowbox-$TARGET.tar.gz" \
  -o "$TARBALL" || error "Не удалось скачать tarball $TARGET"

curl -sfL "${DL_AUTH[@]}" \
  "https://github.com/$GITHUB_REPO/releases/download/$TARGET/SHA256SUMS" \
  -o "$SUMS" || error "Не удалось скачать SHA256SUMS"

# ----- Verify -----
log "Проверка SHA256..."
(cd "$TMP_DIR" && sha256sum -c SHA256SUMS) >/dev/null \
  || error "Checksum не совпал — релиз повреждён или подменён"

# ----- Extract -----
log "Распаковываю в releases/$TARGET..."
if [[ -d "$RELEASE_DIR" ]]; then
  warn "Релиз $TARGET уже существует — перепаковываю"
  rm -rf "$RELEASE_DIR"
fi
mkdir -p "$RELEASE_DIR"
tar -xzf "$TARBALL" -C "$TMP_DIR"
# Tarball содержит каталог meowbox/ верхнего уровня
if [[ -d "$TMP_DIR/meowbox" ]]; then
  cp -a "$TMP_DIR/meowbox/." "$RELEASE_DIR/"
else
  cp -a "$TMP_DIR/." "$RELEASE_DIR/"
fi

# ----- Симлинки persistent state -----
ln -sfn "$MEOWBOX_DIR/state/.env"    "$RELEASE_DIR/.env"
ln -sfn "$MEOWBOX_DIR/state/data"    "$RELEASE_DIR/data"

# ----- Переключаем current -----
ln -sfn "$RELEASE_DIR" "$MEOWBOX_DIR/current"
log "current → releases/$TARGET"

# ----- Делегируем install.sh -----
[[ -f "$MEOWBOX_DIR/current/install.sh" ]] || error "install.sh не найден в релизе $TARGET — релиз повреждён?"
log "Запускаю install.sh из current/ ..."
chmod +x "$MEOWBOX_DIR/current/install.sh"
exec bash "$MEOWBOX_DIR/current/install.sh" --release-mode "$@"
