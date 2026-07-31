#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=tools/release-lib.sh
source "$SCRIPT_DIR/release-lib.sh"

STATE_DIR="${MEOWBOX_STATE_DIR:-$PROJECT_ROOT/state}"
DATABASE_FILE="${MEOWBOX_DATABASE_FILE:-$STATE_DIR/data/meowbox.db}"
BASELINE_CONTRACT="$PROJECT_ROOT/migrations/release/supported-baselines.json"
TEMP_BASE="$(realpath -m "${TMPDIR:-/tmp}")"

[[ "$TEMP_BASE" != "/" ]] || {
  echo "[source-rehearsal] unsafe TMPDIR" >&2
  exit 1
}
[[ -f "$DATABASE_FILE" ]] || {
  echo "[source-rehearsal] panel database is missing" >&2
  exit 1
}
[[ -f "$BASELINE_CONTRACT" ]] || {
  echo "[source-rehearsal] baseline contract is missing" >&2
  exit 1
}

for command in node python3 sqlite3 realpath; do
  command -v "$command" >/dev/null || {
    echo "[source-rehearsal] missing command: $command" >&2
    exit 1
  }
done

TEMP_ROOT="$(mktemp -d "$TEMP_BASE/meowbox-source-rehearsal.XXXXXX")"
chmod 0700 "$TEMP_ROOT"

cleanup() {
  local resolved
  resolved="$(realpath -m "$TEMP_ROOT")"
  case "$resolved" in
    "$TEMP_BASE"/meowbox-source-rehearsal.*)
      rm -rf -- "$resolved"
      ;;
    *)
      echo "[source-rehearsal] refusing to clean unexpected path" >&2
      ;;
  esac
}
trap cleanup EXIT

RELEASE_ROOT="$TEMP_ROOT/release"
SHARED_OUTPUT="$RELEASE_ROOT/shared"
AGENT_OUTPUT="$RELEASE_ROOT/agent/dist"
MIGRATIONS_OUTPUT="$RELEASE_ROOT/migrations/dist"
CLONE_DB="$TEMP_ROOT/meowbox.db"
RUNTIME_STAGE="$TEMP_ROOT/runtime-stage"
RUNTIME_MANIFEST="$TEMP_ROOT/runtime-manifest.json"
MANAGED_PATHS="$TEMP_ROOT/managed-paths.txt"
BASELINE_REPORT="$TEMP_ROOT/baseline.json"
BASELINE_APPLIED_REPORT="$TEMP_ROOT/baseline-applied.json"
BASELINE_COUNTS="$TEMP_ROOT/baseline-counts.json"
RUNTIME_EVIDENCE="$TEMP_ROOT/runtime-evidence.json"
MIGRATION_MAP="$TEMP_ROOT/migration-map.json"
INVARIANTS_REPORT="$TEMP_ROOT/invariants.json"
TEMP_STATE="$TEMP_ROOT/state"

mkdir -p \
  "$SHARED_OUTPUT" \
  "$AGENT_OUTPUT" \
  "$MIGRATIONS_OUTPUT" \
  "$RUNTIME_STAGE" \
  "$TEMP_STATE/data/migrations"
touch "$TEMP_STATE/data/migrations/release-update.lock"

"$PROJECT_ROOT/shared/node_modules/.bin/tsc" \
  -p "$PROJECT_ROOT/shared/tsconfig.json" \
  --outDir "$SHARED_OUTPUT" \
  --incremental false \
  --sourceMap false \
  --declaration true \
  --declarationMap false \
  --pretty false

