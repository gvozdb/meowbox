# Remote-panel parity — architecture debate and consensus record

Status: final planning record  
Decision: consensus  
Plan: [plan.md](plan.md)  
Evidence stamp: `main` at `1b1dab8dd87aa281b1fcdaff129e17d540819bc6`, version `v0.7.35-dirty`, inspected 2026-08-24

## Purpose

This document preserves the alternatives, disagreements, rejected shortcuts, review blockers, wrong-layer findings, spike evidence, and final decisions behind the implementation plan. It is the decision record for DB1–DB12 and Q1–Q8; the executable tasks, tests, migrations, rollout, and acceptance matrices are in [plan.md](plan.md).

The consensus is architectural, not proof that the feature is ready to activate. The named fixture, migration, package, security, load, rollback, and canary gates in the plan remain mandatory.

## Decision criteria

Every option was evaluated against:

1. target-side ownership and existing Prisma foreign keys;
2. consistent HTTP/WS authorization with no privilege promotion;
3. compromise blast radius, replay resistance, rotation, and recovery;
4. public-origin semantics for cookies, raw bytes, long streams, and browser reachability;
5. mixed-version rollout without a fleet-wide big bang;
6. SQLite, agent, Nginx/PHP-FPM, filesystem, and release realities;
7. reversible migrations and an explicit rollback floor;
8. operational simplicity within the current Nuxt/Nest/Prisma/Node/Socket.IO/Nginx/PM2 stack;
9. deterministic failure behavior rather than silent unsafe fallback;
10. coverage of CF1–CF22, A1–A20, SP1–SP8, IM1–IM6, and BN1–BN3.

## Participant roster

| Participant | Model | Reasoning | Role in round |
|---|---|---|---|
| `gpt-5-6-luna` | `gpt-5.6-luna` | ultra | independent draft; review of Sol; wrong-layer adversary; rediscussion |
| `gpt-5-6-sol` | `gpt-5.6-sol` | max | independent draft; review of Terra; substrate spike; rediscussion |
| `gpt-5-6-terra` | `gpt-5.6-terra` | ultra | independent draft; review of Luna; rediscussion; pre-mortem |

All three drafts read the same `brief.md` and `evidence.md` in isolation. Every cyclic review targeted a different model.

## Draft positions

| Area | Luna | Sol | Terra |
|---|---|---|---|
| Core | target-first federation | target-first federation | target-first federation |
| Identity | shadow `User` | shadow `User` | shadow `User` + metadata |
| Trust | Ed25519 delegation; optional mTLS later | per-target Ed25519 over pinned TLS | Ed25519; bootstrap only |
| Registry | DB-backed with JSON compatibility | DB-backed with staged import/projection | DB-backed with reversible JSON import |
| Adminer | direct target with possible narrow gateway | direct target only | direct target only |
| VPN | target-local, no v1 aggregation | master-owned stable subscription with explicit sources | master-owned stable subscription; selected-target default |
| Transfers | signed direct sessions, then refined | staged artifact + direct session | direct signed sessions, then refined |
| Operations | extend `Operation` | target `Operation` + worker/reconciliation | extend `Operation` |
| Private topology | explicit opt-in possible | explicit trusted-private option | public-only initial release |
| Legacy MODX | initially retained `document.write` fallback | replace; bounded legacy fallback in draft | replace; temporary legacy fallback in draft |

The common architecture was strong, but the drafts disagreed on public fallbacks, VPN aggregation, private topology timing, and how much lower-layer detail was required before handoff.

## Cross-review findings

Every reviewer returned `VERDICT: block` for its target draft. These were blockers on implementation readiness, not rejection of target-first federation.

### Luna reviewing Sol

Blockers:

- WS handshake carried one action while the channel could carry many; per-event/channel authorization and replay were unspecified.
- Retaining master-origin `document.write` for MODX could execute target HTML under the master origin.

Major corrections included raw-byte request binding, installation role, per-browser reachability, logout `try/finally`, exact legacy upgrade rail, Panel Access dependency order, target IN audit wiring, route-bound webhook service actors, VPN revocation epochs, scoped operation authorization, lower-layer agent deadlines, exact public-route mapping, transfer rate budgets, and master-key snapshots.

### Sol reviewing Terra

Blockers:

- a signed URL cannot make an on-demand Restic stream seekable or resumable;
- `tools/adminer` is a tracked symlink into persistent runtime, not a second source tree, and the one-time consume path was absent.

