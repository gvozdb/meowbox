#!/usr/bin/env bash
# =============================================================================
# Snapshot — бэкап критичного состояния панели перед опасной операцией
# (миграция, обновление, реструктуризация).
#
# Что бэкапим:
#  - SQLite-файл (state/data/meowbox.db) — БД панели
#  - state/.env — секреты + конфиги
#  - state/data/servers.json — конфиг серверов
#  - текущий симлинк current → ... (записываем target в файл)
#  - ecosystem.config.js
#
# Куда: state/data/snapshots/<timestamp>/
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANEL_DIR="$(dirname "$SCRIPT_DIR")"
STATE_DIR="${MEOWBOX_STATE_DIR:-$PANEL_DIR/state}"
[[ -d "$STATE_DIR" ]] || STATE_DIR="$PANEL_DIR"  # legacy: всё рядом

DATA_DIR="$STATE_DIR/data"
[[ -d "$DATA_DIR" ]] || DATA_DIR="$PANEL_DIR/data"

ENV_FILE="$STATE_DIR/.env"
[[ -f "$ENV_FILE" ]] || ENV_FILE="$PANEL_DIR/.env"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
SNAP_DIR="$DATA_DIR/snapshots/$TIMESTAMP"
mkdir -p "$SNAP_DIR"

say() { echo "[snapshot] $*"; }

say "Snapshot → $SNAP_DIR"

# 1. SQLite — через VACUUM INTO для consistent copy
DB_FILE="$DATA_DIR/meowbox.db"
if [[ -f "$DB_FILE" ]]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB_FILE" "VACUUM INTO '$SNAP_DIR/meowbox.db';"
    say "✓ SQLite (VACUUM INTO)"
  else
    cp "$DB_FILE" "$SNAP_DIR/meowbox.db"
    say "✓ SQLite (cp)"
  fi
fi

# 2. .env
if [[ -f "$ENV_FILE" ]]; then
  cp "$ENV_FILE" "$SNAP_DIR/.env"
  chmod 600 "$SNAP_DIR/.env"
  say "✓ .env"
fi

# 3. servers.json
SERVERS_JSON="$DATA_DIR/servers.json"
if [[ -f "$SERVERS_JSON" ]]; then
  cp "$SERVERS_JSON" "$SNAP_DIR/servers.json"
  say "✓ servers.json"
fi

# 4. current symlink target (если есть)
if [[ -L "$PANEL_DIR/current" ]]; then
  readlink -f "$PANEL_DIR/current" > "$SNAP_DIR/current_target.txt"
  say "✓ current → $(cat "$SNAP_DIR/current_target.txt")"
fi

# 5. ecosystem.config.js
if [[ -f "$PANEL_DIR/ecosystem.config.js" ]]; then
  cp "$PANEL_DIR/ecosystem.config.js" "$SNAP_DIR/ecosystem.config.js"
  say "✓ ecosystem.config.js"
fi

# 6. VPN state (.vpn-key + конфиги сервисов).
# /opt/meowbox/state/vpn/ содержит:
#   - .vpn-key (мастер-ключ для шифрования blob'ов в БД — без него никакой
#     restore VPN-сервисов не возможен)
#   - <serviceId>/{config.json,srv.key,srv.pub,...} — конфиги Xray/AmneziaWG
# Размер обычно <1 МБ.
VPN_DIR="$STATE_DIR/vpn"
if [[ -d "$VPN_DIR" ]]; then
  # Пакуем только .vpn-key + любые подкаталоги сервисов.
  # tar сохраняет permissions (важно для приватных ключей: 600).
  tar -C "$STATE_DIR" -czf "$SNAP_DIR/vpn.tgz" --warning=no-file-changed vpn 2>/dev/null || \
    tar -C "$STATE_DIR" -czf "$SNAP_DIR/vpn.tgz" vpn
  chmod 600 "$SNAP_DIR/vpn.tgz"
  say "✓ vpn (state/vpn → vpn.tgz)"
fi

# Ротация: оставляем последние 20 snapshot'ов
SNAPSHOTS_ROOT="$DATA_DIR/snapshots"
KEEP=20
ls -1tr "$SNAPSHOTS_ROOT" 2>/dev/null | head -n -$KEEP | while read -r old; do
  rm -rf "$SNAPSHOTS_ROOT/$old"
  say "  rotated: $old"
done

echo "$SNAP_DIR"
