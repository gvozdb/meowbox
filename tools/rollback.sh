#!/usr/bin/env bash
# =============================================================================
# Recovery for a pre-commit release transaction.
#
# A release-only symlink rollback is unsafe after Prisma has changed SQLite.
# This command restores the matched SQLite + managed-config snapshot + release
# pointer as one recovery unit.  It never auto-rolls back a committed release.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANEL_DIR="${MEOWBOX_PANEL_DIR:-$(dirname "$SCRIPT_DIR")}"
[[ "$PANEL_DIR" == /* && -d "$PANEL_DIR" ]] || {
  echo "[rollback] ✗ MEOWBOX_PANEL_DIR must be an existing absolute directory" >&2
  exit 1
}
PANEL_DIR="$(cd "$PANEL_DIR" && pwd -P)"
# shellcheck source=tools/release-lib.sh
source "$SCRIPT_DIR/release-lib.sh"

STATE_DIR="${MEOWBOX_STATE_DIR:-$PANEL_DIR/state}"
[[ -d "$STATE_DIR" ]] || STATE_DIR="$PANEL_DIR"
DATA_DIR="$STATE_DIR/data"
[[ -d "$DATA_DIR" ]] || DATA_DIR="$PANEL_DIR/data"
SNAP_ROOT="${MEOWBOX_SNAPSHOT_ROOT:-$DATA_DIR/snapshots}"
DB_FILE="${MEOWBOX_DATABASE_FILE:-$DATA_DIR/meowbox.db}"
LOCK_FILE="${MEOWBOX_RELEASE_LOCK_FILE:-$DATA_DIR/migrations/release-update.lock}"
TRANSACTION_ROOT="$DATA_DIR/migrations/release-transactions"

say() { echo "[rollback] $*"; }
die() { echo "[rollback] ✗ $*" >&2; exit 1; }

if [[ -f "$PANEL_DIR/.dev-mode" ]]; then
  die "release rollback is unavailable on a dev workspace"
fi
for command in python3 flock; do mb_require_command "$command" || die "missing dependency"; done
mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>>"$LOCK_FILE"
if [[ "${MEOWBOX_RELEASE_LOCK_HELD:-}" != "1" ]]; then
  flock -n 9 || die "another release update/recovery owns $LOCK_FILE"
fi

mode="${1:-precommit}"
argument="${2:-}"

journal_value() {
  local journal="$1"
  local key="$2"
  python3 - "$journal" "$key" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)
for component in sys.argv[2].split('.'):
    value = value.get(component) if isinstance(value, dict) else None
if value is None:
    raise SystemExit(1)
if isinstance(value, bool):
    print("true" if value else "false")
else:
    print(value)
PY
}

journal_mark_rolled_back() {
  local journal="$1"
  python3 - "$journal" <<'PY' | mb_atomic_write_stdin "$journal"
import json
import sys
from datetime import datetime, timezone

with open(sys.argv[1], encoding="utf-8") as handle:
    payload = json.load(handle)
payload["phase"] = "rolled-back"
payload["committed"] = False
payload["rolledBackAt"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
print(json.dumps(payload, indent=2, sort_keys=True))
PY
}

restore_db() {
  local snapshot_dir="$1"
  local source="$snapshot_dir/meowbox.db"
  [[ -f "$source" ]] || return 0
  mkdir -p "$(dirname "$DB_FILE")"
  local temporary="$DB_FILE.rollback-$$"
  [[ ! -e "$temporary" ]] || die "temporary rollback DB path already exists"
  cp --preserve=mode,ownership,timestamps -- "$source" "$temporary"
  mv -f -- "$temporary" "$DB_FILE"
  rm -f -- "$DB_FILE-wal" "$DB_FILE-shm" "$DB_FILE-journal"
  say "✓ SQLite restored from online-backup snapshot"
}

restore_state_files() {
  local snapshot_dir="$1"
  local state_snapshot="$snapshot_dir/state"
  [[ -d "$state_snapshot" ]] || return 0
  local env_target="$STATE_DIR/.env"
  [[ -f "$env_target" ]] || env_target="$PANEL_DIR/.env"
  [[ -e "$state_snapshot/.env" ]] && cp -a -- "$state_snapshot/.env" "$env_target"
  [[ -e "$state_snapshot/servers.json" ]] && cp -a -- "$state_snapshot/servers.json" "$DATA_DIR/servers.json"
  for key_file in "$state_snapshot"/.master-key "$state_snapshot"/.vpn-key "$state_snapshot"/.dns-key "$state_snapshot"/*.legacy.*; do
    [[ -e "$key_file" ]] || continue
    cp -a -- "$key_file" "$DATA_DIR/$(basename "$key_file")"
  done
  if [[ -f "$state_snapshot/vpn.tar.gz" ]]; then
    rm -rf -- "$STATE_DIR/vpn"
    tar --extract --gzip --file "$state_snapshot/vpn.tar.gz" --directory "$STATE_DIR" --numeric-owner --acls --xattrs --selinux
  fi
}

reload_managed_runtime() {
  local snapshot_dir="$1"
  local paths="$snapshot_dir/runtime-config/paths.txt"
  local versions=()
  if [[ -f "$paths" ]]; then
    while IFS= read -r candidate; do
      if [[ "$candidate" =~ ^/etc/php/([0-9]+\.[0-9]+)/fpm/pool\.d/ ]]; then
        versions+=("${BASH_REMATCH[1]}")
      fi
    done < "$paths"
  fi
  if command -v nginx >/dev/null 2>&1; then
    nginx -t || die "restored Nginx config did not validate"
  fi
  local seen=" "
  for version in "${versions[@]}"; do
    [[ "$seen" == *" $version "* ]] && continue
    seen+="$version "
    systemctl reload "php${version}-fpm" || die "could not reload restored php${version}-fpm"
  done
  if command -v nginx >/dev/null 2>&1; then
    systemctl reload nginx || die "could not reload restored nginx"
  fi
}

restore_snapshot() {
  local snapshot_dir="$1"
  local release_target="${2:-}"
  [[ -f "$snapshot_dir/manifest.json" ]] || die "invalid snapshot: $snapshot_dir"
  say "stopping candidate panel processes"
  if command -v pm2 >/dev/null 2>&1; then
    pm2 stop meowbox-api meowbox-web meowbox-agent >/dev/null 2>&1 || true
  fi
  restore_db "$snapshot_dir"
  mb_restore_runtime_config "$snapshot_dir"
  restore_state_files "$snapshot_dir"
  if [[ -n "$release_target" ]]; then
    [[ -d "$release_target" ]] || die "snapshot release target no longer exists: $release_target"
    mb_atomic_switch_symlink "$release_target" "$PANEL_DIR/current"
    say "✓ current restored → $release_target"
  fi
  reload_managed_runtime "$snapshot_dir"
  if command -v pm2 >/dev/null 2>&1; then
    pm2 start "$PANEL_DIR/ecosystem.config.js" --update-env >/dev/null 2>&1 || \
      pm2 reload "$PANEL_DIR/ecosystem.config.js" --update-env >/dev/null 2>&1 || \
      die "could not restart old panel processes"
  fi
  MEOWBOX_RELEASE_LOCK_HELD=1 bash "$SCRIPT_DIR/healthcheck.sh" --strict || die "old release health check failed after restore"
}

quarantine_failed_candidate() {
  local candidate="$1"
  local transaction_id="$2"
  [[ -n "$candidate" && -d "$candidate" ]] || return 0
  local releases_root="$PANEL_DIR/releases"
  local candidate_name
  candidate_name="$(basename "$candidate")"
  [[ "$candidate_name" =~ ^[A-Za-z0-9._-]{1,160}$ ]] || die "unsafe candidate release name in journal"
  if ! python3 - "$releases_root" "$candidate" <<'PY'
import pathlib
import sys

root = pathlib.Path(sys.argv[1]).resolve()
candidate = pathlib.Path(sys.argv[2]).resolve()
if candidate.parent != root or not candidate.is_dir():
    raise SystemExit(3)
PY
  then
    # Before U07 the journal intentionally names the transaction staging
    # directory.  It is not a release target and must simply remain with the
    # transaction; never let that harmless path make DB/config recovery fail.
    return 0
  fi
  local destination="$TRANSACTION_ROOT/$transaction_id/failed-candidate-$candidate_name"
  [[ ! -e "$destination" ]] || die "failed candidate quarantine path already exists: $destination"
  mv -- "$candidate" "$destination"
  say "✓ failed candidate retained at $destination; target version can be staged again"
}

case "$mode" in
  precommit)
    transaction_id="$argument"
    if [[ -z "$transaction_id" ]]; then
      [[ -L "$TRANSACTION_ROOT/current" ]] || die "no active release transaction journal"
      transaction_id="$(basename "$(readlink -f "$TRANSACTION_ROOT/current")")"
    fi
    [[ "$transaction_id" =~ ^[A-Za-z0-9._-]{8,128}$ ]] || die "unsafe transaction id"
    journal="$TRANSACTION_ROOT/$transaction_id/journal.json"
    [[ -f "$journal" ]] || die "transaction journal not found: $transaction_id"
    [[ "$(journal_value "$journal" committed || true)" != "true" ]] || die "transaction is committed; automatic DB rollback is forbidden"
    snapshot_dir="$(journal_value "$journal" snapshotDir)"
    previous_release="$(journal_value "$journal" previousRelease || true)"
    candidate_release="$(journal_value "$journal" candidateRelease || true)"
    [[ -d "$snapshot_dir" ]] || die "transaction snapshot missing: $snapshot_dir"
    restore_snapshot "$snapshot_dir" "$previous_release"
    quarantine_failed_candidate "$candidate_release" "$transaction_id"
    journal_mark_rolled_back "$journal"
    say "OK: pre-commit transaction $transaction_id restored"
    ;;
  snapshot)
    [[ -n "$argument" ]] || die "Usage: rollback.sh snapshot <snapshot-name>"
    [[ "$argument" =~ ^[A-Za-z0-9._-]+$ ]] || die "unsafe snapshot name"
    snapshot_dir="$SNAP_ROOT/$argument"
    [[ -d "$snapshot_dir" ]] || die "snapshot not found: $snapshot_dir"
    # Explicit snapshot recovery is an operator action, not an automatic
    # after-commit rollback.  It still restores all coupled layers.
    release_target="$(mb_snapshot_json_value "$snapshot_dir" currentRelease 2>/dev/null || true)"
    restore_snapshot "$snapshot_dir" "$release_target"
    say "OK: explicit snapshot $argument restored"
    ;;
  release)
    die "release-only rollback is unsafe after schema migration; use a matched snapshot during explicit maintenance"
    ;;
  *)
    die "Usage: rollback.sh [precommit [transaction-id] | snapshot <snapshot-name>]"
    ;;
esac
