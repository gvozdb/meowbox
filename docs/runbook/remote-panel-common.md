# Remote panel: common safety and evidence rules

Use this preamble for every federation runbook.

## Hard safety boundary

- Never activate, release, migrate, or run real-target fixtures from `/opt/meowbox` while `.dev-mode` exists.
- Never remove or move `.dev-mode`.
- Never run `make update` on the current development VPS.
- Never use `prisma db push`, edit an applied migration, change trust rows manually, or copy private keys between installations.
- Use an isolated public test target. Private/loopback/CGNAT/link-local/metadata endpoints are not protocol-1 targets.
- Before an authorized release-target mutation, run the established `make snapshot` transaction and verify the snapshot contains SQLite/WAL, master key, registry projection, trust state, spools, and runtime configuration.

Read-only source gate:

```bash
node tools/remote-panel-release-gate.mjs --mode implementation
node tools/remote-panel-release-gate.mjs --mode activation \
  --evidence /path/to/redacted-evidence \
  --public-key /path/to/operator-ed25519-public.pem
```

`activation: BLOCKED` is expected while any external gate is `UNRUN` or while `.dev-mode` exists.

Generate a strict unsigned report template, fill it only from an isolated fixture, then sign it without copying the private key into the repository or evidence directory:

```bash
node tools/remote-panel-activation-evidence.mjs template --gate T-SIG-REAL > /tmp/T-SIG-REAL.unsigned.json
node tools/remote-panel-activation-evidence.mjs sign \
  --input /tmp/T-SIG-REAL.unsigned.json \
  --output /path/to/redacted-evidence/T-SIG-REAL.json \
  --private-key /secure/operator-ed25519-private.pem
node tools/remote-panel-activation-evidence.mjs verify \
  --gate T-SIG-REAL \
  --evidence /path/to/redacted-evidence \
  --public-key /path/to/operator-ed25519-public.pem
```

The verifier rejects non-canonical reports, unknown checks, failed thresholds, short canary intervals, digest drift, symlinks, URLs, auth headers, cookies, private keys, and unsigned evidence. It binds the complete bundle to one release version, repository commit, and operator key.

## Common state checks

Use an authenticated ADMIN session against the master. Never place session values in shell history or runbook evidence.

```text
GET /api/servers
GET /api/servers/<server-id>/context
GET /api/servers/<server-id>/federation-rollout
GET /api/servers/audit?serverId=<server-id>&limit=100
GET /api/operations?limit=100
```

Expected activation prerequisites:

- topology `PUBLIC`;
- protocol `1` and a current signed manifest;
- transport `ONLINE` with future `freshUntil`;
- trust `ACTIVE` with future `freshUntil`;
- capability state `FRESH` or explicitly reviewed `PARTIAL`;
- active endpoint generation verified;
- relevant HTTP, WS, or public-delivery kill switch enabled only through rollout policy.

## Evidence rules

Keep only:

- server registry ID and installation ID;
- action ID, request ID, operation ID, correlation ID, key ID;
- protocol, state, reason code, timestamps, bounded metrics, HTTP status;
- config digests, certificate/SPKI fingerprints, checksums, migration IDs;
- redacted command output and test reports.

Never retain:

- assertions, private keys, bootstrap proofs, session cookies, bearer tokens;
- webhook/VPN/Adminer/transfer secrets;
- raw webhook bodies, credentials, database DSNs;
- public URLs containing opaque tokens or private endpoint metadata.

## Universal stop points

Stop and disable the affected target immediately on:

- signature, replay, pinned-TLS, role, target, or actor mismatch;
- missing mutating OUT/IN audit correlation;
- local login by a federated identity;
- duplicated non-idempotent effect or unsafe retry;
- registry projection or endpoint-generation disagreement;
- unowned child process, checksum mismatch, secret leak, or accepted Adminer replay;
- any threshold returned by the rollout evaluator.

Do not delete locks, operations, spools, journals, or evidence after a stop. Recover forward or use the documented compatible rollback floor.
