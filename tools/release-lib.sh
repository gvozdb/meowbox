#!/usr/bin/env bash
# Shared primitives for the release updater, snapshotter and recovery tool.
# This file is sourced; callers own `set -euo pipefail` and user-facing logs.

PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"
export PATH

mb_require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[release] required command is unavailable: $1" >&2
    return 1
  }
}

mb_now_utc() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

mb_read_env_value() {
  local env_file="$1"
  local key="$2"
  [[ -f "$env_file" ]] || return 1
  python3 - "$env_file" "$key" <<'PY'
import pathlib
import re
import sys

env_file = pathlib.Path(sys.argv[1])
key = sys.argv[2]
if not re.fullmatch(r"[A-Z_][A-Z0-9_]*", key):
    raise SystemExit("invalid env key")

value = None
pattern = re.compile(r"^\s*" + re.escape(key) + r"\s*=\s*(.*?)\s*$")
for line in env_file.read_text(encoding="utf-8").splitlines():
    match = pattern.match(line)
    if not match:
        continue
    candidate = match.group(1)
    if len(candidate) >= 2 and candidate[0] == candidate[-1] and candidate[0] in "\"'":
        candidate = candidate[1:-1]
    value = candidate

if value is None:
    raise SystemExit(1)
print(value)
PY
}

