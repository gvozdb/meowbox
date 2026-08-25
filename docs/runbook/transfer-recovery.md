# Federated transfer recovery

Read [remote-panel-common.md](remote-panel-common.md) first.

## Identify the contract

- `GeneratedStream`: direct, backpressured, abortable, idle-timeout, no Range/resume/checksum claim.
- `StagedArtifact`: immutable fsynced artifact with length/SHA-256 and reusable single-Range lease.
- `ExternalProvider`: provider URL such as S3.
- Master fallback: only at or below 100 MiB and within memory/concurrency/rate budgets.

Never retry a generated stream as if it were resumable. Never route a larger browser-unreachable transfer through the master or create a whole-browser Blob.

## Diagnostics

Inspect the owning operation:

```text
GET /api/operations/<operation-id>
```

For a staged download, use the typed absolute delivery contract. A safe client may issue `HEAD`, then one `Range` request with `If-Range`. Do not paste the URL into logs: it contains a transfer secret.

Check operation/artifact/session state, declared length, checksum, expiry, disk reserve, active actor/target streams, abort state, and target browser reachability. The artifact must be `READY` before a lease exists.

## Recovery

- Interrupted staged download: issue a new allowed Range against the same unexpired lease.
- Expired lease with READY artifact: request a new delivery grant through the owning feature flow.
- Interrupted staged upload: let target reconciliation finalize the fixed artifact; do not append blindly.
- Generated stream failure: restart from byte zero only if the source action is explicitly retry-safe.
- Browser unreachable and size >100 MiB: restore target/VPN reachability or use an external provider.
- `NEEDS_ATTENTION`: preserve artifact, lock, and AgentJob evidence; do not delete spool files manually.

Stop on checksum mismatch, RSS increase over 128 MiB, disk reserve breach, unexpected multi-range, compressed/chunked upload, session/resource mismatch, or transfer failure above the canary threshold.