Major corrections included a real worker substrate, registry projection after cutover, per-target key scope and authenticated enrollment, a complete HTTP transport envelope, browser-side reachability/CORS, truthful VPN stale semantics, a filesystem-backed webhook spool, exact shadow-user SQL/rollback behavior, update protocol metadata, numeric budgets, executable traceability, and canary stop thresholds.

### Terra reviewing Luna

Blockers:

- a shadow `User` could alter setup, appear in local user administration, or be deleted unless every local-auth/user path changed;
- signed delegation could not verify exact bodies without parser changes and persistent replay state;
- one generic public-link/gateway contract could not safely model Adminer cookies, stable VPN/webhook endpoints, and resumable transfers.

Major corrections included target-canonical operations with master links, guard order, explicit Basic Auth route semantics, per-browser reachability, no generic Adminer gateway, bounded budgets, runnable test integration, and correct acceptance numbering.

## Wrong-layer adversary

The adversary returned `VERDICT: revise-layering`.

Its central conclusion was that federation is the right ownership architecture, but several apparent proxy bugs sit below the proxy:

| Apparent proxy issue | Actual or shared substrate |
|---|---|
| Adminer wrong origin | target Nginx, PHP-FPM, encrypted session cookie, source/runtime deployment |
| delegation body hash | Express/Nest parser order and exact transmitted bytes |
| resumable STREAM | artifact production, seekability, staging, checksum, disk lifecycle |
| “durable Operation” | worker claiming, leases, agent job identity, child-process ownership |
| WS ready/reconnect | channel policy, sequence/replay, upstream lifecycle |
| shadow identity | setup/login/TOTP/profile/users/deletion/role defaults |
| endpoint normalization | actual pinned dialer, TLS/SNI, firewall, browser network |
| provisioning | installer/env/templates/system migrations |
| Panel Access | distributed endpoint generations and recovery |
| rollback | SQLite/WAL, master key, registry projection, trust, spools, runtime config |

It also preserved BN1–BN3 as baseline/local issues: the health 410 is intentional, direct webhook raw-body parsing is locally incomplete, and Nginx inactivity affects local calls independently of the master relay.

## Spike and its limits

The first rediscussion reached architecture consensus but split on executable approach and two assumptions. A bounded throwaway-worktree spike was run.

The spike job reached a timeout status, but persisted a complete source-backed artifact ending `SPIKE_RESULT: supports`. Its source inspection established:

- the existing API process and scheduler make an in-process SQLite lease worker plausible without a new daemon;
- current operations lack leases/heartbeats and startup currently fails active work;
- current agent job ownership is incomplete;
- Nest and PHP already share compatible AES-GCM Adminer primitives;
- `tools/adminer-src` is source while `tools/adminer` is a persistent symlink;
- parser ordering, unsafe HTTPS-by-IP, and DNS validation/dial TOCTOU require correction before activation;
- package/release test aggregation is incomplete.

The spike’s unrun fixture results were not accepted as proof. Two spike proposals were rejected:

- HMAC delegation was replaced by the agreed per-target Ed25519 signature while retaining the spike’s exact request canonicalization.
- Removing shadow users/nullable operator ownership was rejected because AI and other ownership FKs require a stable target `User`. Service actors remain separate.

The spike’s exact Adminer handoff/cookie mechanism, worker stop criteria, task/test IDs, initial budgets, and canary thresholds were adopted.

## DB1 — shadow User versus new Principal model

### Selected

Use a shadow `User` for each federated operator plus a one-to-one `FederatedPrincipal`.

- Unique federation identity is `(issuerId, subject)`.
- `User.identityKind` separates `LOCAL` and `FEDERATED`.
- Shadow rows use reserved collision-safe username/email values, an unretained random password hash, and the least current persisted role; request authorization ignores that stored role.
- Effective authorization is delegation permissions ∩ target issuer policy ∩ action descriptor.
- Setup and every local auth/profile/password/TOTP/session/user-admin path filter to local identities.
- Federated rows are hidden from `/users`, immutable there, and tombstoned instead of deleted.
- AI, Site, BackupExport, Operation, audit, and other ownership FKs remain valid.
- Machine delivery uses a separate `ServicePrincipal`, never a shadow operator.

### Rejected

- Continue using the oldest target ADMIN: breaks ownership, AI, profile/security, audit, and multi-operator isolation.
- New polymorphic Principal replacing `User`: requires a broad FK/service rewrite with materially greater migration and rollback risk.
- Actor snapshots without a target `User`: insufficient for `AiSession.userId` and existing ownership.

### Consequences

Additive schema plus careful filters are required. Rollback to `v0.7.35` ends before the first federated JIT row; afterward the floor is an expand-compatible federation release.

## DB2 — Ed25519 versus HMAC versus mTLS

