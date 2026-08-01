#!/usr/bin/env bash
# Restore the exact release behind a dangling /opt/meowbox/current symlink.
# This is a code-only recovery: persistent state and SQLite are never changed.
set -Eeuo pipefail

say() { echo "[release-recovery] $*"; }
die() { echo "[release-recovery] ✗ $*" >&2; exit 1; }

PANEL_DIR="${MEOWBOX_PANEL_DIR:-/opt/meowbox}"
[[ "$PANEL_DIR" == /* && -d "$PANEL_DIR" ]] || \
  die "MEOWBOX_PANEL_DIR must be an existing absolute directory"
PANEL_DIR="$(cd "$PANEL_DIR" && pwd -P)"
CURRENT_LINK="$PANEL_DIR/current"
RELEASES_DIR="$PANEL_DIR/releases"
STATE_DIR="$PANEL_DIR/state"
DB_FILE="$STATE_DIR/data/meowbox.db"
GITHUB_REPO="${GITHUB_REPO:-gvozdb/meowbox}"

[[ -L "$CURRENT_LINK" ]] || die "current is not a symlink"
[[ -d "$RELEASES_DIR" && ! -L "$RELEASES_DIR" ]] || \
  die "releases directory is missing or unsafe"
[[ -f "$DB_FILE" ]] || die "persistent panel database is missing"
[[ "$GITHUB_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || \
  die "invalid GITHUB_REPO"

if [[ -d "$CURRENT_LINK" ]]; then
  if [[ -f "$CURRENT_LINK/VERSION" && -f "$CURRENT_LINK/Makefile" ]]; then
    say "current release already exists; nothing changed"
    exit 0
  fi
  die "current target exists but is incomplete; refusing to overwrite it"
fi

MISSING_RELEASE="$({
  python3 - "$CURRENT_LINK" <<'PY'
import os
import pathlib
import sys

link = pathlib.Path(sys.argv[1])
target = pathlib.Path(os.readlink(link))
if not target.is_absolute():
    target = link.parent / target
print(target.resolve(strict=False))
PY
} 2>/dev/null)" || die "cannot resolve dangling current symlink"

[[ "$(dirname "$MISSING_RELEASE")" == "$RELEASES_DIR" ]] || \
  die "dangling current target is outside releases/"
VERSION="$(basename "$MISSING_RELEASE")"
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || \
  die "dangling current target has an invalid release version"
[[ ! -e "$MISSING_RELEASE" && ! -L "$MISSING_RELEASE" ]] || \
  die "missing release path is occupied by a non-directory entry"

for command in curl tar sha256sum python3 flock awk; do
  command -v "$command" >/dev/null 2>&1 || die "missing dependency: $command"
done

# Do not race the old updater that created this layout.
LEGACY_LOCK="${MEOWBOX_UPDATE_LOCK:-/var/run/meowbox-update.lock}"
if [[ -f "$LEGACY_LOCK" ]]; then
  LEGACY_PID="$(tr -cd '0-9' < "$LEGACY_LOCK" 2>/dev/null || true)"
  if [[ -n "$LEGACY_PID" ]] && kill -0 "$LEGACY_PID" 2>/dev/null; then
    die "legacy updater is still running (pid=$LEGACY_PID)"
  fi
fi

LOCK_FILE="$STATE_DIR/data/migrations/release-update.lock"
mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>>"$LOCK_FILE"
flock -n 9 || die "another update or recovery owns $LOCK_FILE"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/meowbox-release-recovery.XXXXXX")"
STAGE_DIR="$(mktemp -d "$RELEASES_DIR/.recover-$VERSION.XXXXXX")"
cleanup() {
  case "$WORK_DIR" in
    "${TMPDIR:-/tmp}"/meowbox-release-recovery.*) rm -rf -- "$WORK_DIR" ;;
  esac
  if [[ -n "${STAGE_DIR:-}" ]]; then
    case "$STAGE_DIR" in
      "$RELEASES_DIR"/.recover-*) rm -rf -- "$STAGE_DIR" ;;
    esac
  fi
}
trap cleanup EXIT

ASSET="meowbox-$VERSION.tar.gz"
TARBALL="$WORK_DIR/$ASSET"
SUMS="$WORK_DIR/SHA256SUMS"
BASE_URL="https://github.com/$GITHUB_REPO/releases/download/$VERSION"

say "downloading exact deleted release $VERSION"
curl -fsSL "$BASE_URL/$ASSET" -o "$TARBALL"
curl -fsSL "$BASE_URL/SHA256SUMS" -o "$SUMS"

EXPECTED="$(awk -v file="$ASSET" '$2 == file || $2 == "*" file { print $1; exit }' "$SUMS")"
[[ "$EXPECTED" =~ ^[0-9a-fA-F]{64}$ ]] || \
  die "release checksum entry is missing or invalid"
ACTUAL="$(sha256sum "$TARBALL" | awk '{print $1}')"
[[ "${ACTUAL,,}" == "${EXPECTED,,}" ]] || die "release checksum verification failed"

python3 - "$TARBALL" "$PANEL_DIR" <<'PY' || die "release archive contains unsafe paths"
import pathlib
import sys
import tarfile

panel = pathlib.PurePosixPath(sys.argv[2])
state = panel / "state"
with tarfile.open(sys.argv[1], "r:gz") as archive:
    members = archive.getmembers()
    symlinks = set()
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or not path.parts or path.parts[0] != "meowbox" or ".." in path.parts:
            raise SystemExit(1)
        if member.issym() or member.islnk():
            symlinks.add(path)
            target = pathlib.PurePosixPath(member.linkname)
            if target.is_absolute() and target != state / "adminer":
                raise SystemExit(1)
            if not target.is_absolute() and ".." in target.parts:
                raise SystemExit(1)
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if any(link != path and link in path.parents for link in symlinks):
            raise SystemExit(1)
PY

tar -xzf "$TARBALL" -C "$STAGE_DIR" --strip-components=1 \
  --no-same-owner --no-same-permissions
[[ -f "$STAGE_DIR/VERSION" ]] || die "release VERSION is missing"
[[ "$(tr -d '[:space:]' < "$STAGE_DIR/VERSION")" == "$VERSION" ]] || \
  die "release VERSION mismatch"
for required in Makefile ecosystem.config.js tools/update.sh tools/healthcheck.sh \
  api/dist agent/dist web/.output shared/dist migrations/dist; do
  [[ -e "$STAGE_DIR/$required" ]] || die "release is missing $required"
done

NEEDS_NPM=false
for package in api agent web; do
  [[ -f "$STAGE_DIR/$package/package-lock.json" ]] && NEEDS_NPM=true
done
if $NEEDS_NPM; then
  command -v npm >/dev/null 2>&1 || die "missing dependency: npm"
  for package in api agent web; do
    if [[ -f "$STAGE_DIR/$package/package-lock.json" ]]; then
      (cd "$STAGE_DIR/$package" && npm ci --omit=dev --no-audit --no-fund) || \
        die "npm ci failed in $package"
    fi
  done
fi

for package in api agent web migrations; do
  mkdir -p "$STAGE_DIR/$package/node_modules/@meowbox"
  ln -sfn ../../../shared "$STAGE_DIR/$package/node_modules/@meowbox/shared"
done
if [[ -d "$STAGE_DIR/api/node_modules/@prisma/client" ]]; then
  mkdir -p "$STAGE_DIR/migrations/node_modules/@prisma"
  ln -sfn ../../../api/node_modules/@prisma/client \
    "$STAGE_DIR/migrations/node_modules/@prisma/client"
fi
if [[ -f "$STAGE_DIR/api/prisma/schema.prisma" ]]; then
  command -v npx >/dev/null 2>&1 || die "missing dependency: npx"
  (cd "$STAGE_DIR/api" && DATABASE_URL="file:$DB_FILE" npx prisma generate) || \
    die "Prisma client generation failed"
fi

[[ ! -e "$STAGE_DIR/.env" && ! -L "$STAGE_DIR/.env" ]] || \
  die "release archive unexpectedly contains .env"
[[ ! -e "$STAGE_DIR/data" && ! -L "$STAGE_DIR/data" ]] || \
  die "release archive unexpectedly contains data/"
ln -s "$STATE_DIR/.env" "$STAGE_DIR/.env"
ln -s "$STATE_DIR/data" "$STAGE_DIR/data"

# Same-filesystem rename makes the deleted release visible atomically. No DB,
# environment, managed config, PM2 process or current symlink is modified.
mv -- "$STAGE_DIR" "$MISSING_RELEASE"
STAGE_DIR=""
python3 - "$RELEASES_DIR" <<'PY'
import os
import sys

descriptor = os.open(sys.argv[1], os.O_RDONLY)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY

[[ -d "$CURRENT_LINK" && -f "$CURRENT_LINK/Makefile" ]] || \
  die "release was restored but current is still invalid"
say "OK: restored $MISSING_RELEASE"
say "persistent database, configuration, Nginx and PM2 were not changed"
