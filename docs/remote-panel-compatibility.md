# Remote panel compatibility and rollback floor

Full parity requires federation protocol 1 and compatible signed manifest/action schemas. Product SemVer is informational; protocol ranges and capabilities decide compatibility.

Modes:

- `disabled`: no federation traffic;
- `observe`: signed state observation, no relay;
- `v1-read-only`: catalogued target reads only;
- `v1-enabled`: catalogued reads/mutations/operations and independently gated WS/public surfaces;
- `legacy-upgrade-only`: exact dashboard reads plus narrow ADMIN update rail; no identity-sensitive fallback.

Unknown actions, schema versions, methods, routes, events, or manifest-less auth failures fail closed. A newer compatible target must advertise protocol overlap. Target update success requires a fresh signed post-update manifest.

`main` is a separate control-plane node: no edit/delete/bulk remote mutation. Auth lifecycle, registry, fleet, audit, palette, site-migration orchestration, and master Basic Auth remain master-owned. Recursive target fleet management is unavailable.

Rollback:

- Before federation activation/JIT state: return to a verified JSON registry and previous compatible release only through the normal release transaction.
- After the first federated principal or other new-only state: never run `v0.7.35`; disable capabilities and roll back only to an expand-compatible federation release.
- Never automatically roll back committed schema or blindly retry non-idempotent operations.

Legacy retirement requires zero registered legacy peers, zero fallback use for at least 30 days across at least two releases, successful rollback/key drills, and explicit operator approval. Until then, keep the exact allowlist and telemetry; never broaden it.

