#!/usr/bin/env bash
# =============================================================================
# Release health verification.  In strict mode it validates the current
# release artifact, PM2, API/Web, Nginx, declared PHP services/sockets and
# manifest-provided domain probes. New or changed failures are rejected; an
# exact pre-existing status may be carried through a release transaction.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANEL_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${MEOWBOX_ENV_FILE:-$PANEL_DIR/state/.env}"
[[ -f "$ENV_FILE" ]] || ENV_FILE="$PANEL_DIR/.env"

MANIFEST=""
STRICT=false
RELEASE_DIR=""
EXPECTED_VERSION=""
PROBE_BASELINE=""
SKIP_PM2=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest) MANIFEST="${2:-}"; shift 2 ;;
    --strict) STRICT=true; shift ;;
    --release-dir) RELEASE_DIR="${2:-}"; shift 2 ;;
    --expected-version) EXPECTED_VERSION="${2:-}"; shift 2 ;;
    --probe-baseline) PROBE_BASELINE="${2:-}"; shift 2 ;;
    --skip-pm2) SKIP_PM2=true; shift ;;
    *)
      echo "Usage: healthcheck.sh [--strict] [--manifest FILE] [--probe-baseline FILE] [--release-dir DIR] [--expected-version VERSION] [--skip-pm2]" >&2
      exit 2
      ;;
  esac
done

API_PORT="$(grep -E '^API_PORT=' "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '"' || true)"
WEB_PORT="$(grep -E '^WEB_PORT=' "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '"' || true)"
API_PORT="${API_PORT:-11860}"
WEB_PORT="${WEB_PORT:-11861}"
TIMEOUT="${HEALTHCHECK_TIMEOUT:-30}"
DATABASE_FILE="${MEOWBOX_DATABASE_FILE:-$PANEL_DIR/state/data/meowbox.db}"
[[ -f "$DATABASE_FILE" ]] || DATABASE_FILE="$PANEL_DIR/data/meowbox.db"
REQUIRE_RELEASE_HOOKS="${MEOWBOX_RELEASE_HEALTH_HOOKS_REQUIRED:-0}"
AGENT_HEALTH_HOOK="${MEOWBOX_AGENT_HEALTH_HOOK:-}"
REPRESENTATIVE_READ_HOOK="${MEOWBOX_REPRESENTATIVE_READ_HOOK:-}"

fail=0
say() { echo "[healthcheck] $*"; }
err() { echo "[healthcheck] ✗ $*" >&2; fail=1; }
require() { command -v "$1" >/dev/null 2>&1 || { err "missing command: $1"; return 1; }; }

http_code_with_retry() {
  local url="$1"
  local deadline=$(( $(date +%s) + TIMEOUT ))
  local code="000"
  while [[ $(date +%s) -lt $deadline ]]; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null || printf 000)"
    [[ "$code" != "000" ]] && break
    sleep 1
  done
  printf '%s' "$code"
}

run_release_health_hook() {
  local label="$1"
  local hook="$2"
  local -a hook_args=(verify --release-dir "$RELEASE_DIR" --manifest "$MANIFEST" --database "$DATABASE_FILE")
  [[ -n "$EXPECTED_VERSION" ]] && hook_args+=(--expected-version "$EXPECTED_VERSION")
  if [[ -z "$hook" ]]; then
    err "$label health integration hook is required for release verification"
    return 1
  fi
  local result=1
  if [[ -x "$hook" ]]; then
    "$hook" "${hook_args[@]}" && result=0
  elif [[ -f "$hook" && "$hook" == *.js ]] && command -v node >/dev/null 2>&1; then
    node "$hook" "${hook_args[@]}" && result=0
  else
    err "$label health hook is not executable/Node script"
    return 1
  fi
  if [[ $result -eq 0 ]]; then
    say "✓ $label health hook"
  else
    err "$label health hook failed"
  fi
  return "$result"
}

if ! $SKIP_PM2; then
  require pm2 || true
  PM2_JSON="$(pm2 jlist 2>/dev/null || printf '[]')"
  for process_name in meowbox-api meowbox-agent meowbox-web; do
    status="$(printf '%s' "$PM2_JSON" | python3 -c '
import json
import sys
try:
    processes = json.load(sys.stdin)
except json.JSONDecodeError:
    processes = []
name = sys.argv[1]
print(next((str(item.get("pm2_env", {}).get("status", "missing")) for item in processes if item.get("name") == name), "missing"))
' "$process_name")"
    if [[ "$status" == "online" ]]; then say "✓ $process_name online"; else err "$process_name is $status"; fi
  done
fi

require curl || true
api_code="$(http_code_with_retry "http://127.0.0.1:${API_PORT}/api/health")"
if [[ "$api_code" =~ ^(2[0-9][0-9]|401|403)$ ]]; then
  say "✓ API :$API_PORT healthy (HTTP $api_code)"
else
  err "API :$API_PORT unhealthy (HTTP $api_code)"
fi

web_code="$(http_code_with_retry "http://127.0.0.1:${WEB_PORT}/")"
if [[ "$web_code" =~ ^[23][0-9][0-9]$ ]]; then
  say "✓ Web :$WEB_PORT healthy (HTTP $web_code)"
else
  err "Web :$WEB_PORT unhealthy (HTTP $web_code)"
fi

