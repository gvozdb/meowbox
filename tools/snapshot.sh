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

# 6. Master-key и legacy-ключи — критично для расшифровки всего в БД.
#   - $DATA_DIR/.master-key — единый master-key AES-256-GCM (32 байта),
#     HKDF-derived подключи для VPN/DNS/Databases/Migration/SSH/CMS.
#     Создаётся system-миграцией 2026-05-10-001-master-key-bootstrap.
#     БЕЗ НЕГО все секреты в БД нечитаемы — SSH-пароли, БД-пароли, VPN-конфиги.
#   - Legacy ключи (`.vpn-key`, `.dns-key`, `.vpn-key.legacy.*`) — оставлены на
#     30 дней после rekey-миграции для возможности отката.
#   - $STATE_DIR/vpn/<serviceId>/ — Xray runtime configs. AmneziaWG в /etc/amneziawg/
#     не бэкапим (регенерим из БД при restore).
# Ключи могут лежать в двух местах:
#   - $DATA_DIR ($STATE_DIR/data) — release-раскладка
#   - $PANEL_DIR/data — legacy раскладка (до перехода на state/)
# Проверяем обе директории.
KEY_DIRS=("$DATA_DIR")
[[ "$PANEL_DIR/data" != "$DATA_DIR" && -d "$PANEL_DIR/data" ]] && KEY_DIRS+=("$PANEL_DIR/data")

for KEY_DIR in "${KEY_DIRS[@]}"; do
  for KEY_NAME in .master-key .vpn-key .dns-key; do
    KEY_FILE="$KEY_DIR/$KEY_NAME"
    if [[ -f "$KEY_FILE" ]]; then
      # Префиксуем имя источником, чтобы не было коллизий между state/data и data/
      SUFFIX=""
      [[ "$KEY_DIR" == "$PANEL_DIR/data" ]] && SUFFIX=".from-legacy-data"
      cp "$KEY_FILE" "$SNAP_DIR/${KEY_NAME}${SUFFIX}"
      chmod 600 "$SNAP_DIR/${KEY_NAME}${SUFFIX}"
      say "✓ $KEY_NAME (from ${KEY_DIR})"
    fi
    # Legacy variants (после rekey-миграции файлы переименованы в .legacy.<ts>)
    for legacy in "$KEY_DIR"/${KEY_NAME}.legacy.*; do
      [[ -f "$legacy" ]] || continue
      base="$(basename "$legacy")"
      SUFFIX=""
      [[ "$KEY_DIR" == "$PANEL_DIR/data" ]] && SUFFIX=".from-legacy-data"
      cp "$legacy" "$SNAP_DIR/${base}${SUFFIX}"
      chmod 600 "$SNAP_DIR/${base}${SUFFIX}"
      say "✓ $base (from ${KEY_DIR})"
    done
  done
done

VPN_DIR="$STATE_DIR/vpn"
if [[ -d "$VPN_DIR" ]]; then
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
