# System Overview dashboard release and rollback

Scope: additive read-only Dashboard Overview v1, cached diagnostics, Problems Inbox,
selected-server compatibility adapter, and the operations-first Web dashboard.

## Release gate

- Local API p95 must be at most 750 ms.
- Proxied API p95 must be at most 1500 ms, excluding offline timeout.
- Response must be at most 128 KiB and carry `X-Dashboard-Contract: 1`.
- ADMIN and MANAGER authorization, legacy 404 fallback, offline, and denied flows must pass.
- Visual matrix, keyboard flow, focus trap, reduced motion, and operator hierarchy review must pass.
- One complete PM2 and Nginx drift inventory cycle must finish without scheduler overlap.
- `dashboard_overview_partial_failure_total`, duration, diagnostic failure, and Problem distribution must show no new regression.

Run the candidate checks:

```bash
(cd shared && npm run build)
(cd api && npm run test:dashboard && npm run build)
(cd agent && npm run test:dashboard-diagnostics && npm run build)
(cd web && npm run test:contracts && npx nuxi typecheck && npm run build)
bash tools/healthcheck.sh
```

The current VPS is a production-backed development checkout. Keep
`/opt/meowbox/.dev-mode` and deploy the candidate only with:

```bash
test -f /opt/meowbox/.dev-mode
cd /opt/meowbox
bash tools/dev.sh --no-pull --skip-migrate
```

Never run `make update` on this VPS.

## Migration gate

This release changes no Prisma schema, managed Nginx/PHP-FPM/logrotate/cron/systemd
template, server filesystem layout, environment variable, or OS state. No Prisma or
system migration is required. Re-run this gate against the final diff before tagging.

## Production release

1. Obtain explicit operator approval for desktop and mobile hierarchy and issue wording.
2. Raise `VERSION` before the release commit.
3. Commit as the operator, tag `vX.Y.Z`, and let the release workflow build the tarball.
4. On a release-mode installation, take the normal matched snapshot and deploy the tag.
5. Keep `GET /dashboard/summary` for the compatibility window.
6. Monitor the structured `metrics` samples in `dashboard_overview_complete`,
   `dashboard_overview_proxy_complete`, and `dashboard_diagnostic_complete` logs.

Metric labels are bounded: role, local/proxy, source, Problem code/severity, diagnostic,
and safe failure reason. Entity IDs, names, metric values from the snapshot, paths, and
raw errors are excluded.

## Rollback

Rollback is code-only. The feature owns no persistent rows and requires no schema, env,
filesystem-layout, managed-template, or OS-state reversal.

- Before the updater commit boundary, use the normal release transaction rollback.
- After release, ship a reviewed revert release from the previous known-good code; do not
  switch an old release with `git reset` or a symlink-only rollback.
- On this dev-mode VPS, apply the reviewed revert commit and rerun
  `bash tools/dev.sh --no-pull --skip-migrate` with `.dev-mode` intact.
- Verify API/Web/Agent health and `GET /dashboard/summary` after rollback.

## Validation record — 2026-08-23

- Dev snapshot: `state/data/snapshots/20260823-111202-2296495`.
- Final checks: Shared, API, Agent, and Web builds passed; Nuxt typecheck and
  `git diff --check` passed; API dashboard tests 39/39, Agent diagnostic tests 1/1,
  and Web contract/accessibility tests 20/20 passed.
- Local Overview after the final dev deployment: 20/20 HTTP 200 responses, 25,204-byte
  payloads, measured p50 25.7 ms, p95 45.3 ms, and maximum 75.8 ms. The authenticated
  complete-inventory snapshot was HTTP 200, `X-Dashboard-Contract: 1`,
  `private, no-store`, 25,205 bytes, and
  `runtime.diagnosticsPartial: false`; the unauthenticated request returned HTTP 401.
- Two configured selected remotes: Overview v1 returned 404 and all three bounded legacy
  fallback reads returned HTTP 200; measured proxy maximum 114.8 ms. The dashboard
  polling cycle changed `ProxyAuditLog` row count by zero.
- Current-v1 remote behavior is covered by contract/proxy tests; the configured inventory
  contains no separate current-v1 remote, so real remote sign-off remains an operator
  inventory gate rather than a reason to modify production server configuration.
- A disposable SQLite query-plan fixture with 10,000 sites and 50,000 domains confirmed
  bounded query times (0–2 ms in the measured candidate). Two ADMIN queries use a table
  scan plus bounded sort, but the required-scale fixture showed no material cost; scoped
  MANAGER lookups used the existing ownership and composite domain indexes. The index
  migration gate therefore stayed closed.
- One full diagnostics interval completed from 14:39 through 14:49 local time. After the
  expected startup race, core, Nginx validation, all bounded PM2 batches, the full Nginx
  drift inventory, and two DNS ticks completed successfully without overlap.
- Visual matrix: 80/80 width/theme/state cases passed. Runtime accessibility checks passed
  tap targets, visible focus, dialog trap/restore, reduced motion, headings, lists, and
  progress semantics. Dashboard text/status tokens have explicit WCAG AA contrast tests.
  Final operator screenshots: `dashboard-final-1440-dark.png` and
  `dashboard-final-390-light.png`.
- Migration gate: Prisma schema, managed system templates, environment variables,
  filesystem layout, and OS state are unchanged. Deployment used
  `tools/dev.sh --no-pull --skip-migrate`; `.dev-mode` remains intact.
