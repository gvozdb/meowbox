# Remote panel incident response

Read [remote-panel-common.md](remote-panel-common.md) first.

## Classify

Read master context, rollout, audit, and operations. Classify separately:

- transport: offline, DNS, TLS, connect/header/idle timeout;
- trust: key mismatch, revoked, replay, assertion failure;
- capability: stale, partial, incompatible, unknown action;
- browser: direct surface unreachable;
- operation: recovering, unknown recovery, needs attention;
- registry: projection frozen or endpoint generation mismatch;
- public surface: Adminer, VPN, webhook, transfer;
- WS: not ready, reconnect storm, stale epoch, backpressure.

Do not collapse these into “offline”.

## Contain

For ordinary failure, disable the affected surface through the rollout API. For a security signal, revoke the relationship using [federation-key-rotation.md](federation-key-rotation.md). Leave unrelated targets active only if evidence shows no shared compromise.

If registry projection is `FROZEN`, stop registry mutation and repair projection from the DB authority using the application recovery path. Never overwrite `servers.json` by hand.

If an operation is `NEEDS_ATTENTION` or `UNKNOWN_RECOVERY_REQUIRED`, keep its locks and inspect its AgentJob/process evidence. Never blind-retry a non-idempotent action.

## Evidence

Capture redacted:

```text
GET /api/servers/<server-id>/context
GET /api/servers/<server-id>/federation-rollout
GET /api/servers/audit?serverId=<server-id>&limit=500
GET /api/operations?status=NEEDS_ATTENTION&limit=100
```

Record request/operation correlation IDs, key ID, state/reason, duration, peer/browser IP, release version, manifest revision, and bounded metric window. Never capture assertion headers or public URLs containing tokens.

## Recovery

- Offline/DNS/TLS: restore the canonical pinned endpoint; do not weaken SSRF or TLS checks.
- Trust mismatch: keep disabled, revoke, verify fingerprints out of band, re-enroll.
- Capability/version skew: deploy a compatible target release and ingest a fresh signed manifest before enabling.
- WS storm: disable WS only; keep browser-master socket, then verify a fresh epoch and explicit subscription replay.
- Registry mismatch: stop endpoint/provisioning mutations; reconcile journal and projection before resuming.
- Public delivery: use the dedicated Adminer/VPN/webhook/transfer runbook. Never replace it with a generic proxy.

Exit only after the affected gate is rerun, OUT/IN audit correlates, no stop threshold remains, and rollout restarts from the safe prior stage.