### Selected

Per-master-target Ed25519 delegation over pinned, authenticated TLS.

- One relationship keypair limits cross-target blast radius.
- Target holds the public key, not a symmetric minting secret.
- Assertion binds concrete target path/query, headers, body digest, action, actor, audience, role/permissions, request/idempotency/operation identity, expiry, and replay ID.
- Mutation/WS replay is persisted and consumed atomically.
- Enrollment is SSH/out-of-band fingerprint-bound and bootstrap material is one-use.
- Routine rotation has bounded dual-key verification; compromise has no grace.

### Rejected

- Per-server HMAC as operator delegation: target compromise exposes material that can forge the master for that target; spike did not show a need for symmetric signing.
- Global HMAC/static `PROXY_TOKEN`: ambient ADMIN bearer, no operator/action/audience/expiry semantics.
- Forward master JWT: wrong target secret/audience and unsafe coupling.
- mTLS alone: authenticates transport, not operator/action/body/audit. It remains an optional later transport layer.

### Consequences

Key storage, backup, target manifest signing, replay pruning, clock discipline, and compromise runbooks become release requirements. Provider webhooks may still use provider-required HMAC over raw bytes; that is a separate contract.

## DB3 — delivery strategy by public surface

### Selected

| Surface | Delivery |
|---|---|
| Adminer/Manticore | direct target one-time handoff and target-origin cookie; no master gateway |
| VPN subscription | stable master public gateway backed by explicit target sources |
| Deploy webhook | stable opaque master ingress, provider verification, encrypted spool, signed service delivery |
| Large transfer | direct target generated stream or staged artifact session; bounded small master fallback |
| S3 | external provider URL unchanged |
| MODX/domain login | direct target one-time top-level handoff |
| Site migration | current constrained direct source→target pull |
| Ordinary authenticated API | master relay with delegated identity |

### Rejected

- Generic public relay for target `@Public` routes: confused-deputy and scope escalation.
- Page-specific `window.location.origin`/URL concatenation: repeats the present origin bug.
- Master gateway for Adminer v1: would need full isolated stateful application proxying, cookie jars, redirects, paths, forms, and asset rewriting.
- Route every transfer through master: memory, bandwidth, timeout, and availability bottleneck.

### Consequences

Full Adminer parity requires browser reachability to the target. Browser-unreachable Adminer is explicitly unavailable, not silently proxied.

## DB4 — VPN ownership, aggregation, and partial outage

### Selected

Master owns a `FederatedVpnSubscription` stable public token and ordered source membership. Target `VpnUser`/services own credentials.

- New subscription defaults to the selected target.
- Aggregation is explicit opt-in, never implicit fleet-wide and never name-matched.
- Deterministic configured source/service ordering.
- Deduplicate only identical canonical credential/endpoint fingerprints.
- Master token/source changes revoke immediately.
- Target credential revocation during outage is bounded by signed fragment epoch/expiry; it cannot honestly be immediate.
- Encrypted cached fragments may be stale for at most the configured five-minute initial window; afterward omit the source or return 503 if none remains.
- Public output omits internal target metadata and exposes partial/stale state only through safe headers/comments.

### Rejected

- Target-local URL only with no stable fleet identity: does not satisfy stable URL/QR or optional aggregation.
- Automatic aggregation by username: privacy and ownership collision.
- Unbounded last-known-good cache: stale credential exposure.

### Consequences

Master stores sensitive cached configuration encrypted. Partial outage and revocation windows must be documented.

## DB5 — async operations versus longer synchronous relay budgets

### Selected

Extend the existing target `Operation` and add a real lease/reconciliation worker plus durable agent-job protocol. Master stores only `RemoteOperationLink`.

- Convert genuinely long/non-idempotent mutations and long scans to `202 + operationId`.
- Keep bounded ordinary CRUD synchronous.
- Keep generated streams as streams.
- Preserve already-asynchronous SP3 actions and link their existing IDs; do not enqueue duplicates.
- Every CF17 action receives an explicit classification in Phase 0.
- Lost non-idempotent effects become `NEEDS_ATTENTION`; never blind retry.

### Rejected

- More `LONG_RUNNING_PATHS`: stale prefix matching and ambiguous success.
- Only increase 30/600-second totals: target can continue after master failure.
- Add a second independent remote-job state machine: conflicts with target ownership and locks.
- New broker/daemon immediately: unnecessary until measured stop criteria require it.

### Consequences

The no-broker worker is a gated default, not a proven capacity claim. Broker/separate worker is required if the measured queue, concurrency, SQLite, replica, agent-restart, or process-ownership stop criteria fail.