mb_atomic_write_stdin() {
  local target="$1"
  python3 -c '
import os, pathlib, sys, tempfile
target = pathlib.Path(sys.argv[1])
data = sys.stdin.buffer.read()
target.parent.mkdir(parents=True, exist_ok=True)
fd, temporary = tempfile.mkstemp(prefix=f".{target.name}.tmp-", dir=target.parent)
try:
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    try:
        stat = target.stat()
    except FileNotFoundError:
        stat = None
    if stat is not None:
        os.chmod(temporary, stat.st_mode & 0o7777)
        try:
            os.chown(temporary, stat.st_uid, stat.st_gid)
        except PermissionError:
            pass
    os.replace(temporary, target)
    directory = os.open(target.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
except BaseException:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
    raise
' "$target"
}

mb_sqlite_backup() {
  local source_db="$1"
  local destination_db="$2"
  python3 - "$source_db" "$destination_db" <<'PY'
import os
import pathlib
import sqlite3
import stat
import sys
import urllib.parse

source = pathlib.Path(sys.argv[1]).resolve()
destination = pathlib.Path(sys.argv[2]).resolve()
if not source.is_file():
    raise SystemExit(f"SQLite source is not a regular file: {source}")
if destination.exists():
    raise SystemExit(f"SQLite backup destination already exists: {destination}")
destination.parent.mkdir(parents=True, exist_ok=True)
source_uri = "file:" + urllib.parse.quote(str(source)) + "?mode=ro"
src = sqlite3.connect(source_uri, uri=True)
dst = sqlite3.connect(str(destination))
try:
    src.execute("PRAGMA query_only = ON")
    # sqlite3.Connection.backup is SQLite's online backup API; it includes a
    # consistent WAL view without copying live -wal/-shm files.
    src.backup(dst)
    result = dst.execute("PRAGMA integrity_check").fetchone()
    if not result or result[0] != "ok":
        raise RuntimeError(f"backup integrity_check failed: {result!r}")
    dst.commit()
finally:
    dst.close()
    src.close()
source_stat = source.stat()
os.chmod(destination, stat.S_IMODE(source_stat.st_mode))
try:
    os.chown(destination, source_stat.st_uid, source_stat.st_gid)
except PermissionError:
    # Non-root rehearsal users cannot preserve ownership.  The production
    # updater runs with the same privilege that owns the panel state.
    pass
PY
}

# This mirrors migrations/release/stable.ts:fingerprintDatabaseFiles.  It is
# intentionally content-only (main/WAL/SHM) so a mapper can bind itself to the
# exact pre-write SQLite image without leaking its absolute location.  The
# broader mb_hash_paths proof below additionally covers a rollback journal and
# metadata changes.
mb_sqlite_file_fingerprint() {
  local database="$1"
  python3 - "$database" <<'PY'
import hashlib
import json
import os
import pathlib
import sys

database = pathlib.Path(sys.argv[1])
if not database.is_file():
    raise SystemExit("SQLite database is not a regular file")

def digest(path):
    value = hashlib.sha256()
    with open(path, "rb", buffering=0) as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                return value.hexdigest()
            value.update(chunk)

def optional(path):
    try:
        return digest(path) if os.path.isfile(path) else None
    except FileNotFoundError:
        return None

parts = {
    "main": digest(database),
    "wal": optional(str(database) + "-wal"),
    "shm": optional(str(database) + "-shm"),
}
encoded = json.dumps(parts, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
print(hashlib.sha256(encoded).hexdigest())
PY
}

mb_hash_paths() {
  python3 - "$@" <<'PY'
import hashlib
import json
import os
import stat
import sys

def file_hash(path):
    digest = hashlib.sha256()
    with open(path, "rb", buffering=0) as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                return digest.hexdigest()
            digest.update(chunk)

def entry(path, logical):
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return [{"path": logical, "type": "missing"}]
    base = {
        "path": logical,
        "mode": stat.S_IMODE(st.st_mode),
        "uid": st.st_uid,
        "gid": st.st_gid,
        "mtimeNs": st.st_mtime_ns,
    }
    if stat.S_ISREG(st.st_mode):
        base.update({"type": "file", "size": st.st_size, "sha256": file_hash(path)})
        return [base]
    if stat.S_ISLNK(st.st_mode):
        base.update({"type": "symlink", "target": os.readlink(path)})
        return [base]
    if stat.S_ISDIR(st.st_mode):
        base["type"] = "directory"
        rows = [base]
        with os.scandir(path) as children:
            for child in sorted(children, key=lambda item: item.name):
                rows.extend(entry(child.path, logical.rstrip("/") + "/" + child.name))
        return rows
    base["type"] = "other"
    base["rdev"] = st.st_rdev
    return [base]

paths = sorted({os.path.abspath(value) for value in sys.argv[1:]})
rows = []
for item in paths:
    rows.extend(entry(item, item))
payload = json.dumps(rows, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
print(hashlib.sha256(payload).hexdigest())
PY
}

# Read one exact path per line without re-parsing it through the shell.  A
# manifest target is data, not shell syntax: whitespace and glob characters
# must reach the hashing proof byte-for-byte.  An empty path list deliberately
# hashes to the stable empty manifest digest.
mb_hash_path_file() {
  local paths_file="$1"
  local -a paths=()
  [[ -f "$paths_file" ]] || {
    echo "[release] managed path list is missing: $paths_file" >&2
    return 1
  }
  mapfile -t paths < "$paths_file"
  mb_hash_paths "${paths[@]}"
}

mb_is_managed_runtime_path() {
  python3 - "$1" <<'PY'
import os
import re
import sys

value = sys.argv[1]
normalized = os.path.normpath(value)
valid = (
    value == normalized and value.startswith("/") and "\x00" not in value and (
        value.startswith("/etc/nginx/meowbox/") or
        re.fullmatch(r"/etc/nginx/sites-(?:available|enabled)/[a-z][a-z0-9_-]{0,63}\.conf", value) is not None or
        value == "/etc/nginx/conf.d/meowbox-zones.conf" or
        re.fullmatch(r"/etc/php/\d+\.\d+/fpm/pool\.d/[A-Za-z0-9._-]+\.conf", value) is not None or
        re.fullmatch(r"/etc/logrotate\.d/meowbox[A-Za-z0-9._-]*", value) is not None
    )
)
raise SystemExit(0 if valid else 1)
PY
}

mb_collect_legacy_managed_paths() {
  local database="$1"
  local output="$2"
  python3 - "$database" "$output" <<'PY'
import os
import re
import sqlite3
import sys
import urllib.parse

database, output = sys.argv[1:]
paths = {
    "/etc/nginx/conf.d/meowbox-zones.conf",
    "/etc/logrotate.d/meowbox",
    "/etc/logrotate.d/meowbox-php",
}
connection = sqlite3.connect("file:" + urllib.parse.quote(os.path.abspath(database)) + "?mode=ro", uri=True)
try:
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "sites" in tables:
        columns = {row[1] for row in connection.execute("PRAGMA table_info('sites')")}
        if {"name", "php_version"}.issubset(columns):
            for name, php_version in connection.execute("SELECT name, php_version FROM sites"):
                if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", name):
                    raise SystemExit("unsafe Site.name encountered while collecting managed runtime paths")
                paths.update({
                    f"/etc/nginx/meowbox/{name}",
                    f"/etc/nginx/sites-available/{name}.conf",
                    f"/etc/nginx/sites-enabled/{name}.conf",
                })
                if php_version is not None:
                    if not isinstance(php_version, str) or not re.fullmatch(r"\d+\.\d+", php_version):
                        raise SystemExit(f"unsafe PHP version for site {name}")
                    paths.add(f"/etc/php/{php_version}/fpm/pool.d/{name}.conf")
finally:
    connection.close()
with open(output, "w", encoding="utf-8") as handle:
    for item in sorted(paths):
        handle.write(item + "\n")
PY
}

mb_collect_manifest_paths() {
  local manifest="$1"
  local output="$2"
  python3 - "$manifest" "$output" <<'PY'
import json
import os
import re
import sys

manifest, output = sys.argv[1:]
with open(manifest, encoding="utf-8") as handle:
    data = json.load(handle)
if data.get("version") != 1 or not isinstance(data.get("artifacts"), list):
    raise SystemExit("invalid runtime manifest")
paths = set()
for artifact in data["artifacts"]:
    if not isinstance(artifact, dict) or not isinstance(artifact.get("target"), str):
        raise SystemExit("invalid runtime manifest artifact")
    target = artifact["target"]
    normalized = os.path.normpath(target)
    allowed = (
        target == normalized and target.startswith("/") and "\x00" not in target and (
            target.startswith("/etc/nginx/meowbox/") or
            re.fullmatch(r"/etc/nginx/sites-(?:available|enabled)/[a-z][a-z0-9_-]{0,63}\.conf", target) is not None or
            target == "/etc/nginx/conf.d/meowbox-zones.conf" or
            re.fullmatch(r"/etc/php/\d+\.\d+/fpm/pool\.d/[A-Za-z0-9._-]+\.conf", target) is not None or
            re.fullmatch(r"/etc/logrotate\.d/meowbox[A-Za-z0-9._-]*", target) is not None
        )
    )
    if not allowed:
        raise SystemExit(f"runtime manifest target is outside managed paths: {target}")
    paths.add(target)
with open(output, "w", encoding="utf-8") as handle:
    for item in sorted(paths):
        handle.write(item + "\n")
PY
}

mb_merge_path_files() {
  local output="$1"
  shift
  python3 - "$output" "$@" <<'PY'
import pathlib
import sys

output = pathlib.Path(sys.argv[1])
paths = set()
for filename in sys.argv[2:]:
    candidate = pathlib.Path(filename)
    if not candidate.exists():
        continue
    for line in candidate.read_text(encoding="utf-8").splitlines():
        if line:
            paths.add(line)
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text("".join(f"{item}\n" for item in sorted(paths)), encoding="utf-8")
PY
}

mb_snapshot_runtime_config() {
  local snapshot_dir="$1"
  local paths_file="$2"
  local runtime_dir="$snapshot_dir/runtime-config"
  mkdir -p "$runtime_dir"
  python3 - "$paths_file" "$runtime_dir/metadata.json" "$runtime_dir/archive-paths.nul" <<'PY'
import json
import os
import pathlib
import stat
import sys

paths_file, metadata_file, nul_file = sys.argv[1:]
paths = [line for line in pathlib.Path(paths_file).read_text(encoding="utf-8").splitlines() if line]
records = []
existing = []
for value in sorted(set(paths)):
    try:
        st = os.lstat(value)
    except FileNotFoundError:
        records.append({"path": value, "exists": False})
        continue
    record = {
        "path": value,
        "exists": True,
        "mode": stat.S_IMODE(st.st_mode),
        "uid": st.st_uid,
        "gid": st.st_gid,
        "type": "directory" if stat.S_ISDIR(st.st_mode) else "symlink" if stat.S_ISLNK(st.st_mode) else "file" if stat.S_ISREG(st.st_mode) else "other",
    }
    if stat.S_ISLNK(st.st_mode):
        record["target"] = os.readlink(value)
    records.append(record)
    existing.append(value.lstrip("/"))
pathlib.Path(metadata_file).write_text(json.dumps(records, indent=2, sort_keys=True) + "\n", encoding="utf-8")
with open(nul_file, "wb") as handle:
    for value in existing:
        handle.write(value.encode("utf-8") + b"\0")
PY
  # GNU tar preserves directories, modes, numeric owner, ACLs, xattrs and
  # symlink targets.  Empty input is valid and produces a restorable archive.
  tar --create --gzip --file "$runtime_dir/config.tar.gz" --directory / \
    --null --files-from "$runtime_dir/archive-paths.nul" \
    --format=pax --numeric-owner --acls --xattrs --selinux
  cp --preserve=mode,ownership,timestamps "$paths_file" "$runtime_dir/paths.txt"
}

mb_restore_runtime_config() {
  local snapshot_dir="$1"
  local runtime_dir="$snapshot_dir/runtime-config"
  local metadata="$runtime_dir/metadata.json"
  local archive="$runtime_dir/config.tar.gz"
  [[ -f "$metadata" && -f "$archive" ]] || {
    echo "[release] invalid runtime snapshot: $runtime_dir" >&2
    return 1
  }
  python3 - "$metadata" <<'PY'
import json
import os
import re
import shutil
import sys

def allowed(value):
    return (
        value == os.path.normpath(value) and value.startswith("/") and "\x00" not in value and (
            value.startswith("/etc/nginx/meowbox/") or
            re.fullmatch(r"/etc/nginx/sites-(?:available|enabled)/[a-z][a-z0-9_-]{0,63}\.conf", value) is not None or
            value == "/etc/nginx/conf.d/meowbox-zones.conf" or
            re.fullmatch(r"/etc/php/\d+\.\d+/fpm/pool\.d/[A-Za-z0-9._-]+\.conf", value) is not None or
            re.fullmatch(r"/etc/logrotate\.d/meowbox[A-Za-z0-9._-]*", value) is not None
        )
    )

with open(sys.argv[1], encoding="utf-8") as handle:
    records = json.load(handle)
for record in records:
    value = record.get("path")
    if not isinstance(value, str) or not allowed(value):
        raise SystemExit(f"unsafe path in runtime snapshot: {value!r}")
    try:
        st = os.lstat(value)
    except FileNotFoundError:
        continue
    if stat_is_dir := __import__("stat").S_ISDIR(st.st_mode):
        if not os.path.islink(value):
            shutil.rmtree(value)
        else:
            os.unlink(value)
    else:
        os.unlink(value)
PY
  tar --extract --gzip --file "$archive" --directory / --numeric-owner --acls --xattrs --selinux
}

mb_atomic_switch_symlink() {
  local target="$1"
  local link="$2"
  python3 - "$target" "$link" <<'PY'
import os
import pathlib
import sys
import uuid

target = sys.argv[1]
link = pathlib.Path(sys.argv[2])
if not os.path.isabs(target):
    raise SystemExit("release symlink target must be absolute")
link.parent.mkdir(parents=True, exist_ok=True)
temporary = link.parent / f".{link.name}.next-{uuid.uuid4().hex}"
os.symlink(target, temporary)
os.replace(temporary, link)
descriptor = os.open(link.parent, os.O_RDONLY)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

mb_snapshot_json_value() {
  local snapshot_dir="$1"
  local key="$2"
  python3 - "$snapshot_dir/manifest.json" "$key" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)
for component in sys.argv[2].split('.'):
    value = value[component]
if isinstance(value, (dict, list)):
    print(json.dumps(value, sort_keys=True))
elif value is None:
    print("")
else:
    print(value)
PY
}
