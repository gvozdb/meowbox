#!/usr/bin/env bash
# =============================================================================
# Consistent release snapshot.
#
# Uses SQLite's online backup API and a GNU-tar metadata archive for the exact
# managed runtime artifact list.  It is safe to call manually, and update.sh
# uses --transaction before its quiesce/database boundary.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANEL_DIR="$(dirname "$SCRIPT_DIR")"
# shellcheck source=tools/release-lib.sh
source "$SCRIPT_DIR/release-lib.sh"

STATE_DIR="${MEOWBOX_STATE_DIR:-$PANEL_DIR/state}"
[[ -d "$STATE_DIR" ]] || STATE_DIR="$PANEL_DIR"
DATA_DIR="$STATE_DIR/data"
[[ -d "$DATA_DIR" ]] || DATA_DIR="$PANEL_DIR/data"
SNAP_ROOT="${MEOWBOX_SNAPSHOT_ROOT:-$DATA_DIR/snapshots}"
DB_FILE="${MEOWBOX_DATABASE_FILE:-$DATA_DIR/meowbox.db}"
ENV_FILE="${MEOWBOX_ENV_FILE:-$STATE_DIR/.env}"
LOCK_FILE="${MEOWBOX_RELEASE_LOCK_FILE:-$DATA_DIR/migrations/release-update.lock}"
[[ -f "$ENV_FILE" ]] || ENV_FILE="$PANEL_DIR/.env"

TRANSACTION_ID=""
EXTRA_PATHS_FILE=""
OUTPUT_DIR=""
ROTATE=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --transaction)
      TRANSACTION_ID="${2:-}"
      shift 2
      ;;
    --paths-file)
      EXTRA_PATHS_FILE="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT_DIR="${2:-}"
      shift 2
      ;;
    --no-rotate)
      ROTATE=false
      shift
      ;;
    *)
      echo "Usage: snapshot.sh [--transaction ID] [--paths-file FILE] [--output DIR] [--no-rotate]" >&2
      exit 2
      ;;
  esac
done

say() { echo "[snapshot] $*"; }
die() { echo "[snapshot] ✗ $*" >&2; exit 1; }

for command in python3 tar flock; do mb_require_command "$command" || die "missing dependency"; done
mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>>"$LOCK_FILE"
if [[ "${MEOWBOX_RELEASE_LOCK_HELD:-}" != "1" ]]; then
  flock -n 9 || die "another release update/recovery owns $LOCK_FILE"
fi
mkdir -p "$SNAP_ROOT"
chmod 0700 "$SNAP_ROOT" || true

if [[ -n "$TRANSACTION_ID" && ! "$TRANSACTION_ID" =~ ^[A-Za-z0-9._-]{8,128}$ ]]; then
  die "unsafe transaction id"
fi
if [[ -n "$EXTRA_PATHS_FILE" && ! -f "$EXTRA_PATHS_FILE" ]]; then
  die "paths file does not exist: $EXTRA_PATHS_FILE"
fi

if [[ -n "$OUTPUT_DIR" ]]; then
  SNAP_DIR="$OUTPUT_DIR"
elif [[ -n "$TRANSACTION_ID" ]]; then
  SNAP_DIR="$SNAP_ROOT/release-$TRANSACTION_ID"
else
  SNAP_DIR="$SNAP_ROOT/$(date -u +%Y%m%d-%H%M%S)-$$"
fi
[[ ! -e "$SNAP_DIR" ]] || die "snapshot target already exists: $SNAP_DIR"
mkdir -p "$SNAP_DIR"
chmod 0700 "$SNAP_DIR" || true

say "Snapshot → $SNAP_DIR"

SOURCE_DB_HASH="missing"
SOURCE_DB_FILE_HASH="missing"
if [[ -f "$DB_FILE" ]]; then
  SOURCE_DB_HASH="$(mb_hash_paths "$DB_FILE" "$DB_FILE-wal" "$DB_FILE-journal")"
  SOURCE_DB_FILE_HASH="$(mb_sqlite_file_fingerprint "$DB_FILE")"
  mb_sqlite_backup "$DB_FILE" "$SNAP_DIR/meowbox.db"
  DB_HASH_AFTER="$(mb_hash_paths "$DB_FILE" "$DB_FILE-wal" "$DB_FILE-journal")"
  DB_FILE_HASH_AFTER="$(mb_sqlite_file_fingerprint "$DB_FILE")"
  [[ "$SOURCE_DB_HASH" == "$DB_HASH_AFTER" ]] || die "SQLite changed during backup; retry after writers are quiescent"
  [[ "$SOURCE_DB_FILE_HASH" == "$DB_FILE_HASH_AFTER" ]] || die "SQLite main/WAL changed during backup; retry after writers are quiescent"
  say "✓ SQLite online backup API"
fi

LEGACY_PATHS="$SNAP_DIR/legacy-managed-paths.txt"
if [[ -f "$DB_FILE" ]]; then
  mb_collect_legacy_managed_paths "$DB_FILE" "$LEGACY_PATHS"
else
  : > "$LEGACY_PATHS"
fi
MERGED_PATHS="$SNAP_DIR/managed-runtime-paths.txt"
if [[ -n "$EXTRA_PATHS_FILE" ]]; then
  mb_merge_path_files "$MERGED_PATHS" "$LEGACY_PATHS" "$EXTRA_PATHS_FILE"
else
  mb_merge_path_files "$MERGED_PATHS" "$LEGACY_PATHS"
fi
while IFS= read -r managed_path; do
  [[ -z "$managed_path" ]] && continue
  mb_is_managed_runtime_path "$managed_path" || die "unsafe managed runtime path: $managed_path"
done < "$MERGED_PATHS"

