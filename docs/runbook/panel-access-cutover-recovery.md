# Panel Access cutover recovery

Read [remote-panel-common.md](remote-panel-common.md) first.

## Before start

- Verify the old endpoint is active and reachable.
- Verify SSH recovery independently.
- Confirm no other cutover is active.
- Candidate is public HTTPS with normal CA validation and enrolled SPKI pin.
- Snapshot target Nginx/firewall/certificate/env state on an authorized fixture/release target.

Start as ADMIN with a unique `Idempotency-Key`:

```text
POST /api/servers/<server-id>/panel-access/cutovers
Idempotency-Key: <8-128 printable characters>
{ <validated Panel Access candidate fields> }
```

Poll:

```text
GET /api/servers/<server-id>/panel-access/cutovers/<cutover-id>
```

The target must stage Nginx/firewall/certificate/listener while the old listener remains active. Activation requires `nginx -t`, pinned API/WS/manifest probes, then a per-browser candidate-origin confirmation:

```text
POST /api/servers/<server-id>/panel-access/cutovers/<cutover-id>/confirm-browser
Idempotency-Key: <8-128 printable characters>
{ "candidateOrigin": "https://candidate.example.net" }
```

## Interruption handling

- Before registry activation: discard/rollback candidate; old endpoint remains active.
- Lost activation acknowledgement: poll the cutover ID and both endpoint generations. Never submit a second cutover.
- Candidate active but browser probe fails: rollback before deadline.
- Registry generation and target listener disagree: stop; preserve both listeners and use SSH recovery.
- Deadline exceeded: expect automatic rollback or `NEEDS_ATTENTION`; do not finalize manually.

Explicit rollback:

```text
POST /api/servers/<server-id>/panel-access/cutovers/<cutover-id>/rollback
Idempotency-Key: <8-128 printable characters>
```

Exit requires previous endpoint restored as `ACTIVE`, candidate marked rolled back, registry projection committed, target context fresh, and SSH still usable. Finalized cutovers require a new reviewed recovery cutover; they cannot be silently reversed.

