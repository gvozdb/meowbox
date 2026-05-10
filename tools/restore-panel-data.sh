#!/usr/bin/env bash
# =============================================================================
# Restore panel-data backup — восстанавливает БД, master-key, .env, vpn state,
# /etc/letsencrypt из panel-data snapshot'а.
#
# Использование:
#   bash tools/restore-panel-data.sh --snapshot-id <restic-snapshot-id> \
#                                    --location-id <storage-location-id>
#
# Что делает:
#   1. Останавливает API + agent.
#   2. Делает текущий snapshot (just-in-case) в state/data/snapshots/pre-restore-<ts>/.
#   3. Запускает restic restore из репо panel-data в /tmp/panel-restore-<ts>/.
#   4. Перекладывает файлы по своим путям:
#        - meowbox.db snapshot → state/data/meowbox.db (заменяет live!)
#        - .master-key, .vpn-key.*, .dns-key.* → state/data/
#        - state/.env, state/data/servers.json
#        - state/vpn/ → state/vpn/
#        - /etc/letsencrypt/ → /etc/letsencrypt/
#   5. Стартует API + agent.
#
# ВАЖНО: запускается ТОЛЬКО руками. UI кнопки restore нет — это самоубийство
# в процессе (API не может рестартануть сам себя, пока пишет в БД).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANEL_DIR="$(dirname "$SCRIPT_DIR")"
STATE_DIR="${MEOWBOX_STATE_DIR:-$PANEL_DIR/state}"
DATA_DIR="$STATE_DIR/data"

SNAPSHOT_ID=""
LOCATION_ID=""
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --snapshot-id) SNAPSHOT_ID="$2"; shift 2 ;;
    --location-id) LOCATION_ID="$2"; shift 2 ;;
    --dry-run)     DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '/^# Использование:/,/^# =====/p' "$0" | sed 's/^# //'
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$SNAPSHOT_ID" || -z "$LOCATION_ID" ]]; then
  echo "Usage: $0 --snapshot-id <id> --location-id <storage-location-id>" >&2
  exit 2
fi

say() { echo "[restore-panel-data] $*"; }
fatal() { echo "[restore-panel-data] FATAL: $*" >&2; exit 1; }

[[ -d "$DATA_DIR" ]] || fatal "$DATA_DIR не существует"

# 1. Достаём storage config из БД (НЕ останавливая API — пока ещё нужны его данные)
say "Reading storage location $LOCATION_ID from DB..."
STORAGE_JSON=$(sqlite3 -json "$DATA_DIR/meowbox.db" \
  "SELECT type, config, restic_password FROM storage_locations WHERE id = '$LOCATION_ID' LIMIT 1;")

if [[ -z "$STORAGE_JSON" || "$STORAGE_JSON" == "[]" ]]; then
  fatal "StorageLocation $LOCATION_ID не найден"
fi

STORAGE_TYPE=$(echo "$STORAGE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['type'])")
STORAGE_CONFIG=$(echo "$STORAGE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['config'])")
RESTIC_PASSWORD=$(echo "$STORAGE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['restic_password'] or '')")

[[ -n "$RESTIC_PASSWORD" ]] || fatal "У StorageLocation нет restic_password"

# 2. Собираем repo URL — нужно знать repoName (config.name slugified).
# Restic-репа panel-data — обычно одна, repoName = slugified имя config'а.
# Если есть несколько — берём первый panel-data config name.
PANEL_CONFIG_NAME=$(sqlite3 "$DATA_DIR/meowbox.db" \
  "SELECT name FROM panel_data_backup_configs ORDER BY created_at DESC LIMIT 1;")
[[ -n "$PANEL_CONFIG_NAME" ]] || fatal "Не найден ни один PanelDataBackupConfig"
REPO_NAME=$(echo "$PANEL_CONFIG_NAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]+/-/g; s/^-+//; s/-+$//')

case "$STORAGE_TYPE" in
  LOCAL)
    REMOTE_PATH=$(echo "$STORAGE_CONFIG" | python3 -c "import sys,json; print(json.load(sys.stdin).get('remotePath','/var/backups/meowbox/restic'))")
    REPO_URL="$REMOTE_PATH/$REPO_NAME"
    ;;
  S3)
    BUCKET=$(echo "$STORAGE_CONFIG" | python3 -c "import sys,json; print(json.load(sys.stdin).get('bucket',''))")
    ENDPOINT=$(echo "$STORAGE_CONFIG" | python3 -c "import sys,json; print(json.load(sys.stdin).get('endpoint',''))")
    PREFIX=$(echo "$STORAGE_CONFIG" | python3 -c "import sys,json; print(json.load(sys.stdin).get('prefix','meowbox'))")
    REPO_URL="s3:$ENDPOINT/$BUCKET/$PREFIX/$REPO_NAME"
    export AWS_ACCESS_KEY_ID=$(echo "$STORAGE_CONFIG" | python3 -c "import sys,json; print(json.load(sys.stdin).get('accessKey',''))")
    export AWS_SECRET_ACCESS_KEY=$(echo "$STORAGE_CONFIG" | python3 -c "import sys,json; print(json.load(sys.stdin).get('secretKey',''))")
    ;;
  *) fatal "Unsupported storage type: $STORAGE_TYPE" ;;
