#!/usr/bin/env bash
# =============================================================================
# Transactional release updater.
#
# The only mutating path is the phase sequence below.  `--dry-run` stages a
# candidate in a temporary directory, runs the real migration path on an
# SQLite backup clone and proves hashes of live DB/config inputs are unchanged.
# =============================================================================
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANEL_DIR="${MEOWBOX_PANEL_DIR:-$(dirname "$SCRIPT_DIR")}"
[[ "$PANEL_DIR" == /* && -d "$PANEL_DIR" ]] || {
  echo "[update] ✗ MEOWBOX_PANEL_DIR must be an existing absolute directory" >&2
  exit 1
}
PANEL_DIR="$(cd "$PANEL_DIR" && pwd -P)"
# shellcheck source=tools/release-lib.sh
source "$SCRIPT_DIR/release-lib.sh"
# shellcheck source=tools/release-transaction-policy.sh
source "$SCRIPT_DIR/release-transaction-policy.sh"

STATE_DIR="${MEOWBOX_STATE_DIR:-$PANEL_DIR/state}"
[[ -d "$STATE_DIR" ]] || STATE_DIR="$PANEL_DIR"
DATA_DIR="$STATE_DIR/data"
[[ -d "$DATA_DIR" ]] || DATA_DIR="$PANEL_DIR/data"
DB_FILE="${MEOWBOX_DATABASE_FILE:-$DATA_DIR/meowbox.db}"
RELEASES_DIR="$PANEL_DIR/releases"
TRANSACTION_ROOT="$DATA_DIR/migrations/release-transactions"
REPORT_ROOT="$DATA_DIR/migrations/reports"
LOCK_FILE="${MEOWBOX_RELEASE_LOCK_FILE:-$DATA_DIR/migrations/release-update.lock}"
GITHUB_REPO="${GITHUB_REPO:-gvozdb/meowbox}"
QUIESCE_HOOK="${MEOWBOX_QUIESCE_HOOK:-}"
RUNTIME_RENDER_HOOK="${MEOWBOX_RUNTIME_RENDER_HOOK:-}"
RUNTIME_VALIDATE_HOOK="${MEOWBOX_RUNTIME_VALIDATE_HOOK:-}"
RUNTIME_APPLY_HOOK="${MEOWBOX_RUNTIME_APPLY_HOOK:-}"
MAPPER_EVIDENCE_HOOK="${MEOWBOX_MAPPER_EVIDENCE_HOOK:-}"
AGENT_HEALTH_HOOK="${MEOWBOX_AGENT_HEALTH_HOOK:-}"
REPRESENTATIVE_READ_HOOK="${MEOWBOX_REPRESENTATIVE_READ_HOOK:-}"
LEGACY_BRIDGE_SOURCE_DIR="${MEOWBOX_LEGACY_BRIDGE_SOURCE_DIR:-}"
LEGACY_BRIDGE_RETIRED_SOURCE=""
QUIESCE_HOOK_WAS_CONFIGURED=false
AGENT_HEALTH_HOOK_WAS_CONFIGURED=false
REPRESENTATIVE_READ_HOOK_WAS_CONFIGURED=false
[[ -n "$QUIESCE_HOOK" ]] && QUIESCE_HOOK_WAS_CONFIGURED=true
[[ -n "$AGENT_HEALTH_HOOK" ]] && AGENT_HEALTH_HOOK_WAS_CONFIGURED=true
[[ -n "$REPRESENTATIVE_READ_HOOK" ]] && REPRESENTATIVE_READ_HOOK_WAS_CONFIGURED=true

TARGET=""
DRY_RUN=false
CHECK_ONLY=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --check) CHECK_ONLY=true; shift ;;
    --triggered-by=*) shift ;;
    v*) TARGET="$1"; shift ;;
    *)
      echo "Usage: update.sh [vX.Y.Z] [--dry-run] [--check]" >&2
      exit 2
      ;;
  esac
done

say() { echo "[update] $*"; }
stage() { echo "[stage:$1] $2"; }
die() { echo "[update] ✗ $*" >&2; exit 1; }

if [[ -f "$PANEL_DIR/.dev-mode" ]]; then
  die "release update is unavailable on a dev workspace; use make dev"
fi
for command in curl tar sha256sum node npm npx python3 flock pm2 nginx systemctl sqlite3 df du stat; do mb_require_command "$command" || die "missing dependency"; done
[[ -f "$DB_FILE" ]] || die "panel SQLite database is missing: $DB_FILE"
ENV_FILE="$STATE_DIR/.env"
[[ -f "$ENV_FILE" ]] || ENV_FILE="$PANEL_DIR/.env"
if [[ -z "${MEOWBOX_QUIESCE_TIMEOUT:-}" ]]; then
  MEOWBOX_QUIESCE_TIMEOUT="$(mb_read_env_value "$ENV_FILE" MEOWBOX_QUIESCE_TIMEOUT || true)"
fi
MEOWBOX_QUIESCE_TIMEOUT="${MEOWBOX_QUIESCE_TIMEOUT:-120}"
[[ "$MEOWBOX_QUIESCE_TIMEOUT" =~ ^[0-9]+$ ]] &&
  (( MEOWBOX_QUIESCE_TIMEOUT >= 1 && MEOWBOX_QUIESCE_TIMEOUT <= 1800 )) ||
  die "MEOWBOX_QUIESCE_TIMEOUT must be an integer between 1 and 1800"
if [[ -z "${MEOWBOX_RELEASE_MIN_FREE_KB:-}" ]]; then
  MEOWBOX_RELEASE_MIN_FREE_KB="$(mb_read_env_value "$ENV_FILE" MEOWBOX_RELEASE_MIN_FREE_KB || true)"
fi
MEOWBOX_RELEASE_MIN_FREE_KB="${MEOWBOX_RELEASE_MIN_FREE_KB:-524288}"
# A dry-run must not initialise release state just by being invoked.  The lock
# itself is intentionally pre-created by install/bootstrap so every updater,
# runner and recovery process contends on exactly the same inode.
if $DRY_RUN || $CHECK_ONLY; then
  [[ -d "$(dirname "$LOCK_FILE")" && -e "$LOCK_FILE" ]] || \
    die "release flock is not initialised; complete installation before a read-only check/dry-run"
else
  mkdir -p "$TRANSACTION_ROOT" "$REPORT_ROOT" "$(dirname "$LOCK_FILE")" "$RELEASES_DIR"
  chmod 0700 "$TRANSACTION_ROOT" "$REPORT_ROOT" || true
fi

# A descriptor-based flock replaces the stale PID-file scheme.  The same path
# is passed to runner children; direct runner calls re-exec under this lock.
exec 9>>"$LOCK_FILE"
flock -n 9 || die "another updater, system migration or startup repair owns $LOCK_FILE"
export MEOWBOX_RELEASE_LOCK_HELD=1
export MEOWBOX_RELEASE_LOCK_FILE="$LOCK_FILE"

CURRENT_RELEASE=""
CURRENT_VERSION="unknown"
if [[ -L "$PANEL_DIR/current" ]]; then
  CURRENT_RELEASE="$(readlink -f "$PANEL_DIR/current")"
  [[ -d "$CURRENT_RELEASE" ]] || die "current points to a missing release"
  [[ -f "$CURRENT_RELEASE/VERSION" ]] && CURRENT_VERSION="$(tr -d '[:space:]' < "$CURRENT_RELEASE/VERSION")"
else
  die "legacy layout has no current release symlink; migrate layout explicitly before transactional update"
fi

fetch_latest() {
  local auth=()
  [[ -n "${GITHUB_TOKEN:-}" ]] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
  curl -fsSL "${auth[@]}" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$GITHUB_REPO/releases/latest" |
    python3 -c 'import json,sys; print(json.load(sys.stdin).get("tag_name", ""))'
}

if [[ -z "$TARGET" ]]; then
  if [[ -n "${MEOWBOX_UPDATE_CANDIDATE_DIR:-}" ]]; then
    TARGET="${MEOWBOX_UPDATE_CANDIDATE_VERSION:-candidate-$(date -u +%Y%m%d%H%M%S)}"
  else
    TARGET="$(fetch_latest || true)"
  fi
fi
[[ "$TARGET" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || die "invalid target version"
say "current=$CURRENT_VERSION target=$TARGET"

validate_legacy_bridge_source() {
  local enabled="${MEOWBOX_LEGACY_PANEL_BRIDGE:-}"
  if [[ -z "$LEGACY_BRIDGE_SOURCE_DIR" && -z "$enabled" ]]; then
    return 0
  fi
  [[ "$enabled" == "1" && -n "$LEGACY_BRIDGE_SOURCE_DIR" ]] || \
    die "legacy bridge requires both MEOWBOX_LEGACY_PANEL_BRIDGE=1 and an explicit source directory"
  [[ -n "${MEOWBOX_UPDATE_CANDIDATE_DIR:-}" ]] || \
    die "legacy bridge requires a local verified candidate directory"
  [[ "$LEGACY_BRIDGE_SOURCE_DIR" == /* && -d "$LEGACY_BRIDGE_SOURCE_DIR" && ! -L "$LEGACY_BRIDGE_SOURCE_DIR" ]] || \
    die "legacy bridge source must be an existing non-symlink absolute directory"

  local source_real candidate_real expected_real source_version
  source_real="$(cd "$LEGACY_BRIDGE_SOURCE_DIR" && pwd -P)"
  candidate_real="$(cd "$MEOWBOX_UPDATE_CANDIDATE_DIR" && pwd -P)"
  expected_real="$(readlink -f "$RELEASES_DIR/$TARGET")"
  [[ "$source_real" == "$candidate_real" && "$source_real" == "$expected_real" ]] || \
    die "legacy bridge source must be the verified releases/$TARGET candidate"
  [[ -f "$source_real/VERSION" ]] || die "legacy bridge source has no VERSION"
  source_version="$(tr -d '[:space:]' < "$source_real/VERSION")"
  [[ "$source_version" == "$TARGET" ]] || die "legacy bridge source VERSION does not match target"
  LEGACY_BRIDGE_SOURCE_DIR="$source_real"
}

validate_legacy_bridge_source

if $CHECK_ONLY; then
  if [[ "$TARGET" == "$CURRENT_VERSION" ]]; then say "already current"; else say "update available: $CURRENT_VERSION → $TARGET"; fi
  exit 0
fi
if [[ "$TARGET" == "$CURRENT_VERSION" ]]; then
  say "already current; second run is a no-op"
  exit 0
fi

TRANSACTION_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}"
if $DRY_RUN; then
  TX_DIR="$(mktemp -d "${TMPDIR:-/tmp}/meowbox-release-dry-run.XXXXXX")"
else
  TX_DIR="$TRANSACTION_ROOT/$TRANSACTION_ID"
  [[ ! -e "$TX_DIR" ]] || die "transaction directory already exists"
  mkdir -p "$TX_DIR"
  chmod 0700 "$TX_DIR"
  mb_atomic_switch_symlink "$TX_DIR" "$TRANSACTION_ROOT/current"
fi
CANDIDATE_DIR="$TX_DIR/stage/release"
DRY_DIR="$TX_DIR/dry-run"
RUNTIME_STAGE="$TX_DIR/runtime-stage"
RUNTIME_MANIFEST="$TX_DIR/runtime-manifest.json"
HTTP_PROBE_BASELINE="$TX_DIR/http-probe-baseline.json"
JOURNAL="$TX_DIR/journal.json"
SNAPSHOT_DIR=""
ROLLBACK_ARMED=false
COMMITTED=false
REPORT_JSON="$REPORT_ROOT/$TRANSACTION_ID.json"
REPORT_TEXT="$REPORT_ROOT/$TRANSACTION_ID.txt"
if $DRY_RUN; then
  # Keep only redacted reports outside the clone tree: the clone itself is
  # removed on exit because it can contain encrypted panel records.  A
  # read-only rehearsal must not create state/data report directories or alter
  # durable release metadata.
  DRY_REPORT_ROOT="${MEOWBOX_DRY_RUN_REPORT_DIR:-${TMPDIR:-/tmp}/meowbox-release-reports}"
  mkdir -p "$DRY_REPORT_ROOT"
  chmod 0700 "$DRY_REPORT_ROOT" || true
  REPORT_JSON="$DRY_REPORT_ROOT/$TRANSACTION_ID.json"
  REPORT_TEXT="$DRY_REPORT_ROOT/$TRANSACTION_ID.txt"
fi

journal_update() {
  $DRY_RUN && return 0
  local phase="$1"
  local message="$2"
  local committed="${3:-false}"
  export JOURNAL_PHASE="$phase" JOURNAL_MESSAGE="$message" JOURNAL_COMMITTED="$committed"
  export JOURNAL_TARGET="$TARGET" JOURNAL_CURRENT="$CURRENT_RELEASE" JOURNAL_TX="$TRANSACTION_ID"
  export JOURNAL_SNAPSHOT="$SNAPSHOT_DIR" JOURNAL_RUNTIME_MANIFEST="$RUNTIME_MANIFEST" JOURNAL_CANDIDATE="$CANDIDATE_DIR"
  python3 -c '
import json, os, pathlib, sys
from datetime import datetime, timezone
target = pathlib.Path(sys.argv[1])
try:
    payload = json.loads(target.read_text(encoding="utf-8"))
except FileNotFoundError:
    payload = {"version": 1, "transactionId": os.environ["JOURNAL_TX"], "createdAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")}
payload.update({
    "phase": os.environ["JOURNAL_PHASE"],
    "message": os.environ["JOURNAL_MESSAGE"],
    "targetVersion": os.environ["JOURNAL_TARGET"],
    "previousRelease": os.environ["JOURNAL_CURRENT"],
    "snapshotDir": os.environ["JOURNAL_SNAPSHOT"] or None,
    "runtimeManifest": os.environ["JOURNAL_RUNTIME_MANIFEST"],
    "candidateRelease": os.environ["JOURNAL_CANDIDATE"] or None,
    "committed": os.environ["JOURNAL_COMMITTED"] == "true",
    "updatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
})
print(json.dumps(payload, indent=2, sort_keys=True))
' "$JOURNAL" | mb_atomic_write_stdin "$JOURNAL"
}

# The journal is the rollback authority, not the process-local COMMITTED flag.
# Atomic replacement gives a hard kill either the old uncommitted record or
# the new committed record; EXIT recovery must honor that durable boundary.
journal_commit_state() {
  [[ -f "$JOURNAL" ]] || {
    printf '%s\n' absent
    return 0
  }
  python3 - "$JOURNAL" <<'PY'
import json
import sys

try:
    value = json.load(open(sys.argv[1], encoding="utf-8")).get("committed")
except Exception:
    print("unknown")
    raise SystemExit(0)
print("committed" if value is True else "uncommitted" if value is False else "unknown")
PY
}

write_report() {
  local result="$1"
  local detail="$2"
  local db_hash="${3:-unknown}"
  local config_hash="${4:-unknown}"
  export REPORT_RESULT="$result" REPORT_DETAIL="$detail" REPORT_TARGET="$TARGET" REPORT_CURRENT="$CURRENT_VERSION"
  export REPORT_DB_HASH="$db_hash" REPORT_CONFIG_HASH="$config_hash" REPORT_TX="$TRANSACTION_ID"
  python3 -c '
import json, os
from datetime import datetime, timezone
payload = {
  "version": 1,
  "transactionId": os.environ["REPORT_TX"],
  "result": os.environ["REPORT_RESULT"],
  "detail": os.environ["REPORT_DETAIL"],
  "currentVersion": os.environ["REPORT_CURRENT"],
  "targetVersion": os.environ["REPORT_TARGET"],
  "liveInputHash": {"database": os.environ["REPORT_DB_HASH"], "managedRuntime": os.environ["REPORT_CONFIG_HASH"]},
  "createdAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
}
print(json.dumps(payload, indent=2, sort_keys=True))
' | mb_atomic_write_stdin "$REPORT_JSON"
  python3 - "$REPORT_JSON" <<'PY' | mb_atomic_write_stdin "$REPORT_TEXT"
import json
import sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
print(f"release dry-run/update report: {data['result']}")
print(f"transaction: {data['transactionId']}")
print(f"current → target: {data['currentVersion']} → {data['targetVersion']}")
print(f"detail: {data['detail']}")
print(f"live database hash: {data['liveInputHash']['database']}")
print(f"managed runtime hash: {data['liveInputHash']['managedRuntime']}")
PY
}

on_exit() {
  local status=$?
  trap - EXIT
  if [[ $status -ne 0 ]]; then
    write_report fail "release transaction stopped before completion; inspect retained redacted journal and candidate logs" \
      "${DRY_RUN_DB_HASH:-unknown}" "${DRY_RUN_CONFIG_HASH:-unknown}" || true
    local durable_commit_state
    durable_commit_state="$(journal_commit_state)"
    local failure_action
    failure_action="$(
      mb_update_failure_action \
        "$ROLLBACK_ARMED" \
        "$COMMITTED" \
        "$durable_commit_state"
    )"
    if [[ "$failure_action" == "rollback" ]]; then
      echo "[update] pre-commit failure; restoring SQLite, managed runtime and previous release" >&2
      if MEOWBOX_RELEASE_LOCK_HELD=1 MEOWBOX_RELEASE_LOCK_FILE="$LOCK_FILE" \
        bash "$SCRIPT_DIR/rollback.sh" precommit "$TRANSACTION_ID"; then
        local resume_hook="$QUIESCE_HOOK"
        local resume_candidate="$CANDIDATE_DIR"
        if [[ ! -x "$resume_hook" && ! ( -f "$resume_hook" && "$resume_hook" == *.js ) ]]; then
          resume_candidate="$TX_DIR/failed-candidate-$TARGET"
          resume_hook="$resume_candidate/migrations/dist/quiesce.js"
        fi
        run_hook "$resume_hook" resume --transaction "$TRANSACTION_ID" \
          --candidate "$resume_candidate" --database "$DB_FILE" || \
          echo "[update] old release restored but maintenance gate resume needs operator repair" >&2
      else
        echo "[update] rollback failed; preserve transaction $TRANSACTION_ID for operator recovery" >&2
      fi
    elif [[ "$failure_action" == "forward-repair" ]]; then
      journal_update forward-repair "post-commit failure; forward repair required" true || true
      echo "[update] post-commit failure; automatic DB rollback is forbidden" >&2
      if ! post_commit_forward_repair; then
        echo "[update] post-commit forward repair did not complete; keep the new release serving and repair explicitly" >&2
      fi
    elif [[ "$failure_action" == "manual" ]]; then
      # A corrupt/indeterminate journal cannot prove that the durable
      # boundary was not crossed. Preserve it for explicit recovery rather
      # than restoring an old SQLite image blindly.
      echo "[update] journal commit state is indeterminate; automatic DB rollback is forbidden" >&2
    fi
  fi
  if $DRY_RUN; then
    rm -rf -- "$TX_DIR"
  fi
  exit "$status"
}
trap on_exit EXIT

run_hook() {
  local hook="$1"
  shift
  [[ -n "$hook" ]] || die "required integration hook is not configured"
  if [[ -x "$hook" ]]; then
    "$hook" "$@"
  elif [[ -f "$hook" && "$hook" == *.js ]]; then
    node "$hook" "$@"
  else
    die "integration hook is not executable/Node script: $hook"
  fi
}

resolve_release_hook() {
  local configured="$1"
  local fallback_name="$2"
  local label="$3"
  local resolved="$configured"
  [[ -n "$resolved" ]] || resolved="$CANDIDATE_DIR/migrations/dist/$fallback_name"
  [[ -f "$resolved" || -x "$resolved" ]] || die "$label integration hook is required"
  printf '%s\n' "$resolved"
}

prepare_release_health_hooks() {
  QUIESCE_HOOK="$(resolve_release_hook "$QUIESCE_HOOK" quiesce.js "quiesce")"
  AGENT_HEALTH_HOOK="$(resolve_release_hook "$AGENT_HEALTH_HOOK" agent-health.js "agent health")"
  REPRESENTATIVE_READ_HOOK="$(resolve_release_hook "$REPRESENTATIVE_READ_HOOK" representative-read.js "representative API-read")"
  export MEOWBOX_QUIESCE_HOOK="$QUIESCE_HOOK"
  export MEOWBOX_AGENT_HEALTH_HOOK="$AGENT_HEALTH_HOOK"
  export MEOWBOX_REPRESENTATIVE_READ_HOOK="$REPRESENTATIVE_READ_HOOK"
  # These checks are part of the dry-run contract.  They may inspect the
  # currently serving agent/API, but must not mutate panel state or runtime.
  run_hook "$AGENT_HEALTH_HOOK" check --mode dry-run --release-dir "$CANDIDATE_DIR" --database "$DB_FILE"
  run_hook "$REPRESENTATIVE_READ_HOOK" check --mode dry-run --release-dir "$CANDIDATE_DIR" --database "$DB_FILE"
}

refresh_candidate_health_hook_paths() {
  if ! $QUIESCE_HOOK_WAS_CONFIGURED; then
    QUIESCE_HOOK="$CANDIDATE_DIR/migrations/dist/quiesce.js"
  fi
  if ! $AGENT_HEALTH_HOOK_WAS_CONFIGURED; then
    AGENT_HEALTH_HOOK="$CANDIDATE_DIR/migrations/dist/agent-health.js"
  fi
  if ! $REPRESENTATIVE_READ_HOOK_WAS_CONFIGURED; then
    REPRESENTATIVE_READ_HOOK="$CANDIDATE_DIR/migrations/dist/representative-read.js"
  fi
  export MEOWBOX_QUIESCE_HOOK="$QUIESCE_HOOK"
  export MEOWBOX_AGENT_HEALTH_HOOK="$AGENT_HEALTH_HOOK"
  export MEOWBOX_REPRESENTATIVE_READ_HOOK="$REPRESENTATIVE_READ_HOOK"
}

check_release_capacity() {
  local filesystem_path="$1"
  local database_bytes candidate_kb available_kb required_kb reserve_kb
  database_bytes="$(stat -c '%s' "$DB_FILE")"
  candidate_kb="$(du -sk --apparent-size "$CANDIDATE_DIR" | awk '{print $1}')"
  available_kb="$(df -Pk "$filesystem_path" | awk 'NR == 2 { print $4 }')"
  reserve_kb="$MEOWBOX_RELEASE_MIN_FREE_KB"
  [[ "$reserve_kb" =~ ^[0-9]+$ ]] || die "MEOWBOX_RELEASE_MIN_FREE_KB must be a non-negative integer"
  required_kb=$(( (database_bytes + 1023) / 1024 + candidate_kb + reserve_kb ))
  [[ "$available_kb" =~ ^[0-9]+$ ]] || die "cannot determine free disk space for $filesystem_path"
  (( available_kb >= required_kb )) || die "insufficient free space for clone/snapshot/candidate on $filesystem_path (need ${required_kb}KiB, have ${available_kb}KiB)"
}

preflight_serving_health() {
  nginx -t >/dev/null || die "current Nginx configuration does not validate"
  systemctl is-active --quiet nginx || die "Nginx service is not active"
  bash "$SCRIPT_DIR/healthcheck.sh" --strict --release-dir "$CURRENT_RELEASE"
}

runtime_schema_required() {
  python3 - "$1" <<'PY'
import sqlite3
import sys
import urllib.parse
db = sqlite3.connect("file:" + urllib.parse.quote(sys.argv[1], safe="/") + "?mode=ro", uri=True)
try:
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "site_domains" not in tables:
        raise SystemExit(1)
    columns = {row[1] for row in db.execute("PRAGMA table_info('site_domains')")}
    raise SystemExit(0 if {"preset", "runtime_key", "app_status"}.issubset(columns) else 1)
finally:
    db.close()
PY
}

write_noop_runtime_manifest() {
  python3 -c 'import json; print(json.dumps({"version": 1, "requiresRuntimeCutover": False, "artifacts": [], "phpServices": [], "socketPaths": [], "httpProbes": []}, indent=2, sort_keys=True))' | mb_atomic_write_stdin "$RUNTIME_MANIFEST"
}

validate_runtime_manifest() {
  local manifest="$1"
  local stage_root="$2"
  python3 - "$manifest" "$stage_root" <<'PY'
import hashlib
import json
import os
import pathlib
import re
import sys
from urllib.parse import urlparse

manifest_path, stage_root = map(pathlib.Path, sys.argv[1:])
root = stage_root.resolve()
with manifest_path.open(encoding="utf-8") as handle:
    data = json.load(handle)
if data.get("version") != 1 or type(data.get("requiresRuntimeCutover")) is not bool or not isinstance(data.get("artifacts"), list):
    raise SystemExit("invalid runtime manifest envelope")
if data["artifacts"] and not data["requiresRuntimeCutover"]:
    raise SystemExit("runtime manifest with artifacts must require a runtime cutover")
seen = set()
def allowed(target):
    return (
        target == os.path.normpath(target) and target.startswith("/") and "\x00" not in target and (
            target.startswith("/etc/nginx/meowbox/") or
            re.fullmatch(r"/etc/nginx/sites-(?:available|enabled)/[a-z][a-z0-9_-]{0,63}\.conf", target) is not None or
            target == "/etc/nginx/conf.d/meowbox-zones.conf" or
            re.fullmatch(r"/etc/php/\d+\.\d+/fpm/pool\.d/[A-Za-z0-9._-]+\.conf", target) is not None or
            re.fullmatch(r"/etc/logrotate\.d/meowbox[A-Za-z0-9._-]*", target) is not None
        )
    )
for artifact in data["artifacts"]:
    if not isinstance(artifact, dict): raise SystemExit("invalid runtime artifact")
    action, target = artifact.get("action"), artifact.get("target")
    if action not in {"create", "replace", "delete"} or not isinstance(target, str) or not allowed(target) or target in seen:
        raise SystemExit("unsafe/duplicate runtime artifact")
    if "postCommitOnly" in artifact and type(artifact["postCommitOnly"]) is not bool:
        raise SystemExit("postCommitOnly must be boolean")
    if artifact.get("postCommitOnly") is True and action != "delete":
        raise SystemExit("postCommitOnly is allowed only for delete artifacts")
    for field, maximum in (("mode", 0o7777), ("uid", 2**31 - 1), ("gid", 2**31 - 1)):
        if field in artifact and (type(artifact[field]) is not int or artifact[field] < 0 or artifact[field] > maximum):
            raise SystemExit(f"invalid runtime artifact {field}")
    has_uid, has_gid = "uid" in artifact, "gid" in artifact
    if has_uid != has_gid:
        raise SystemExit("runtime artifact uid/gid must be declared together")
    if action == "delete" and any(field in artifact for field in ("mode", "uid", "gid")):
        raise SystemExit("delete artifact cannot declare file metadata")
    if action == "create" and ("mode" not in artifact or not has_uid or not has_gid):
        raise SystemExit("create artifact requires mode, uid and gid")
    seen.add(target)
    if action == "delete":
        if "stagedPath" in artifact or "sha256" in artifact: raise SystemExit("delete artifact cannot carry staged bytes")
        continue
    staged, digest = artifact.get("stagedPath"), artifact.get("sha256")
    if not isinstance(staged, str) or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise SystemExit("write artifact requires stagedPath + sha256")
    candidate = pathlib.Path(staged).resolve()
    if candidate == root or root not in candidate.parents or not candidate.is_file():
        raise SystemExit("staged artifact escapes/missing from runtime stage")
    content = candidate.read_bytes()
    if hashlib.sha256(content).hexdigest() != digest:
        raise SystemExit("staged artifact checksum mismatch")
    if b"\0" in content: raise SystemExit("staged artifact contains NUL")
services = data.get("phpServices", [])
if not isinstance(services, list) or len(set(services)) != len(services): raise SystemExit("duplicate/invalid PHP services")
for service in services:
    if not isinstance(service, str) or not re.fullmatch(r"php\d+\.\d+-fpm", service): raise SystemExit("unsafe PHP service")
sockets = data.get("socketPaths", [])
if not isinstance(sockets, list) or len(set(sockets)) != len(sockets): raise SystemExit("duplicate/invalid PHP sockets")
for socket in sockets:
    if not isinstance(socket, str) or not re.fullmatch(r"/var/run/php/php\d+\.\d+-fpm-[a-z][a-z0-9._-]{0,63}\.sock", socket): raise SystemExit("unsafe PHP socket")
probes = data.get("httpProbes", [])
if not isinstance(probes, list): raise SystemExit("invalid HTTP probe list")
probe_keys = set()
for probe in probes:
    if not isinstance(probe, dict) or not isinstance(probe.get("url"), str): raise SystemExit("invalid HTTP probe")
    parsed = urlparse(probe["url"])
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or re.search(r"[\x00-\x1f\x7f]", probe["url"]):
        raise SystemExit("unsafe HTTP probe URL")
    statuses = probe.get("expectedStatus", [200, 301, 302])
    if not isinstance(statuses, list) or not statuses or any(type(status) is not int or status < 100 or status > 599 for status in statuses):
        raise SystemExit("invalid HTTP probe expectedStatus")
    key = (probe["url"], tuple(sorted(set(statuses))))
    if key in probe_keys: raise SystemExit("duplicate HTTP probe")
    probe_keys.add(key)
validations = data.get("validations", [])
if not isinstance(validations, list) or any(not isinstance(value, str) or not value or len(value) > 160 for value in validations):
    raise SystemExit("invalid runtime validation labels")
PY
}

runtime_plan_hash() {
  python3 - "$1" <<'PY'
import hashlib
import json
import sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
items = []
for item in data.get("artifacts", []):
    items.append({key: item.get(key) for key in ("action", "target", "sha256", "mode", "uid", "gid", "postCommitOnly")})
payload = {"requiresRuntimeCutover": data.get("requiresRuntimeCutover"), "artifacts": sorted(items, key=lambda item: item["target"]), "phpServices": sorted(data.get("phpServices", [])), "socketPaths": sorted(data.get("socketPaths", [])), "httpProbes": sorted(data.get("httpProbes", []), key=lambda item: item.get("url", "")), "validations": sorted(data.get("validations", []))}
print(hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest())
PY
}

prepare_runtime() {
  local database="$1"
  local mode="$2"
  rm -rf -- "$RUNTIME_STAGE"
  mkdir -p "$RUNTIME_STAGE"
  local renderer="$RUNTIME_RENDER_HOOK"
  [[ -n "$renderer" ]] || renderer="$CANDIDATE_DIR/migrations/dist/runtime-renderer.js"
  if [[ -f "$renderer" || -x "$renderer" ]]; then
    run_hook "$renderer" --mode "$mode" --db "$database" --stage "$RUNTIME_STAGE" --manifest "$RUNTIME_MANIFEST"
  elif runtime_schema_required "$database"; then
    die "domain runtime schema requires a staged renderer hook (MEOWBOX_RUNTIME_RENDER_HOOK)"
  else
    write_noop_runtime_manifest
  fi
  validate_runtime_manifest "$RUNTIME_MANIFEST" "$RUNTIME_STAGE"
  local changes
  changes="$(python3 - "$RUNTIME_MANIFEST" <<'PY'
import json,sys
print(len(json.load(open(sys.argv[1], encoding="utf-8")).get("artifacts", [])))
PY
)"
  local validator="$RUNTIME_VALIDATE_HOOK"
  [[ -n "$validator" ]] || validator="$CANDIDATE_DIR/migrations/dist/runtime-validator.js"
  # A final domain schema still needs an all-config/service/resource-envelope
  # validation even when a renderer reports no filesystem diff.
  if [[ "$changes" != "0" ]] || runtime_schema_required "$database"; then
    [[ -f "$validator" || -x "$validator" ]] || die "runtime artifacts require staged PHP-FPM/Nginx validation hook"
    run_hook "$validator" --mode "$mode" --db "$database" --stage "$RUNTIME_STAGE" --manifest "$RUNTIME_MANIFEST"
  fi
}

stage_candidate() {
  stage U01-stage "download, verify and stage candidate release"
  mkdir -p "$(dirname "$CANDIDATE_DIR")"
  if [[ -n "${MEOWBOX_UPDATE_CANDIDATE_DIR:-}" ]]; then
    [[ -d "$MEOWBOX_UPDATE_CANDIDATE_DIR" ]] || die "candidate directory does not exist"
    cp -a -- "$MEOWBOX_UPDATE_CANDIDATE_DIR/." "$CANDIDATE_DIR"
  else
    local download_dir="$TX_DIR/download"
    mkdir -p "$download_dir"
    local tarball="$download_dir/meowbox-$TARGET.tar.gz"
    local sums="$download_dir/SHA256SUMS"
    local auth=()
    [[ -n "${GITHUB_TOKEN:-}" ]] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
    curl -fsSL "${auth[@]}" "https://github.com/$GITHUB_REPO/releases/download/$TARGET/meowbox-$TARGET.tar.gz" -o "$tarball"
    curl -fsSL "${auth[@]}" "https://github.com/$GITHUB_REPO/releases/download/$TARGET/SHA256SUMS" -o "$sums"
    (cd "$download_dir" && sha256sum -c "$(basename "$sums")") || die "candidate checksum verification failed"
    mkdir -p "$CANDIDATE_DIR"
    tar -xzf "$tarball" -C "$CANDIDATE_DIR" --strip-components=1 --no-same-owner --no-same-permissions
  fi
  for required in \
    api/prisma/schema.prisma \
    agent/dist/nginx/templates.js \
    agent/dist/nginx/nginx.manager.js \
    agent/dist/nginx/zones-template.js \
    agent/dist/php/pool-template.js \
    agent/dist/runtime/logrotate-template.js \
    migrations/dist/runner.js \
    migrations/dist/release-cli.js \
    migrations/dist/runtime-evidence.js \
    migrations/dist/runtime-renderer.js \
    migrations/dist/runtime-validator.js \
    migrations/dist/runtime-apply.js \
    migrations/dist/quiesce.js \
    migrations/dist/agent-health.js \
    migrations/dist/representative-read.js \
    migrations/release/supported-baselines.json \
    VERSION
  do
    [[ -f "$CANDIDATE_DIR/$required" ]] || die "candidate is missing required release artifact: $required"
  done
  find "$CANDIDATE_DIR/api/prisma/migrations" -type f -name migration.sql -print -quit | grep -q . || die "candidate contains no Prisma migration SQL"
  find "$CANDIDATE_DIR/migrations/dist/system" -type f -name '*domain-runtime-release.js' -print -quit | grep -q . || die "candidate contains no compiled domain-runtime system migration"
  ln -sfnT "$STATE_DIR/data" "$CANDIDATE_DIR/data"
  ln -sfnT "$STATE_DIR/.env" "$CANDIDATE_DIR/.env"
  for package in api agent web; do
    if [[ -f "$CANDIDATE_DIR/$package/package-lock.json" ]]; then
      (cd "$CANDIDATE_DIR/$package" && npm ci --omit=dev --no-audit --no-fund)
    fi
  done
  for package in api agent web migrations; do
    mkdir -p "$CANDIDATE_DIR/$package/node_modules/@meowbox"
    ln -sfn "../../../shared" "$CANDIDATE_DIR/$package/node_modules/@meowbox/shared"
  done
  mkdir -p "$CANDIDATE_DIR/migrations/node_modules/@prisma"
  ln -sfn "../../../api/node_modules/@prisma/client" "$CANDIDATE_DIR/migrations/node_modules/@prisma/client"
  (cd "$CANDIDATE_DIR/api" && DATABASE_URL="file:$DB_FILE" npx prisma generate)
  journal_update stage "candidate staged and package contract verified"
}

release_cli() {
  node "$CANDIDATE_DIR/migrations/dist/release-cli.js" "$@"
}

prisma_deploy() {
  local database="$1"
  (cd "$CANDIDATE_DIR/api" && DATABASE_URL="file:$database" npx prisma migrate deploy --schema prisma/schema.prisma)
}

source_hash_inputs() {
  # SQLite SHM is transient lock/index state and changes on read-only access.
  # Filesystem timestamps are also not data. Main + WAL + rollback-journal
  # content and presence are the durable database input.
  mb_hash_file_contents "$DB_FILE" "$DB_FILE-wal" "$DB_FILE-journal"
}

source_file_fingerprint() {
  mb_sqlite_file_fingerprint "$DB_FILE"
}

managed_runtime_hash() {
  local paths_file="$1"
  mb_hash_path_file "$paths_file"
}

capture_http_probe_baseline() {
  local manifest="$1"
  local output="$2"
  python3 - "$manifest" <<'PY' | mb_atomic_write_stdin "$output"
import json
import re
import subprocess
import sys
import time
from urllib.parse import urlparse

with open(sys.argv[1], encoding="utf-8") as handle:
    manifest = json.load(handle)

urls = []
for probe in manifest.get("httpProbes", []):
    if not isinstance(probe, dict) or not isinstance(probe.get("url"), str):
        raise SystemExit("invalid HTTP probe in runtime manifest")
    url = probe["url"]
    parsed = urlparse(url)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or re.search(r"[\x00-\x1f\x7f]", url)
    ):
        raise SystemExit("unsafe HTTP probe URL")
    urls.append(url)

if len(urls) != len(set(urls)):
    raise SystemExit("duplicate HTTP probe URL")

probes = []
for url in sorted(urls):
    status = None
    for attempt in range(3):
        result = subprocess.run(
            ["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", url],
            check=False,
            capture_output=True,
            text=True,
            timeout=7,
        )
        value = result.stdout.strip()
        if re.fullmatch(r"\d{3}", value) and value != "000":
            code = int(value)
            if 100 <= code <= 599:
                status = code
                break
        if attempt < 2:
            time.sleep(0.5)
    if status is None:
        # Transport failures are a valid pre-existing state. Record them so
        # verification can allow only the same failure or a healthy response.
        status = 0
    probes.append({"url": url, "status": status})

print(json.dumps({"version": 1, "probes": probes}, indent=2, sort_keys=True))
PY
  say "captured HTTP baseline for $(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1], encoding="utf-8"))["probes"]))' "$output") domain probe(s)"
}

baseline_decision() {
  python3 - "$1" <<'PY'
import json
import sys

payload = json.load(open(sys.argv[1], encoding="utf-8"))
value = payload.get("assessment", {}).get("decision")
if value not in {"fresh", "baseline-required", "already-tracked"}:
    raise SystemExit("baseline report has no safe decision")
print(value)
PY
}

baseline_mapping_required() {
  python3 - "$1" <<'PY'
import json
import sys

value = json.load(open(sys.argv[1], encoding="utf-8")).get("assessment", {}).get("legacyMappingRequired")
if type(value) is not bool:
    raise SystemExit("baseline report has no explicit legacy mapping decision")
print("true" if value else "false")
PY
}

map_report_value() {
  local report="$1"
  local field="$2"
  python3 - "$report" "$field" <<'PY'
import json
import re
import sys

payload = json.load(open(sys.argv[1], encoding="utf-8"))
value = payload.get("envelope", {}).get(sys.argv[2])
if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
    raise SystemExit("map report has no valid envelope fingerprint")
print(value)
PY
}

write_baseline_counts_from_map() {
  local report="$1"
  local output="$2"
  python3 - "$report" "$output" <<'PY'
import json
import os
import pathlib
import sys
import tempfile

payload = json.load(open(sys.argv[1], encoding="utf-8"))
rows = payload.get("envelope", {}).get("rows")
if not isinstance(rows, list):
    raise SystemExit("map report has no row envelope")
keys = {"SITE": "sites", "DOMAIN": "siteDomains", "DATABASE": "databases"}
counts = {value: 0 for value in keys.values()}
seen = set()
for row in rows:
    if not isinstance(row, dict) or row.get("recordKind") not in keys or not isinstance(row.get("sourceId"), str):
        raise SystemExit("map report has an invalid row")
    key = (row["recordKind"], row["sourceId"])
    if key in seen:
        raise SystemExit("map report has duplicate source rows")
    seen.add(key)
    counts[keys[row["recordKind"]]] += 1
target = pathlib.Path(sys.argv[2])
target.parent.mkdir(parents=True, exist_ok=True)
fd, temporary = tempfile.mkstemp(prefix=f".{target.name}.tmp-", dir=target.parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(counts, handle, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, target)
finally:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
PY
}

write_fresh_baseline_counts() {
  printf '%s\n' '{"databases":0,"siteDomains":0,"sites":0}' | mb_atomic_write_stdin "$1"
}

# A checksum-verified post-domain Prisma history does not have legacy source
# fields to map. Preserve its current ownership counts as the invariant
# baseline before a later candidate migration runs.
write_current_baseline_counts() {
  local database="$1"
  local output="$2"
  python3 - "$database" <<'PY' | mb_atomic_write_stdin "$output"
import json
import os
import sqlite3
import sys
import urllib.parse

database = os.path.abspath(sys.argv[1])
connection = sqlite3.connect("file:" + urllib.parse.quote(database, safe="/") + "?mode=ro", uri=True)
try:
    counts = {}
    for table, key in (("sites", "sites"), ("site_domains", "siteDomains"), ("databases", "databases")):
        present = connection.execute("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?", (table,)).fetchone()
        if present is None:
            raise SystemExit(f"required invariant table is missing: {table}")
        counts[key] = connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
    print(json.dumps(counts, sort_keys=True))
finally:
    connection.close()
PY
}

prepare_mapper_evidence() {
  local database="$1"
  local output="$2"
  local mode="$3"
  local evidence_hook="$MAPPER_EVIDENCE_HOOK"
  [[ -n "$evidence_hook" ]] || evidence_hook="$CANDIDATE_DIR/migrations/dist/runtime-evidence.js"
  [[ -f "$evidence_hook" || -x "$evidence_hook" ]] || \
    die "legacy mapper requires a read-only runtime evidence hook (MEOWBOX_MAPPER_EVIDENCE_HOOK)"
  run_hook "$evidence_hook" scan --mode "$mode" --db "$database" --output "$output"
  [[ -f "$output" ]] || die "runtime evidence hook did not produce $output"
}

run_dry_run() {
  stage U02-dry-run "clone migration, baseline, mapper, invariants and staged runtime validation"
  mkdir -p "$DRY_DIR"
  local legacy_paths="$DRY_DIR/legacy-paths.txt"
  local manifest_paths="$DRY_DIR/manifest-paths.txt"
  local all_paths="$DRY_DIR/managed-paths.txt"
  local clone_db="$DRY_DIR/meowbox.db"
  local clone_map="$DRY_DIR/migration-map.json"
  local baseline_report="$DRY_DIR/baseline.json"
  local baseline_applied_report="$DRY_DIR/baseline-applied.json"
  local baseline_counts="$DRY_DIR/baseline-counts.json"
  local mapper_evidence="$DRY_DIR/runtime-evidence.json"
  local invariant_report="$DRY_DIR/invariants.json"
  mb_collect_legacy_managed_paths "$DB_FILE" "$legacy_paths"
  local legacy_config_before legacy_config_after
  legacy_config_before="$(mb_hash_path_file "$legacy_paths")"
  local db_before db_file_before
  db_before="$(source_hash_inputs)"
  db_file_before="$(source_file_fingerprint)"
  # Capture the proof before invoking any pluggable integration.  Candidate
  # hooks are contractual read-only checks in dry-run mode, but a violation is
  # still detected by the final live-hash comparison below.
  prepare_release_health_hooks
  check_release_capacity "$DRY_DIR"
  preflight_serving_health
  mb_sqlite_backup "$DB_FILE" "$clone_db"
  # Assess first without changing the clone.  The map is then bound to the
  # exact clone image before Prisma writes its bookkeeping history; that same
  # ordering is repeated after live quiescence.
  release_cli baseline --db "$clone_db" --api-dir "$CANDIDATE_DIR/api" --contract "$CANDIDATE_DIR/migrations/release/supported-baselines.json" --json > "$baseline_report"
  local decision mapping_required
  decision="$(baseline_decision "$baseline_report")"
  mapping_required="$(baseline_mapping_required "$baseline_report")"
  if [[ "$mapping_required" == "true" ]]; then
    prepare_mapper_evidence "$clone_db" "$mapper_evidence" dry-run
    release_cli map --db "$clone_db" --output "$clone_map" --map-table _meowbox_domain_migration_map \
      --runtime-evidence "$mapper_evidence" --apply-map --write-mode clone --json
    write_baseline_counts_from_map "$clone_map" "$baseline_counts"
    cp -- "$clone_map" "$TX_DIR/dry-run-migration-map.json"
  elif [[ "$decision" == "fresh" ]]; then
    write_fresh_baseline_counts "$baseline_counts"
  else
    write_current_baseline_counts "$clone_db" "$baseline_counts"
  fi
  printf '%s\n' "$mapping_required" | mb_atomic_write_stdin "$TX_DIR/dry-run-mapping-required"
  release_cli baseline --db "$clone_db" --api-dir "$CANDIDATE_DIR/api" --contract "$CANDIDATE_DIR/migrations/release/supported-baselines.json" --apply --write-mode clone --json > "$baseline_applied_report"
  prisma_deploy "$clone_db"
  release_cli invariants --db "$clone_db" --phase final --baseline-counts "$baseline_counts" --json > "$invariant_report"
  prepare_runtime "$clone_db" dry-run
  capture_http_probe_baseline "$RUNTIME_MANIFEST" "$HTTP_PROBE_BASELINE"
  mb_collect_manifest_paths "$RUNTIME_MANIFEST" "$manifest_paths"
  mb_merge_path_files "$all_paths" "$legacy_paths" "$manifest_paths"
  local config_before
  config_before="$(managed_runtime_hash "$all_paths")"
  # The maintenance integration owns the authoritative active-operation check.
  # Absence is a blocker rather than a best-effort warning.
  run_hook "$QUIESCE_HOOK" check --transaction "$TRANSACTION_ID" --candidate "$CANDIDATE_DIR" --database "$DB_FILE"
  MEOWBOX_STATE_DIR="$DRY_DIR/state" MEOWBOX_RUNTIME_MANIFEST="$RUNTIME_MANIFEST" MEOWBOX_RUNTIME_STAGE="$RUNTIME_STAGE" \
    MEOWBOX_RUNTIME_VALIDATED=1 DATABASE_URL="file:$clone_db" node "$CANDIDATE_DIR/migrations/dist/runner.js" up --dry-run
  local db_after db_file_after config_after
  db_after="$(source_hash_inputs)"
  db_file_after="$(source_file_fingerprint)"
  config_after="$(managed_runtime_hash "$all_paths")"
  legacy_config_after="$(mb_hash_path_file "$legacy_paths")"
  [[ "$db_before" == "$db_after" ]] || die "dry-run changed live SQLite input hash"
  [[ "$db_file_before" == "$db_file_after" ]] || die "dry-run changed live SQLite main/WAL fingerprint"
  [[ "$legacy_config_before" == "$legacy_config_after" ]] || die "dry-run changed live managed runtime hash"
  [[ "$config_before" == "$config_after" ]] || die "dry-run changed live managed runtime hash"
  cp -- "$all_paths" "$TX_DIR/managed-runtime-paths.txt"
  cp -- "$baseline_report" "$TX_DIR/dry-run-baseline.json"
  cp -- "$baseline_applied_report" "$TX_DIR/dry-run-baseline-applied.json"
  cp -- "$baseline_counts" "$TX_DIR/dry-run-baseline-counts.json"
  cp -- "$invariant_report" "$TX_DIR/dry-run-invariants.json"
  printf '%s\n' "$db_before" > "$TX_DIR/dry-run-source-db.hash"
  printf '%s\n' "$db_file_before" > "$TX_DIR/dry-run-source-file.hash"
  printf '%s\n' "$decision" > "$TX_DIR/dry-run-baseline-decision"
  printf '%s\n' "$config_before" > "$TX_DIR/dry-run-managed-runtime.hash"
  printf '%s\n' "$(runtime_plan_hash "$RUNTIME_MANIFEST")" > "$TX_DIR/dry-run-runtime-plan.hash"
  write_report pass "clone migration and staged runtime validation completed without live mutations" "$db_before" "$config_before"
  DRY_RUN_DB_HASH="$db_before"
  DRY_RUN_CONFIG_HASH="$config_before"
  journal_update dry-run "clone path passed; live DB/config hashes unchanged"
  say "dry-run report: $REPORT_JSON"
}

apply_database() {
  stage U05-database "baseline, deterministic map, migrate deploy and invariant checks"
  local expected_hash expected_file_hash actual_hash actual_file_hash
  expected_hash="$(<"$TX_DIR/dry-run-source-db.hash")"
  expected_file_hash="$(<"$TX_DIR/dry-run-source-file.hash")"
  actual_hash="$(source_hash_inputs)"
  actual_file_hash="$(source_file_fingerprint)"
  [[ "$expected_hash" == "$actual_hash" ]] || die "SQLite changed after dry-run/snapshot; rerun dry-run before any database mutation"
  [[ "$expected_file_hash" == "$actual_file_hash" ]] || die "SQLite main/WAL changed after dry-run/snapshot; rerun dry-run before any database mutation"
  [[ "$SNAPSHOT_SOURCE_FILE_HASH" == "$actual_file_hash" ]] || die "SQLite no longer matches the snapshot-bound mapper source image"
  [[ "$(managed_runtime_hash "$TX_DIR/managed-runtime-paths.txt")" == "$SNAPSHOT_CONFIG_HASH" ]] || \
    die "managed runtime changed before the database phase; rerun dry-run before mutation"
  local live_assessment="$TX_DIR/live-baseline-assessment.json"
  local live_map="$TX_DIR/live-migration-map.json"
  local live_counts="$TX_DIR/live-baseline-counts.json"
  local live_evidence="$TX_DIR/live-runtime-evidence.json"
  release_cli baseline --db "$DB_FILE" --api-dir "$CANDIDATE_DIR/api" --contract "$CANDIDATE_DIR/migrations/release/supported-baselines.json" --json > "$live_assessment"
  local dry_decision live_decision dry_mapping_required live_mapping_required
  dry_decision="$(<"$TX_DIR/dry-run-baseline-decision")"
  live_decision="$(baseline_decision "$live_assessment")"
  dry_mapping_required="$(<"$TX_DIR/dry-run-mapping-required")"
  live_mapping_required="$(baseline_mapping_required "$live_assessment")"
  [[ "$dry_decision" == "$live_decision" ]] || die "baseline decision changed after dry-run; refusing stale release plan"
  [[ "$dry_mapping_required" == "$live_mapping_required" ]] || die "legacy mapper requirement changed after dry-run; refusing stale release plan"
  if [[ "$live_mapping_required" == "true" ]]; then
    prepare_mapper_evidence "$DB_FILE" "$live_evidence" apply
    release_cli map --db "$DB_FILE" --output "$live_map" --map-table _meowbox_domain_migration_map \
      --runtime-evidence "$live_evidence" --apply-map --write-mode live --json
    [[ "$(map_report_value "$live_map" sourceFileSha256)" == "$SNAPSHOT_SOURCE_FILE_HASH" ]] || \
      die "live mapper source fingerprint no longer matches the matched snapshot"
    [[ "$(map_report_value "$live_map" mapSha256)" == "$(map_report_value "$TX_DIR/dry-run-migration-map.json" mapSha256)" ]] || \
      die "migration mapping changed after dry-run; refusing stale map"
    write_baseline_counts_from_map "$live_map" "$live_counts"
  elif [[ "$live_decision" == "fresh" ]]; then
    write_fresh_baseline_counts "$live_counts"
  else
    write_current_baseline_counts "$DB_FILE" "$live_counts"
  fi
  [[ "$(managed_runtime_hash "$TX_DIR/managed-runtime-paths.txt")" == "$SNAPSHOT_CONFIG_HASH" ]] || \
    die "mapper evidence changed managed runtime input; rollback is required"
  release_cli baseline --db "$DB_FILE" --api-dir "$CANDIDATE_DIR/api" --contract "$CANDIDATE_DIR/migrations/release/supported-baselines.json" --apply --write-mode live --json > "$TX_DIR/live-baseline.json"
  prisma_deploy "$DB_FILE"
  release_cli invariants --db "$DB_FILE" --phase final --baseline-counts "$live_counts" --json > "$TX_DIR/live-invariants.json"
  journal_update database "SQLite baseline/map/migrate/invariants completed"
}

prepare_apply_runtime() {
  stage U06-runtime "re-render and validate managed runtime candidates"
  prepare_runtime "$DB_FILE" apply
  local expected actual
  expected="$(<"$TX_DIR/dry-run-runtime-plan.hash")"
  actual="$(runtime_plan_hash "$RUNTIME_MANIFEST")"
  [[ "$expected" == "$actual" ]] || die "runtime artifact plan changed after dry-run; retry from a fresh dry-run"
  mb_collect_manifest_paths "$RUNTIME_MANIFEST" "$TX_DIR/apply-manifest-paths.txt"
  mb_merge_path_files "$TX_DIR/apply-managed-paths.txt" "$TX_DIR/managed-runtime-paths.txt" "$TX_DIR/apply-manifest-paths.txt"
  journal_update runtime "staged runtime candidate revalidated"
}

switch_release() {
  stage U07-switch "commit managed runtime, atomically switch release, then restart panel"
  local final_release="$RELEASES_DIR/$TARGET"
  if [[ -e "$final_release" ]]; then
    if [[ -n "$LEGACY_BRIDGE_SOURCE_DIR" ]] && \
       [[ "$(readlink -f "$final_release")" == "$LEGACY_BRIDGE_SOURCE_DIR" ]]; then
      LEGACY_BRIDGE_RETIRED_SOURCE="$TX_DIR/legacy-bridge-source"
      [[ ! -e "$LEGACY_BRIDGE_RETIRED_SOURCE" ]] || die "legacy bridge retirement path already exists"
      mv -- "$final_release" "$LEGACY_BRIDGE_RETIRED_SOURCE"
      # Keep rollback/health helpers reachable during the rename gap. Bash has
      # the updater itself open, but a later `bash $SCRIPT_DIR/rollback.sh`
      # still needs a durable pathname if journaling or mv(2) fails here.
      SCRIPT_DIR="$LEGACY_BRIDGE_RETIRED_SOURCE/tools"
      journal_update switch-intent "verified legacy updater candidate retired; transactional candidate will replace it"
    else
      die "target release directory already exists: $final_release"
    fi
  fi
  local staged_candidate="$CANDIDATE_DIR"
  # Persist the final destination before rename.  A hard kill between mv(2)
  # and a later journal write must still leave rollback enough information to
  # quarantine the invisible candidate and allow an idempotent retry.
  CANDIDATE_DIR="$final_release"
  journal_update switch-intent "candidate release destination reserved; runtime switch pending"
  # Move candidate before the symlink switch; it is still invisible to PM2.
  mv -- "$staged_candidate" "$CANDIDATE_DIR"
  SCRIPT_DIR="$CANDIDATE_DIR/tools"
  refresh_candidate_health_hook_paths
  # Persist the moved candidate before any mutable runtime work.  A rollback
  # can then quarantine it under the transaction instead of blocking a safe
  # retry because releases/$TARGET already exists.
  journal_update switch-stage "candidate release moved; runtime switch pending"
  MEOWBOX_STATE_DIR="$STATE_DIR" MEOWBOX_RUNTIME_MANIFEST="$RUNTIME_MANIFEST" MEOWBOX_RUNTIME_STAGE="$RUNTIME_STAGE" \
    MEOWBOX_RUNTIME_VALIDATED=1 DATABASE_URL="file:$DB_FILE" node "$CANDIDATE_DIR/migrations/dist/runner.js" up
  local changes
  changes="$(python3 - "$RUNTIME_MANIFEST" <<'PY'
import json,sys
print(len(json.load(open(sys.argv[1], encoding="utf-8")).get("artifacts", [])))
PY
)"
  if [[ "$changes" != "0" ]]; then
    local apply_hook="$RUNTIME_APPLY_HOOK"
    [[ -n "$apply_hook" ]] || apply_hook="$CANDIDATE_DIR/migrations/dist/runtime-apply.js"
    [[ -f "$apply_hook" || -x "$apply_hook" ]] || die "runtime artifacts require switch/reload/socket verification hook"
    run_hook "$apply_hook" switch --db "$DB_FILE" --stage "$RUNTIME_STAGE" --manifest "$RUNTIME_MANIFEST"
  fi
  mb_atomic_switch_symlink "$CANDIDATE_DIR" "$PANEL_DIR/current"
  pm2 reload "$PANEL_DIR/ecosystem.config.js" --update-env
  journal_update switch "managed config and current release switched"
}

verify_release() {
  stage U08-verify "final PM2/API/Web/agent/Nginx/PHP/HTTP/SQLite verification"
  MEOWBOX_DATABASE_FILE="$DB_FILE" MEOWBOX_RELEASE_HEALTH_HOOKS_REQUIRED=1 \
    bash "$SCRIPT_DIR/healthcheck.sh" --strict --manifest "$RUNTIME_MANIFEST" \
      --probe-baseline "$HTTP_PROBE_BASELINE" --release-dir "$CANDIDATE_DIR" --expected-version "$TARGET"
  release_cli invariants --db "$DB_FILE" --phase final --baseline-counts "$TX_DIR/live-baseline-counts.json" --json > "$TX_DIR/final-invariants.json"
  journal_update verify "final health and invariants passed"
}

forward_repair() {
  local apply_hook="$RUNTIME_APPLY_HOOK"
  [[ -n "$apply_hook" ]] || apply_hook="$CANDIDATE_DIR/migrations/dist/runtime-apply.js"
  if [[ -f "$apply_hook" || -x "$apply_hook" ]]; then
    run_hook "$apply_hook" cleanup --db "$DB_FILE" --stage "$RUNTIME_STAGE" --manifest "$RUNTIME_MANIFEST" || return 1
  fi
  return 0
}

verify_post_commit_cleanup() {
  MEOWBOX_DATABASE_FILE="$DB_FILE" MEOWBOX_RELEASE_HEALTH_HOOKS_REQUIRED=1 \
    bash "$SCRIPT_DIR/healthcheck.sh" --strict --manifest "$RUNTIME_MANIFEST" \
      --probe-baseline "$HTTP_PROBE_BASELINE" --release-dir "$CANDIDATE_DIR" --expected-version "$TARGET"
}

post_commit_forward_repair() {
  run_hook "$QUIESCE_HOOK" resume --transaction "$TRANSACTION_ID" --candidate "$CANDIDATE_DIR" --database "$DB_FILE" || return 1
  forward_repair || return 1
  verify_post_commit_cleanup
}

stage_candidate
run_dry_run
if $DRY_RUN; then
  say "dry-run passed; no production DB, managed config, services or release link were changed"
  exit 0
fi

stage U03-snapshot "SQLite backup + metadata-preserving managed runtime snapshot"
SNAPSHOT_DIR="$(MEOWBOX_STATE_DIR="$STATE_DIR" MEOWBOX_DATABASE_FILE="$DB_FILE" MEOWBOX_RELEASE_LOCK_HELD=1 \
  bash "$SCRIPT_DIR/snapshot.sh" --transaction "$TRANSACTION_ID" --paths-file "$TX_DIR/managed-runtime-paths.txt" --no-rotate | tail -n 1)"
[[ -d "$SNAPSHOT_DIR" ]] || die "snapshot did not produce a directory"
SNAPSHOT_SOURCE_HASH="$(mb_snapshot_json_value "$SNAPSHOT_DIR" database.sourceHash)"
SNAPSHOT_SOURCE_FILE_HASH="$(mb_snapshot_json_value "$SNAPSHOT_DIR" database.sourceFileHash)"
SNAPSHOT_CONFIG_HASH="$(mb_snapshot_json_value "$SNAPSHOT_DIR" managedRuntime.sourceHash)"
[[ "$SNAPSHOT_SOURCE_HASH" == "$(<"$TX_DIR/dry-run-source-db.hash")" ]] || die "SQLite changed between dry-run and snapshot; retry update"
[[ "$SNAPSHOT_SOURCE_FILE_HASH" == "$(<"$TX_DIR/dry-run-source-file.hash")" ]] || die "SQLite main/WAL changed between dry-run and snapshot; retry update"
[[ "$SNAPSHOT_CONFIG_HASH" == "$(<"$TX_DIR/dry-run-managed-runtime.hash")" ]] || die "managed runtime changed between dry-run and snapshot; retry update"
journal_update snapshot "consistent DB/config/release/process snapshot complete"

stage U04-quiesce "gate panel writes and wait for active operations"
ROLLBACK_ARMED=true
journal_update quiesce "quiesce requested; rollback boundary armed"
run_hook "$QUIESCE_HOOK" quiesce --transaction "$TRANSACTION_ID" --candidate "$CANDIDATE_DIR" --database "$DB_FILE" --timeout "$MEOWBOX_QUIESCE_TIMEOUT"
[[ "$(source_hash_inputs)" == "$SNAPSHOT_SOURCE_HASH" ]] || die "SQLite changed after quiesce; rollback is required"
[[ "$(source_file_fingerprint)" == "$SNAPSHOT_SOURCE_FILE_HASH" ]] || die "SQLite main/WAL changed after quiesce; rollback is required"
[[ "$(managed_runtime_hash "$TX_DIR/managed-runtime-paths.txt")" == "$SNAPSHOT_CONFIG_HASH" ]] || die "managed runtime changed after quiesce; rollback is required"

apply_database
prepare_apply_runtime
switch_release
verify_release

stage U09-commit "mark rollback boundary, re-open writes, write final success sentinel"
journal_update commit "all final health checks passed; rollback boundary committed" true
COMMITTED=true
if ! run_hook "$QUIESCE_HOOK" resume --transaction "$TRANSACTION_ID" --candidate "$CANDIDATE_DIR" --database "$DB_FILE"; then
  journal_update forward-repair "write gate did not reopen; forward repair required" true
  die "post-commit write gate resume failed; DB rollback is forbidden, repair forward"
fi
if ! forward_repair; then
  journal_update forward-repair "post-commit cleanup failed; retry forward repair" true
  die "post-commit cleanup failed; serving new release without DB rollback and retrying forward repair"
fi
if ! verify_post_commit_cleanup; then
  journal_update forward-repair "post-commit health check failed; retry forward repair" true
  die "post-commit health check failed; DB rollback is forbidden, repair forward"
fi
if [[ -n "$LEGACY_BRIDGE_RETIRED_SOURCE" ]]; then
  if [[ "$LEGACY_BRIDGE_RETIRED_SOURCE" == "$TX_DIR/legacy-bridge-source" ]] && \
     [[ -d "$LEGACY_BRIDGE_RETIRED_SOURCE" ]]; then
    rm -rf -- "$LEGACY_BRIDGE_RETIRED_SOURCE"
    say "retired legacy updater candidate removed after committed health checks"
  else
    say "warning: retained unexpected legacy bridge source for manual inspection"
  fi
fi
printf '%s\n' "$TARGET" | mb_atomic_write_stdin "$STATE_DIR/.update-success"
journal_update committed "post-commit cleanup and final health complete" true
say "✓ update committed: $CURRENT_VERSION → $TARGET"
write_report pass "release committed after final health; snapshot retained at $SNAPSHOT_DIR" "$(<"$TX_DIR/dry-run-source-db.hash")" "$(<"$TX_DIR/dry-run-managed-runtime.hash")"
say "report: $REPORT_JSON"