## DB6 — public-only versus trusted private networks

### Selected

Full v1 activation is public-origin only. The schema may reserve `TRUSTED_PRIVATE`, but it stays disabled until a separate pinned private-network fixture and operator policy are approved.

### Rejected

- Disable SSRF validation for private targets.
- Trust a hostname because enrollment succeeded.
- Treat master reachability as browser reachability.

### Consequences

Some private/VPN fleets are deferred. This is a product scope compromise in favor of safe initial delivery; it does not prevent a later explicitly enrolled private topology.

## DB7 — servers.json versus DB-backed registry

### Selected

Master-only Prisma registry with preserved server IDs, encrypted trust/legacy secrets, endpoint generations, enrollment, capabilities, status reasons, kill switches, and cutover history.

- JSON remains authoritative before cutover.
- During the rollback window, DB is authoritative and writes a journaled, mode-0600 legacy compatibility projection.
- Projection failure freezes registry mutation.
- Registry import/cutover is an application transaction on a master-role installation, not a generic system migration on every target.
- After new-only state/JIT, rollback stops at an expand-compatible release.

### Rejected

- Enrich one JSON record indefinitely: poor atomicity, key lifecycle, indexing, and rollback semantics.
- Delete JSON immediately after import.
- Fall back to a stale unchanged JSON after endpoint/key writes.

### Consequences

More Prisma and migration work, but correct transactions and rollback evidence. Snapshot must include SQLite/WAL and the master key together.

## DB8 — main in fleet update and protocol skew

### Selected

`main` is a separate view model and update workflow.

- No edit/delete/remote checkbox/bulk mutation.
- Tags and signed release compatibility metadata are master-owned.
- Remote update is allowed only when master/target protocol ranges overlap.
- Verify post-update manifest; disable/roll back on skew.
- Nested remote fleet remains unavailable.

### Rejected

- Virtual main as `ServerConfig`.
- Mixed bulk silently ignoring main.
- Fetch tags from whichever remote is selected.
- Product semver alone as compatibility proof.

## DB9 — minimum legacy contract and removal

### Selected

- Full parity requires federation protocol 1.
- Manifest-less compatibility is named `legacy-static-v0`, not assigned an invented product semver.
- Exact allowlist: dashboard reads required by SP1 and a narrowly scoped ADMIN-only update check/trigger/status rail to reach v1.
- No auth/users/ownership/public gateways/terminal/AI WS/arbitrary mutation/MANAGER legacy access.
- The existing site-migration minimum `v0.6.59` remains scoped only to migration.
- Remove legacy after zero registered legacy peers and zero fallback use for at least 30 days spanning at least two released versions, successful rollback/key drills, and operator approval.

### Rejected

- Big-bang fleet upgrade.
- Raw 404/schema errors as capability detection.
- Broad oldest-ADMIN fallback.
- Guessing one product version as a universal protocol floor.

## DB10 — browser reachability and fallback

### Selected

Browser reachability is per requester/session/surface.

- Direct Adminer/MODX/native download/programmatic upload/WS have separate probes and CORS/TLS needs.
- Master health never proves browser reachability.
- Adminer has no gateway fallback.
- Transfer fallback is allowed only within the configured small master budget; larger unreachable transfers require target/VPN access or external storage.

### Rejected

- One globally cached browser-reachable flag.
- Expose private control endpoints in browser DTOs.
- Silent generic master fallback.

## DB11 — MODX document.write

### Selected

Protocol-1 target returns a direct target one-time top-level handoff. Manifest-less targets show upgrade/manual-access guidance.

### Rejected

- Fetch target HTML and `document.write` under master origin, even with a warning.
- Treat an auth-failed target as legacy.

### Consequences

Legacy convenience is reduced to preserve master-origin isolation.

## DB12 — Basic Auth and Panel Access semantics

### Selected

- Master Nuxt Basic Auth protects master origin only and always calls master API.
- Selected remote Panel Access/Basic Auth controls direct target origin.
- Ordinary target UI/Adminer follows the target route map.
- Scoped public VPN/webhook/transfer/handoff routes intentionally bypass Basic Auth and use their narrow tokens.
- Master relay does not forward Basic Auth.
- UI names the two boundaries explicitly.

### Rejected

- Imply one Basic Auth toggle protects both origins.
- Proxy target Basic Auth through master.
- Apply Basic Auth to subscription/webhook clients that cannot answer a browser challenge.

## Q1–Q8 resolution