esac

say "Repo URL: $REPO_URL"
say "Snapshot ID: $SNAPSHOT_ID"

if [[ $DRY_RUN -eq 1 ]]; then
  say "--dry-run: останавливаюсь до фактических изменений"
  exit 0
fi

# 3. Pre-restore snapshot (на случай отката)
TS="$(date +%Y%m%d-%H%M%S)"
PRE_RESTORE_DIR="$DATA_DIR/snapshots/pre-restore-$TS"
say "Pre-restore snapshot → $PRE_RESTORE_DIR"
mkdir -p "$PRE_RESTORE_DIR"
sqlite3 "$DATA_DIR/meowbox.db" "VACUUM INTO '$PRE_RESTORE_DIR/meowbox.db';"
[[ -f "$DATA_DIR/.master-key" ]] && cp "$DATA_DIR/.master-key" "$PRE_RESTORE_DIR/"
[[ -f "$STATE_DIR/.env" ]] && cp "$STATE_DIR/.env" "$PRE_RESTORE_DIR/"

# 4. Остановить API + agent
say "Stopping pm2 meowbox-api meowbox-agent..."
pm2 stop meowbox-api meowbox-agent 2>/dev/null || true

# 5. Restic restore во временную директорию
RESTORE_DIR="/tmp/panel-restore-$TS"
mkdir -p "$RESTORE_DIR"

export RESTIC_PASSWORD
say "Running restic restore into $RESTORE_DIR..."
if ! restic -r "$REPO_URL" restore "$SNAPSHOT_ID" --target "$RESTORE_DIR"; then
  pm2 start meowbox-api meowbox-agent 2>/dev/null || true
  fatal "restic restore failed"
fi

# 6. Раскладываем файлы по местам
say "Restoring files..."

# meowbox.db: snapshot был `panel-backup-<ts>.db` в state/data/snapshots/
RESTORED_DB=$(find "$RESTORE_DIR" -name 'panel-backup-*.db' -type f | head -1)
if [[ -n "$RESTORED_DB" ]]; then
  cp "$RESTORED_DB" "$DATA_DIR/meowbox.db"
  say "✓ meowbox.db restored"
else
  say "WARN: panel-backup-*.db не найден в архиве"
fi

# Ключи (master-key, legacy variants)
for key in .master-key .vpn-key .dns-key; do
  for src in $(find "$RESTORE_DIR" -name "$key" -o -name "${key}.legacy.*"); do
    base=$(basename "$src")
    cp "$src" "$DATA_DIR/$base"
    chmod 600 "$DATA_DIR/$base"
    say "✓ $base restored"
  done
done

# .env
RESTORED_ENV=$(find "$RESTORE_DIR" -path '*/state/.env' | head -1)
if [[ -n "$RESTORED_ENV" ]]; then
  cp "$RESTORED_ENV" "$STATE_DIR/.env"
  chmod 600 "$STATE_DIR/.env"
  say "✓ .env restored"
fi

# servers.json
RESTORED_SERVERS=$(find "$RESTORE_DIR" -name 'servers.json' | head -1)
if [[ -n "$RESTORED_SERVERS" ]]; then
  cp "$RESTORED_SERVERS" "$DATA_DIR/servers.json"
  say "✓ servers.json restored"
fi

# state/vpn/
if [[ -d "$RESTORE_DIR$STATE_DIR/vpn" ]]; then
  mkdir -p "$STATE_DIR/vpn"
  cp -a "$RESTORE_DIR$STATE_DIR/vpn"/. "$STATE_DIR/vpn/"
  say "✓ state/vpn restored"
fi

# /etc/letsencrypt
if [[ -d "$RESTORE_DIR/etc/letsencrypt" ]]; then
  mkdir -p /etc/letsencrypt
  cp -a "$RESTORE_DIR/etc/letsencrypt"/. /etc/letsencrypt/
  say "✓ /etc/letsencrypt restored"
fi

# 7. Cleanup restore dir
rm -rf "$RESTORE_DIR"

# 8. Стартуем API + agent
say "Starting pm2 meowbox-api meowbox-agent..."
pm2 start meowbox-api meowbox-agent 2>/dev/null || pm2 start "$PANEL_DIR/ecosystem.config.js"

say "Done. Pre-restore snapshot: $PRE_RESTORE_DIR"
say "Если что-то пошло не так — откатывайся ручками из этой папки."
