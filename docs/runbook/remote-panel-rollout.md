# Remote panel rollout

Read [remote-panel-common.md](remote-panel-common.md) first.

## Preconditions

- Target protocol support shipped before master activation.
- `node tools/remote-panel-release-gate.mjs --mode implementation` passes.
- Every required gate in `specs/remote-panel-parity/activation-gates.spec.ctx` has a verified Ed25519-signed `PASS` report.
- `node tools/remote-panel-release-gate.mjs --mode activation --evidence <dir> --public-key <operator-public-key>` passes on the exact non-dev release commit.
- Registry projection, rollback floor, key backup/restore, system migrations, and package rehearsal passed on clones.
- Per-server HTTP, WS, public, and legacy switches are operational.

## State machine

Read current state:

```text
GET /api/servers/<server-id>/federation-rollout
```

Mutations require the current `registryGeneration`, a unique `Idempotency-Key`, and an operator reason:

```text
PATCH /api/servers/<server-id>/federation-rollout
Idempotency-Key: <8-128 printable characters>
{
  "stage": "OBSERVE",
  "expectedRegistryGeneration": 42,
  "reason": "Isolated target observation after all required gates passed"
}
```

Allowed forward path is one step at a time:

```text
DISABLED -> OBSERVE -> READ_ONLY -> CANARY_5 -> CANARY_25 -> BROAD
```

Backward transitions are always allowed and force all target transports off. `DISABLED` and `OBSERVE` cannot relay traffic. `READ_ONLY` enables HTTP only. WS/public delivery require a canary stage and healthy evidence.

Canary requests include every metric accepted by `federation-rollout-policy.ts`. `CANARY_25` and `BROAD` require both a persisted 24-hour stage dwell and at least 24 hours of evidence with 200 HTTP samples. Volume must remain at or below 5% and 25% respectively.

## Stop and rollback

On any stop threshold, submit a same-stage request with `httpEnabled=false`, `wsEnabled=false`, and `publicEnabled=false`; this emergency stop works even while the target is offline and needs no canary evidence. Then move backward or to `DISABLED` with a new registry generation.

Do not roll code below the expand-compatible federation floor after JIT principals or other new-only state exists. Do not roll back schema automatically. Preserve operations, locks, spools, audit, and registry journals.

## Promotion record

For every stage retain:

- stage start/end, registry generation, operator reason;
- manifest revision/protocol and key ID;
- exact bounded metric evidence and evaluator decision;
- release version and target bucket;
- stop/rollback result.

Never record target URLs, opaque public tokens, payloads, or credentials.