if $STRICT; then
  if [[ -z "$RELEASE_DIR" && -L "$PANEL_DIR/current" ]]; then RELEASE_DIR="$(readlink -f "$PANEL_DIR/current")"; fi
  if [[ -z "$RELEASE_DIR" || ! -d "$RELEASE_DIR" ]]; then
    err "strict mode requires a readable release directory"
  else
    [[ -f "$RELEASE_DIR/VERSION" ]] || err "release VERSION is missing"
    [[ -f "$RELEASE_DIR/web/.output/server/index.mjs" ]] || err "Nuxt server build artifact is missing"
    if [[ -n "$EXPECTED_VERSION" ]]; then
      actual_version="$(tr -d '[:space:]' < "$RELEASE_DIR/VERSION" 2>/dev/null || true)"
      [[ "$actual_version" == "$EXPECTED_VERSION" ]] || err "release VERSION mismatch: expected $EXPECTED_VERSION, got ${actual_version:-missing}"
    fi
  fi
  if command -v nginx >/dev/null 2>&1; then
    nginx -t >/dev/null 2>&1 && say "✓ nginx -t" || err "nginx -t failed"
  else
    err "nginx binary is missing"
  fi
fi

if [[ -n "$MANIFEST" ]]; then
  [[ -f "$MANIFEST" ]] || { err "runtime manifest not found: $MANIFEST"; MANIFEST=""; }
fi
if [[ -n "$PROBE_BASELINE" && ! -f "$PROBE_BASELINE" ]]; then
  err "HTTP probe baseline not found: $PROBE_BASELINE"
  PROBE_BASELINE=""
fi
if [[ -n "$MANIFEST" ]]; then
  manifest_checks=""
  if ! manifest_checks="$(python3 - "$MANIFEST" "$PROBE_BASELINE" <<'PY'
import json
import re
import sys
from urllib.parse import urlparse

with open(sys.argv[1], encoding="utf-8") as handle:
    manifest = json.load(handle)
if manifest.get("version") != 1 or not isinstance(manifest.get("artifacts"), list):
    raise SystemExit("invalid runtime manifest")

baseline = {}
if sys.argv[2]:
    with open(sys.argv[2], encoding="utf-8") as handle:
        payload = json.load(handle)
    if payload.get("version") != 1 or not isinstance(payload.get("probes"), list):
        raise SystemExit("invalid HTTP probe baseline")
    for probe in payload["probes"]:
        if (
            not isinstance(probe, dict)
            or not isinstance(probe.get("url"), str)
            or type(probe.get("status")) is not int
            or probe["status"] < 100
            or probe["status"] > 599
            or probe["url"] in baseline
        ):
            raise SystemExit("invalid HTTP probe baseline entry")
        baseline[probe["url"]] = probe["status"]

manifest_probe_urls = set()
for service in manifest.get("phpServices", []):
    if not isinstance(service, str) or not re.fullmatch(r"php\d+\.\d+-fpm", service):
        raise SystemExit("unsafe php service in runtime manifest")
    print("service\t" + service + "\t-\t-")
for socket in manifest.get("socketPaths", []):
    if not isinstance(socket, str) or not re.fullmatch(r"/var/run/php/php\d+\.\d+-fpm-[a-z][a-z0-9._-]{0,63}\.sock", socket):
        raise SystemExit("unsafe PHP socket in runtime manifest")
    print("socket\t" + socket + "\t-\t-")
for probe in manifest.get("httpProbes", []):
    if not isinstance(probe, dict) or not isinstance(probe.get("url"), str):
        raise SystemExit("invalid HTTP probe")
    url = probe["url"]
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or re.search(r"[\x00-\x1f\x7f]", url):
        raise SystemExit("unsafe HTTP probe URL")
    statuses = probe.get("expectedStatus", [200, 301, 302])
    if not isinstance(statuses, list) or not statuses or any(type(code) is not int or code < 100 or code > 599 for code in statuses):
        raise SystemExit("invalid expected HTTP status")
    if url in manifest_probe_urls:
        raise SystemExit("duplicate HTTP probe URL")
    manifest_probe_urls.add(url)
    print(
        "probe\t"
        + url
        + "\t"
        + ",".join(str(code) for code in sorted(set(statuses)))
        + "\t"
        + (str(baseline[url]) if url in baseline else "-")
    )
if baseline and set(baseline) != manifest_probe_urls:
    raise SystemExit("HTTP probe baseline does not match runtime manifest")
PY
)"; then
    err "runtime manifest validation failed"
    manifest_checks=""
  fi
  while IFS=$'\t' read -r kind value expected baseline; do
    case "$kind" in
      service)
        if systemctl is-active --quiet "$value"; then say "✓ $value active"; else err "$value is not active"; fi
        ;;
      socket)
        if [[ -S "$value" ]]; then say "✓ socket $value"; else err "missing socket $value"; fi
        ;;
      probe)
        code="$(http_code_with_retry "$value")"
        if [[ ",$expected," == *",$code,"* ]]; then
          say "✓ probe $value (HTTP $code)"
        elif [[ "$baseline" != "-" && "$baseline" == "$code" ]]; then
          say "✓ probe $value unchanged pre-existing HTTP $code"
        else
          err "probe $value returned HTTP $code (expected $expected; baseline $baseline)"
        fi
        ;;
    esac
  done <<< "$manifest_checks"
fi

if $STRICT && [[ "$REQUIRE_RELEASE_HOOKS" == "1" ]]; then
  run_release_health_hook "agent" "$AGENT_HEALTH_HOOK" || true
  run_release_health_hook "representative API-read" "$REPRESENTATIVE_READ_HOOK" || true
fi

if [[ $fail -ne 0 ]]; then
  say "FAIL"
  exit 1
fi
say "OK"