CONFIG_HASH="$(mb_hash_path_file "$MERGED_PATHS")"
mb_snapshot_runtime_config "$SNAP_DIR" "$MERGED_PATHS"
CONFIG_HASH_AFTER="$(mb_hash_path_file "$MERGED_PATHS")"
[[ "$CONFIG_HASH" == "$CONFIG_HASH_AFTER" ]] || die "managed runtime config changed during snapshot; retry after writers are quiescent"
say "✓ managed Nginx/PHP-FPM/logrotate config + metadata"

copy_preserving() {
  local source="$1"
  local destination="$2"
  [[ -e "$source" || -L "$source" ]] || return 0
  mkdir -p "$(dirname "$destination")"
  cp -a -- "$source" "$destination"
}

copy_preserving "$ENV_FILE" "$SNAP_DIR/state/.env"
copy_preserving "$DATA_DIR/servers.json" "$SNAP_DIR/state/servers.json"
for key_name in .master-key .vpn-key .dns-key; do
  copy_preserving "$DATA_DIR/$key_name" "$SNAP_DIR/state/$key_name"
  for key_variant in "$DATA_DIR"/"$key_name".legacy.*; do
    [[ -e "$key_variant" ]] || continue
    copy_preserving "$key_variant" "$SNAP_DIR/state/$(basename "$key_variant")"
  done
done
if [[ -d "$STATE_DIR/vpn" ]]; then
  tar --create --gzip --file "$SNAP_DIR/state/vpn.tar.gz" --directory "$STATE_DIR" \
    --format=pax --numeric-owner --acls --xattrs --selinux vpn
fi

CURRENT_RELEASE=""
if [[ -L "$PANEL_DIR/current" ]]; then
  CURRENT_RELEASE="$(readlink -f "$PANEL_DIR/current")"
fi
PM2_STATE="[]"
if command -v pm2 >/dev/null 2>&1; then
  PM2_STATE="$(pm2 jlist 2>/dev/null || printf '[]')"
fi
export SNAPSHOT_TRANSACTION_ID="$TRANSACTION_ID"
export SNAPSHOT_SOURCE_DB_HASH="$SOURCE_DB_HASH"
export SNAPSHOT_SOURCE_DB_FILE_HASH="$SOURCE_DB_FILE_HASH"
export SNAPSHOT_CONFIG_HASH="$CONFIG_HASH"
export SNAPSHOT_CURRENT_RELEASE="$CURRENT_RELEASE"
export SNAPSHOT_CREATED_AT="$(mb_now_utc)"
export SNAPSHOT_DB_PRESENT="$( [[ -f "$DB_FILE" ]] && printf true || printf false )"
python3 - "$SNAP_DIR/manifest.json" 3<<<"$PM2_STATE" <<'PY'
import json
import os
import pathlib
import sys
import tempfile

try:
    with os.fdopen(3, encoding="utf-8") as handle:
        raw_pm2 = json.load(handle)
except (json.JSONDecodeError, OSError):
    raw_pm2 = []

# PM2's raw process dump contains the complete environment, including panel
# secrets. Rollback only needs process identity/health; never persist env data.
pm2 = []
for item in raw_pm2 if isinstance(raw_pm2, list) else []:
    if not isinstance(item, dict):
        continue
    env = item.get("pm2_env") if isinstance(item.get("pm2_env"), dict) else {}
    pm2.append({
        "name": item.get("name"),
        "pid": item.get("pid"),
        "pmId": item.get("pm_id", env.get("pm_id")),
        "namespace": env.get("namespace"),
        "status": env.get("status"),
        "restartTime": env.get("restart_time"),
        "execPath": env.get("pm_exec_path"),
        "cwd": env.get("pm_cwd"),
    })
manifest = {
    "version": 2,
    "createdAt": os.environ["SNAPSHOT_CREATED_AT"],
    "transactionId": os.environ["SNAPSHOT_TRANSACTION_ID"] or None,
    "database": {
        "present": os.environ["SNAPSHOT_DB_PRESENT"] == "true",
        "sourceHash": os.environ["SNAPSHOT_SOURCE_DB_HASH"],
        "sourceFileHash": os.environ["SNAPSHOT_SOURCE_DB_FILE_HASH"],
        "backupFile": "meowbox.db",
    },
    "managedRuntime": {
        "sourceHash": os.environ["SNAPSHOT_CONFIG_HASH"],
        "metadataFile": "runtime-config/metadata.json",
        "archiveFile": "runtime-config/config.tar.gz",
    },
    "currentRelease": os.environ["SNAPSHOT_CURRENT_RELEASE"] or None,
    "pm2": pm2,
}
target = pathlib.Path(sys.argv[1])
target.parent.mkdir(parents=True, exist_ok=True)
fd, temporary = tempfile.mkstemp(prefix=".manifest-", dir=target.parent)
with os.fdopen(fd, "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, indent=2, sort_keys=True)
    handle.write("\n")
    handle.flush()
    os.fsync(handle.fileno())
os.replace(temporary, target)
directory = os.open(target.parent, os.O_RDONLY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY

if $ROTATE && [[ -z "$TRANSACTION_ID" ]]; then
  python3 - "$SNAP_ROOT" "$SNAP_DIR" <<'PY'
import os
import pathlib
import shutil
import sys

root = pathlib.Path(sys.argv[1]).resolve()
current = pathlib.Path(sys.argv[2]).resolve()
entries = sorted(
    (entry for entry in root.iterdir() if entry.is_dir() and entry.resolve().parent == root),
    key=lambda entry: entry.stat().st_mtime,
    reverse=True,
)
for entry in entries[20:]:
    if entry.resolve() == current or entry.name.startswith("release-"):
        continue
    shutil.rmtree(entry)
PY
fi

echo "$SNAP_DIR"
