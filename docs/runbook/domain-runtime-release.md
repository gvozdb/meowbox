# Domain-runtime release runbook

This runbook describes the release transaction used for the domain-centric
application migration. It is intentionally fail-closed: an update stops before
maintenance if its candidate cannot prove the database and managed runtime
transition.

## Operator commands

Run the real preflight first. It downloads/stages the candidate in a temporary
directory, uses a SQLite backup clone, and does not change the live database,
managed Nginx/PHP-FPM/logrotate files, services, or `current` symlink.

```bash
make update-dry-run v=vX.Y.Z
```

The same preflight is mandatory in a normal update:

```bash
make update v=vX.Y.Z
```

Normal updates retain redacted JSON and text reports below
`state/data/migrations/reports/`. A read-only dry-run writes only redacted
reports below `${TMPDIR:-/tmp}/meowbox-release-reports/` (or
`MEOWBOX_DRY_RUN_REPORT_DIR`) and removes its SQLite clone on exit. A passed
report records hashes of the durable live SQLite input (`.db`, WAL, journal;
SHM lock/index bytes are intentionally excluded) and
the managed runtime artifact tree before and after the clone run. Hashes must
match exactly.

Do not run `tools/snapshot.sh` or `tools/update.sh` manually against a live
production installation while diagnosing a release. The updater creates the
matched transaction snapshot itself.

## Required candidate hooks

The release layer does not render application runtime files or gate API writes;
those responsibilities belong to the API/agent runtime workstreams. The
candidate must therefore supply these hooks (either with the matching
environment variable or as the candidate paths named below):

| Responsibility | Environment override | Candidate fallback | Required behaviour |
| --- | --- | --- | --- |
| Active-operation/maintenance gate | `MEOWBOX_QUIESCE_HOOK` | `migrations/dist/quiesce.js` | `check`, `quiesce`, and `resume`; reject new panel writes, wait for active domain jobs, pause schedulers and agent mutations while hosted Nginx/PHP remains serving. |
| Legacy mapper evidence | `MEOWBOX_MAPPER_EVIDENCE_HOOK` | `migrations/dist/runtime-evidence.js` | `scan` reads the current managed Nginx/MODX runtime only, writes redacted `domains[domainId].phpEnabled` / `modxDatabaseName` evidence, and never changes live files or SQLite. |
| Stage renderer | `MEOWBOX_RUNTIME_RENDER_HOOK` | `migrations/dist/runtime-renderer.js` | Render only into `--stage`; emit `--manifest`; never write live paths in `dry-run` mode. |
| Stage validator | `MEOWBOX_RUNTIME_VALIDATE_HOOK` | `migrations/dist/runtime-validator.js` | Validate the complete staged PHP-FPM and Nginx configuration, services, socket limits, custom-config references and resource envelope. |
| Runtime switch/repair | `MEOWBOX_RUNTIME_APPLY_HOOK` | `migrations/dist/runtime-apply.js` | `switch` reloads affected PHP-FPM units, verifies sockets, then gracefully reloads Nginx. `cleanup` removes only post-commit obsolete artifacts idempotently. |
| Agent health | `MEOWBOX_AGENT_HEALTH_HOOK` | `migrations/dist/agent-health.js` | `check` is read-only in dry-run; `verify` proves the restarted agent can serve its required control-plane work. |
| Representative API read | `MEOWBOX_REPRESENTATIVE_READ_HOOK` | `migrations/dist/representative-read.js` | `check` is read-only in dry-run; `verify` performs an authenticated, side-effect-free representative API read against the new release. |

Hook arguments are explicit and contain no secrets:

```text
--mode dry-run|apply --db <panel-db> --stage <candidate-stage> --manifest <manifest>
scan --mode dry-run|apply --db <panel-db> --output <runtime-evidence.json>
--transaction <id> --candidate <release-dir> --database <panel-db> --timeout <seconds>
check|verify --release-dir <release-dir> --manifest <manifest> --database <panel-db>
```

`runtime-renderer` also accepts an explicit normalized
`--release-root <candidate-root>` for source-tree rehearsal. Normal updates
omit it and resolve the root from the published candidate itself.

When the final domain runtime schema exists, a missing renderer/validator/apply
hook blocks the update. This is deliberate; no release script may infer
ownership of arbitrary `/etc` files or pretend a PHP/Nginx candidate was
validated.

## Release tuning

`tools/update.sh` reads these non-secret defaults from `state/.env`. An
explicit process environment value wins:

```dotenv
MEOWBOX_QUIESCE_TIMEOUT=120
MEOWBOX_RELEASE_MIN_FREE_KB=524288
```

The timeout accepts 1–1800 seconds. The free-space reserve is KiB and covers
the candidate, SQLite clone and matched rollback snapshot. Hook paths,
transaction IDs, staged runtime paths and health flags are transient
per-update inputs; do not persist them in `state/.env`.

## Runtime-manifest boundary

The renderer emits version `1` JSON. Every artifact has one of `create`,
`replace`, or `delete`, an allowlisted absolute target, and for writes a staged
file plus SHA-256. Only these paths are allowed:

- `/etc/nginx/meowbox/**`
- `/etc/nginx/sites-available/**` and `/etc/nginx/sites-enabled/**`
- `/etc/nginx/conf.d/meowbox-zones.conf`
- `/etc/php/<version>/fpm/pool.d/*.conf`
- `/etc/logrotate.d/meowbox*`

The manifest also names PHP-FPM services, expected sockets, and selected
domain HTTP probes. New `create` artifacts must state mode/uid/gid explicitly;
replacements preserve existing metadata unless the manifest gives a complete
uid/gid pair. A staged file checksum, symlink/path escape, duplicate target,
unsafe service/socket, or invalid probe blocks before maintenance. The system
migration refuses to write through an existing target symlink. Deletions are
deferred until after final health succeeds.