| Question | Status | Decision / recommended default |
|---|---|---|
| Q1 principal model | resolved, formerly blocking | shadow `User` + `FederatedPrincipal`; separate service principals |
| Q2 trust protocol | resolved, formerly blocking | per-target Ed25519 over pinned TLS |
| Q3 public delivery | resolved, formerly blocking | surface-specific table in DB3 |
| Q4 VPN ownership | resolved, formerly blocking | master subscription identity, explicit ordered target sources, bounded partial outage |
| Q5 private remotes | non-blocking policy | public-only v1; private activation deferred |
| Q6 Panel Access/Basic Auth | resolved | origin-local route semantics in DB12 |
| Q7 main update | resolved | separate master workflow |
| Q8 legacy minimum/window | resolved | protocol 1 for full parity; named `legacy-static-v0`; measurable removal gate |

No unresolved operator choice blocks implementation. Unrun technical probes block activation of affected capabilities, not implementation of the agreed plan.

## Vote table

| Vote | Luna | Sol | Terra | Result |
|---|---|---|---|---|
| First rediscussion — architecture | reached | reached | reached | reached |
| First rediscussion — approach | split | split | reached | split |
| First rediscussion — assumptions | split | reached | reached | split |
| Post-spike — architecture | reached | reached | reached | consensus |
| Post-spike — approach | reached | reached | reached | consensus |
| Post-spike — assumptions | reached | reached | reached | consensus |

## Consensus resolution table

| Split or blocker | Resolution | Evidence/gate |
|---|---|---|
| WS multi-action authorization | signed channel action set + event action/sequence/epoch; optional per-event signature | `T-WS-*` |
| unsafe shadow user | local/federated filtering, tombstones, service split, rollback floor | `T-AUTH-*` |
| Ed25519 vs spike HMAC | Ed25519 retained; exact spike canonicalization adopted | `T-SIG-*`, `T-DIAL-*` |
| Adminer gateway/session | direct-only atomic Nest handoff and fixed encrypted PHP cookie | `T-ADM-*` |
| STREAM resume | generated non-resumable stream vs staged immutable artifact | `T-XFER-*` |
| persistence without worker | in-process lease worker + AgentJob + process ownership; measured stop criteria | `T-OPS-*` |
| raw webhook bytes | pre-parser capture, provider validation, encrypted spool, service actor | `T-WEB-*` |
| VPN immediate revoke contradiction | immediate master revoke; target revoke bounded by signed fragment expiry | `T-VPN-*` |
| registry rollback | compatibility projection, mutation freeze, expand-compatible floor | `T-REG-*` |
| browser reachability | per-session/per-surface, direct unavailable if unreachable | `T-BR-*` |
| private topology | disabled for initial activation | separate future gate |
| plan executability | stable `SUB-*` and `T-*` IDs, budgets, stop thresholds | `T-TRACE-001`, `T-CAN-001` |

## Consequences

### Compatibility

Target-first dual stack preserves old masters during grace. New masters use protocol 1 only when advertised and otherwise expose a tightly constrained legacy mode. Newer/incompatible targets fail explicitly.

### Security

The design removes ambient ADMIN authorization from the normal path and limits public surfaces by purpose. It adds more key, replay, grant, and spool state that must be backed up, redacted, rotated, and monitored.

### Complexity

Complexity moves from scattered page exceptions into shared contracts, registry/trust, a worker protocol, and explicit public surfaces. This is larger than a URL fix but avoids duplicated behavior and does not add a new broker by default.

### Operations

Direct Adminer and large transfers introduce browser/topology prerequisites. The no-broker worker requires strict capacity and process-ownership gates. Panel Access becomes a distributed transaction with SSH recovery. Rollback has a clear compatibility floor.

### Migrations

The feature needs additive Prisma migrations plus idempotent, role-aware system migrations for secure state, Adminer runtime synchronization, Nginx/PHP-FPM templates, spools, and existing-panel regeneration. Registry import is master application logic, not a fleet-wide system migration.

## Residual unresolved risks

These are not undecided architecture; they are activation gates:

- exact path/query/header/raw-byte preservation through the real Nginx→Express→Undici→Nginx→Nest path;
- selected-address dialer and TLS/SPKI behavior for HTTP and Socket.IO;
- real Node-encrypted/PHP-decrypted Adminer cookie behavior;
- SQLite lease contention and API/agent crash reconciliation;
- full child-process ownership;
- staged-artifact disk and transfer performance;
- webhook/VPN parser and spool load;
- dependency-backed aggregate tests and release packaging;
- private-network demand that exceeds public-only v1;
- workload that exceeds the no-broker worker stop criteria.

The plan fails safely by withholding activation when these gates do not pass; it must not substitute static bearer auth, insecure TLS, generic gateway behavior, or blind retries.
