# Federated webhook DLQ and redrive

Read [remote-panel-common.md](remote-panel-common.md) first.

## Inspect

```text
GET /api/servers/webhook-routes/<route-id>/deliveries
```

Use delivery ID/state, attempt count, safe failure code, timestamps, and correlation ID. Never print route tokens, verifier secrets, raw provider bodies, encrypted spool payloads, or target URLs.

Check:

- master disk reserve and queue depth;
- provider signature/timestamp/replay result;
- target trust/capability/public-delivery switch;
- target receipt/deduplication state;
- spool file exists, is encrypted, mode-protected, and referenced by DB metadata;
- per-origin concurrency and retry schedule are within policy.

## Redrive

Fix the cause first. Redrive as ADMIN:

```text
POST /api/servers/webhook-deliveries/<delivery-id>/redrive
```

Redrive reuses the delivery identity and target dedupe contract. Never create a replacement route or edit spool/receipt rows to force delivery.

Stop if provider verification is invalid, the target binding differs, dedupe is uncertain, disk reserve is breached, backlog reaches 800, or oldest delivery exceeds five minutes for ten minutes.

## Route compromise

- Rotate: `POST /api/servers/webhook-routes/<route-id>/rotate`.
- Revoke: `DELETE /api/servers/webhook-routes/<route-id>`.
- Update the provider only with the newly returned opaque URL through its secure configuration channel.
- Keep old deliveries/evidence through retention; do not expose the old token.

DLQ data expires under the seven-day policy only after references and incident holds are cleared.