## Release phases and rollback boundary

The updater records a durable journal in
`state/data/migrations/release-transactions/<id>/journal.json` and takes one
exclusive OS `flock` shared with the system migration runner.

1. `stage` downloads, verifies, extracts and installs the candidate outside
   `current`; package contents must include Prisma SQL, compiled migration
   runner, release CLI, supported fingerprint contract, and the new system
   migration.
2. `dry-run` clones SQLite with the online backup API, assesses the exact
   baseline, binds the deterministic migration map to the pre-history clone
   image, applies only approved baseline records, runs `prisma migrate deploy`,
   invariants, staged render/validation, and proves live hashes did not change.
3. `snapshot` creates a second consistent SQLite backup and a GNU tar archive
   of the exact managed config union with numeric owner, mode, ACL, xattr and
   symlink metadata. It also records `current` and PM2 state.
4. `quiesce` invokes the maintenance hook. A failure here or later arms
   rollback.
5. `database` rechecks the dry-run source hash, rebuilds the map after
   quiescence, runs only baseline + `prisma migrate deploy`, then invariants.
6. `runtime` rerenders and revalidates the candidate; its canonical artifact
   plan must equal the dry-run plan.
7. `switch` writes only staged manifest artifacts through the checkpointed
   system migration, runs the runtime switch hook, atomically swaps `current`,
   and reloads PM2.
8. `verify` requires PM2 API/Web/agent status, a non-5xx API result, Web build
   artifact/version, `nginx -t`, declared services/sockets/probes, and final
   SQLite invariants. Domain probes are compared with the read-only preflight
   baseline: a new or changed failure blocks the release; an exact pre-existing
   status may pass without being misreported as newly healthy.
9. `commit` marks the journal boundary and reopens writes. It performs
   idempotent post-commit cleanup and repeats strict health (including agent
   and representative read hooks); only then does it write
   `state/.update-success`. Cleanup/report failures are forward repair, not a
   database rollback boundary.

Any failure from `quiesce` through `verify` automatically invokes:

```bash
tools/rollback.sh precommit <transaction-id>
```

It restores SQLite (and removes stale WAL/SHM), the metadata-preserving managed
runtime archive, the previous release symlink, old PHP-FPM/Nginx state, and
old panel health. Candidate logs and the transaction journal are retained.

Once `committed: true` is in the journal, automatic database rollback is
forbidden. A cleanup/reporting failure is repaired forward; a later operator
rollback requires explicit maintenance and a new matched snapshot.

## Recovery and inspection

List retained transaction data and report paths without changing the system:

```bash
find state/data/migrations/release-transactions -maxdepth 2 -name journal.json -print
find state/data/migrations/reports -maxdepth 1 -type f -print
```

Only use pre-commit recovery for an uncommitted journal:

```bash
bash tools/rollback.sh precommit <transaction-id>
```

`rollback.sh release` intentionally refuses a symlink-only rollback. Switching
old code onto a new SQLite schema is unsafe.

For an explicitly chosen manual snapshot, use:

```bash
bash tools/rollback.sh snapshot <snapshot-name>
```

This restores the coupled SQLite/config/release layers; it is an operator
maintenance action, not an automatic post-commit recovery.

## Baseline and mapper safety

`migrations/dist/release-cli.js` handles schema fingerprints, baseline,
legacy mapping, and invariant checks. It never runs a schema sync command.
Baseline is allowed only for an empty migration history whose exact table,
column, foreign-key, and index fingerprint matches a named supported profile
(`pre-domain-applications-2026-07-30` in this release). Explicit fingerprint
aliases cover only reviewed production schema variants that share the same
approved Prisma migration set. A truly empty SQLite database is fresh and goes
straight to `migrate deploy`; every other unknown or drifted schema blocks.
Valid history is matched by migration name and checksum, independent of
historical application order. Partial, rolled-back, unknown, or drifted
history is a blocker.

System-migration history is checked independently from Prisma history. Applied
compiled artifacts must match their current checksum unless
`migrations/system-history.ts` binds the exact stored checksum to the exact
reviewed current artifact. The same contract records two retired, early VPN
bootstrap artifacts: the failed Xray row is accepted only with its exact error
fingerprint and the exact successful follow-up repair migration; the successful
AmneziaWG bootstrap is accepted only with its exact deployed checksum. Unknown
orphans, changed failure logs, missing superseders, and stale compatibility
entries block before maintenance. Fresh installs never receive retired rows.

The mapper is read-only until an explicit clone/live write mode is selected.
It never prints encrypted values, environment values, passwords or MODX config
secrets. The live map is rebuilt after quiescence and must have the same
deterministic map hash as the clone report.

For a legacy database it writes the exact version-1
`_meowbox_domain_migration_map` contract consumed by the Prisma table-copy
migration: one `SITE`, `DOMAIN`, and `DATABASE` row per legacy source with the
`(row_kind, source_id)` primary key. It refuses a pre-existing table with a
different shape or a stale/partial row set. Pool custom directives and a
preserved application error are kept out of the public report; a value that
looks credential-bearing blocks the release rather than being placed in the
staging map.

If a PHP-enabled legacy secondary would inherit a custom pool containing
worker-resource directives (`pm.max_children`, `pm.start_servers`, and related
limits), the mapper blocks. The future runtime-evidence/renderer hook must
provide an explicit per-domain resource-envelope allocation; copying a whole
Site pool to every secondary could silently multiply worker capacity.