AGENT_TSCONFIG="$TEMP_ROOT/agent-tsconfig.json"
node - "$PROJECT_ROOT" "$AGENT_OUTPUT" "$SHARED_OUTPUT/index.d.ts" "$AGENT_TSCONFIG" <<'NODE'
const { writeFileSync } = require('node:fs');
const [projectRoot, outDir, sharedTypes, output] = process.argv.slice(2);
writeFileSync(output, `${JSON.stringify({
  extends: `${projectRoot}/agent/tsconfig.json`,
  compilerOptions: {
    outDir,
    incremental: false,
    sourceMap: false,
    declaration: false,
    baseUrl: projectRoot,
    paths: {
      '@meowbox/shared': [sharedTypes],
    },
    typeRoots: [
      `${projectRoot}/agent/node_modules/@types`,
      `${projectRoot}/node_modules/@types`,
    ],
  },
  include: [`${projectRoot}/agent/src/**/*`],
  exclude: [`${projectRoot}/agent/node_modules`, `${projectRoot}/agent/dist`],
}, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
NODE

"$PROJECT_ROOT/agent/node_modules/.bin/tsc" \
  -p "$AGENT_TSCONFIG" \
  --pretty false

"$PROJECT_ROOT/migrations/node_modules/.bin/tsc" \
  -p "$PROJECT_ROOT/migrations/tsconfig.json" \
  --outDir "$MIGRATIONS_OUTPUT" \
  --pretty false

mkdir -p \
  "$RELEASE_ROOT/agent/node_modules/@meowbox" \
  "$RELEASE_ROOT/migrations/node_modules/@meowbox" \
  "$RELEASE_ROOT/migrations/node_modules/@prisma"
ln -s "$SHARED_OUTPUT" "$RELEASE_ROOT/agent/node_modules/@meowbox/shared"
ln -s "$SHARED_OUTPUT" "$RELEASE_ROOT/migrations/node_modules/@meowbox/shared"
ln -s "$PROJECT_ROOT/api/node_modules/@prisma/client" \
  "$RELEASE_ROOT/migrations/node_modules/@prisma/client"

LIVE_DB_BEFORE="$(mb_sqlite_file_fingerprint "$DATABASE_FILE")"
mb_collect_legacy_managed_paths "$DATABASE_FILE" "$MANAGED_PATHS"
LIVE_CONFIG_BEFORE="$(mb_hash_path_file "$MANAGED_PATHS")"
mb_sqlite_backup "$DATABASE_FILE" "$CLONE_DB"

RELEASE_CLI="$MIGRATIONS_OUTPUT/release-cli.js"
node "$RELEASE_CLI" baseline \
  --db "$CLONE_DB" \
  --api-dir "$PROJECT_ROOT/api" \
  --contract "$BASELINE_CONTRACT" \
  --json > "$BASELINE_REPORT"

read -r BASELINE_DECISION MAPPING_REQUIRED < <(
  node - "$BASELINE_REPORT" <<'NODE'
const report = require(process.argv[2]);
const assessment = report.assessment;
if (!assessment || !['fresh', 'baseline-required', 'already-tracked'].includes(assessment.decision)) {
  throw new Error('baseline report has no safe decision');
}
if (typeof assessment.legacyMappingRequired !== 'boolean') {
  throw new Error('baseline report has no explicit mapping decision');
}
process.stdout.write(`${assessment.decision} ${assessment.legacyMappingRequired}\n`);
NODE
)

if [[ "$MAPPING_REQUIRED" == "true" ]]; then
  node "$MIGRATIONS_OUTPUT/runtime-evidence.js" scan \
    --mode dry-run \
    --db "$CLONE_DB" \
    --output "$RUNTIME_EVIDENCE"
  node "$RELEASE_CLI" map \
    --db "$CLONE_DB" \
    --output "$MIGRATION_MAP" \
    --map-table _meowbox_domain_migration_map \
    --runtime-evidence "$RUNTIME_EVIDENCE" \
    --apply-map \
    --write-mode clone \
    --json > "$TEMP_ROOT/map-command.json"
  node - "$MIGRATION_MAP" "$BASELINE_COUNTS" <<'NODE'
const { writeFileSync } = require('node:fs');
const [reportPath, output] = process.argv.slice(2);
const report = require(reportPath);
const rows = report.envelope?.rows;
if (!Array.isArray(rows)) throw new Error('migration map has no row envelope');
const names = { SITE: 'sites', DOMAIN: 'siteDomains', DATABASE: 'databases' };
const counts = { sites: 0, siteDomains: 0, databases: 0 };
for (const row of rows) {
  const key = names[row.recordKind];
  if (!key) throw new Error('migration map contains an invalid row');
  counts[key] += 1;
}
writeFileSync(output, `${JSON.stringify(counts)}\n`, { flag: 'wx', mode: 0o600 });
NODE
elif [[ "$BASELINE_DECISION" == "fresh" ]]; then
  printf '%s\n' '{"sites":0,"siteDomains":0,"databases":0}' > "$BASELINE_COUNTS"
else
  sqlite3 "$CLONE_DB" \
    "SELECT json_object('sites',(SELECT COUNT(*) FROM sites),'siteDomains',(SELECT COUNT(*) FROM site_domains),'databases',(SELECT COUNT(*) FROM databases));" \
    > "$BASELINE_COUNTS"
fi

node "$RELEASE_CLI" baseline \
  --db "$CLONE_DB" \
  --api-dir "$PROJECT_ROOT/api" \
  --contract "$BASELINE_CONTRACT" \
  --apply \
  --write-mode clone \
  --json > "$BASELINE_APPLIED_REPORT"

(
  cd "$PROJECT_ROOT/api"
  DATABASE_URL="file:$CLONE_DB" \
    "$PROJECT_ROOT/api/node_modules/.bin/prisma" migrate deploy \
    --schema "$PROJECT_ROOT/api/prisma/schema.prisma"
)

node "$RELEASE_CLI" invariants \
  --db "$CLONE_DB" \
  --phase final \
  --baseline-counts "$BASELINE_COUNTS" \
  --json > "$INVARIANTS_REPORT"

node "$MIGRATIONS_OUTPUT/runtime-renderer.js" \
  --mode dry-run \
  --db "$CLONE_DB" \
  --stage "$RUNTIME_STAGE" \
  --manifest "$RUNTIME_MANIFEST" \
  --release-root "$RELEASE_ROOT"

node "$MIGRATIONS_OUTPUT/runtime-validator.js" \
  --mode dry-run \
  --db "$CLONE_DB" \
  --stage "$RUNTIME_STAGE" \
  --manifest "$RUNTIME_MANIFEST"

node "$MIGRATIONS_OUTPUT/quiesce.js" check \
  --transaction source-rehearsal \
  --candidate "$RELEASE_ROOT" \
  --database "$DATABASE_FILE"

MEOWBOX_STATE_DIR="$TEMP_STATE" \
MEOWBOX_CURRENT_DIR="$PROJECT_ROOT" \
MEOWBOX_MIGRATION_STATE_DIR="$TEMP_STATE/data/migrations" \
MEOWBOX_RELEASE_LOCK_FILE="$TEMP_STATE/data/migrations/release-update.lock" \
MEOWBOX_RUNTIME_MANIFEST="$RUNTIME_MANIFEST" \
MEOWBOX_RUNTIME_STAGE="$RUNTIME_STAGE" \
MEOWBOX_RUNTIME_VALIDATED=1 \
DATABASE_URL="file:$CLONE_DB" \
  node "$MIGRATIONS_OUTPUT/runner.js" up --dry-run

LIVE_DB_AFTER="$(mb_sqlite_file_fingerprint "$DATABASE_FILE")"
LIVE_CONFIG_AFTER="$(mb_hash_path_file "$MANAGED_PATHS")"
[[ "$LIVE_DB_BEFORE" == "$LIVE_DB_AFTER" ]] || {
  echo "[source-rehearsal] live SQLite changed during rehearsal" >&2
  exit 1
}
[[ "$LIVE_CONFIG_BEFORE" == "$LIVE_CONFIG_AFTER" ]] || {
  echo "[source-rehearsal] managed runtime changed during rehearsal" >&2
  exit 1
}

echo "[source-rehearsal] clone migration and staged runtime validation passed"
