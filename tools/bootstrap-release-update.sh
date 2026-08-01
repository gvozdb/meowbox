#!/usr/bin/env bash
# One-time entry point for releases whose bundled updater still runs
# `prisma db push`. The target release is verified first, then its transactional
# updater migrates a clone, snapshots live state and performs the real cutover.
set -Eeuo pipefail

say() { echo "[bootstrap-update] $*"; }
die() { echo "[bootstrap-update] ✗ $*" >&2; exit 1; }

PANEL_DIR="${MEOWBOX_PANEL_DIR:-/opt/meowbox}"
[[ "$PANEL_DIR" == /* && -d "$PANEL_DIR" ]] || \
  die "MEOWBOX_PANEL_DIR must be an existing absolute directory"
PANEL_DIR="$(cd "$PANEL_DIR" && pwd -P)"
[[ ! -f "$PANEL_DIR/.dev-mode" ]] || die "release update is unavailable on a dev workspace"
[[ -L "$PANEL_DIR/current" ]] || die "panel current release symlink is missing"
[[ -d "$PANEL_DIR/current" ]] || \
  die "panel current release target is missing; restore it with the checksum-verified recovery asset first"
[[ -f "$PANEL_DIR/state/data/meowbox.db" ]] || die "panel SQLite database is missing"

GITHUB_REPO="${GITHUB_REPO:-gvozdb/meowbox}"
[[ "$GITHUB_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "invalid GITHUB_REPO"
TARGET="${1:-}"
[[ $# -le 1 ]] || die "Usage: bootstrap-release-update.sh [vX.Y.Z]"

for command in curl tar sha256sum python3; do
  command -v "$command" >/dev/null 2>&1 || die "missing dependency: $command"
done

AUTH=()
[[ -n "${GITHUB_TOKEN:-}" ]] && AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN")
if [[ -z "$TARGET" ]]; then
  TARGET="$(
    curl -fsSL "${AUTH[@]}" -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/$GITHUB_REPO/releases/latest" |
      python3 -c 'import json,sys; print(json.load(sys.stdin).get("tag_name", ""))'
  )"
fi
[[ "$TARGET" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([._-][A-Za-z0-9.-]+)?$ ]] || die "invalid target version"

TMP_ROOT="${TMPDIR:-/tmp}"
[[ "$TMP_ROOT" == /* && -d "$TMP_ROOT" ]] || die "TMPDIR must be an existing absolute directory"
WORK_DIR="$(mktemp -d "$TMP_ROOT/meowbox-bootstrap.XXXXXX")"
cleanup() {
  case "$WORK_DIR" in
    "$TMP_ROOT"/meowbox-bootstrap.*) rm -rf -- "$WORK_DIR" ;;
  esac
}
trap cleanup EXIT

ASSET="meowbox-$TARGET.tar.gz"
TARBALL="$WORK_DIR/$ASSET"
SUMS="$WORK_DIR/SHA256SUMS"
BASE_URL="https://github.com/$GITHUB_REPO/releases/download/$TARGET"

say "download $TARGET"
curl -fsSL "${AUTH[@]}" "$BASE_URL/$ASSET" -o "$TARBALL"
curl -fsSL "${AUTH[@]}" "$BASE_URL/SHA256SUMS" -o "$SUMS"

EXPECTED="$(awk -v file="$ASSET" '$2 == file || $2 == "*" file { print $1; exit }' "$SUMS")"
[[ "$EXPECTED" =~ ^[0-9a-fA-F]{64}$ ]] || die "release checksum entry is missing or invalid"
ACTUAL="$(sha256sum "$TARBALL" | awk '{print $1}')"
[[ "${ACTUAL,,}" == "${EXPECTED,,}" ]] || die "release checksum verification failed"

CANDIDATE="$WORK_DIR/candidate"
mkdir -p "$CANDIDATE"
tar -xzf "$TARBALL" -C "$CANDIDATE" --strip-components=1 --no-same-owner --no-same-permissions
[[ "$(tr -d '[:space:]' < "$CANDIDATE/VERSION")" == "$TARGET" ]] || die "release VERSION mismatch"
for required in update.sh release-lib.sh release-transaction-policy.sh rollback.sh snapshot.sh healthcheck.sh; do
  [[ -f "$CANDIDATE/tools/$required" ]] || die "release is missing tools/$required"
done

say "verified $TARGET; handoff to transactional updater"
MEOWBOX_PANEL_DIR="$PANEL_DIR" \
MEOWBOX_STATE_DIR="$PANEL_DIR/state" \
MEOWBOX_DATABASE_FILE="$PANEL_DIR/state/data/meowbox.db" \
MEOWBOX_UPDATE_CANDIDATE_DIR="$CANDIDATE" \
MEOWBOX_UPDATE_CANDIDATE_VERSION="$TARGET" \
  bash "$CANDIDATE/tools/update.sh" "$TARGET"
