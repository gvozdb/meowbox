# Remote-panel parity — executable implementation plan

Status: approved architecture; implementation and activation gated  
Decision: consensus  
Decision record: [debate.md](debate.md)  
Repository stamp: main at 1b1dab8dd87aa281b1fcdaff129e17d540819bc6, VERSION v0.7.35, dirty worktree  
Planning date: 2026-08-24

## Problem

Selecting an additional Meowbox server currently changes ordinary frontend requests into a generic master-to-target relay, but the panel is not a uniform REST application. Authentication, ownership, public links, WebSocket channels, long operations, direct files, Nginx/PHP-FPM applications, provisioning, topology, and fleet controls have different owners and transport requirements.

The present relay is route-reachable for much same-version ADMIN CRUD, but it gives incorrect or unsafe behavior across CF1–CF22:

- authentication and recovery can be sent to an offline selected target;
- HTTP impersonates the oldest target ADMIN while WS creates a synthetic ADMIN;
- MANAGER policy differs between HTTP and WS;
- target ownership, AI history, activity, and audit are misattributed;
- target-relative public links open at the master;
- external webhooks cannot enter through the ADMIN-only relay;
- long mutations time out ambiguously and large transfers buffer through the master/browser;
- provisioning records the wrong endpoint and requires a target ADMIN that may not exist;
- Panel Access can change the target endpoint without updating the master registry;
- Socket.IO has no target-ready or reconnect/resubscribe contract;
- capability, topology, fleet-main, and rate-limit boundaries are implicit.

This is a cross-layer protocol problem. It cannot be completed safely by adding URL exceptions or timeout prefixes.

## Executive outcome

Implement a target-first federation protocol within the current Nuxt/Nest/Prisma/SQLite/Node/Socket.IO/Nginx/PM2 stack.

The master remains the control plane:

- login, setup, refresh, logout, profile, password, TOTP, and master sessions;
- server registry, enrollment, health, capabilities, fleet update, server audit, palette ownership;
- public VPN subscription and webhook ingress;
- site-to-site migration orchestration;
- master-origin Nuxt Basic Auth.

A selected target remains the data plane:

- sites, domains, DNS, Nginx, PHP, services, firewall, cron, processes, monitoring, storage, databases, backups, VPN services, target users, target settings, AI, operations, and target audit;
- direct target Adminer/Manticore, MODX handoff, and large transfer delivery.

Every remotely callable action is governed by one RemoteContext, one shared action catalogue, one per-target Ed25519 trust relationship, one stable target-side operator identity, and one precise failure contract. HTTP and WS apply the same permissions. Long work has durable status. Public surfaces have purpose-specific delivery contracts. Mixed-version activation is target-first and capability-gated.

## Constraints

### Production and source safety

- /opt/meowbox is both a production VPS and source workspace.
- /opt/meowbox/.dev-mode must remain present and untouched.
- Do not run make update, release-mode conversion, destructive fixture work, live migrations, or real-site tests on this VPS.
- Preserve every unrelated System Overview modification and untracked file.
- Before implementation, reconcile ownership of overlapping files in a dedicated branch/worktree; never reset, auto-stash, clean, or overwrite the dirty tree.
- Before an authorized rollout, use the established snapshot/release transaction on an appropriate release target.
- Prisma schema changes use reviewed migrations and prisma migrate deploy; never db push.
- Env/template/filesystem/OS changes use new idempotent system migrations created with tools/new-migration.sh.

### Architecture boundaries

- Preserve the current stack; no broker or extra daemon is required by default.
- No recursive remote-child fleet management.
- Do not forward the master JWT or browser cookies to a target.
- Do not expose a generic public proxy.
- Do not infer selected-target origins from window.location.
- Do not use static path-prefix timeout policy as final architecture.
- Do not route multi-gigabyte transfers through the master.
- Do not weaken SSRF or TLS validation to support private targets.
- Do not roll back to v0.7.35 after federated JIT identities or other new-only state is active.

### Scope

In scope:

- all 34 Vue pages, shared components/composables, 48 API controllers, and 66 agent TypeScript modules;
- HTTP JSON/text/raw, selected uploads/downloads, public delivery, Socket.IO, Nginx/PHP-FPM Adminer, provisioning, Panel Access, migrations, release gates, observability, and runbooks;
- ADMIN and MANAGER parity, plus characterization of any current VIEWER behavior;
- current, legacy, newer, offline, auth-failed, IP-blocked, and partial-capability targets.

Non-goals:

- replacing Nuxt/Nest/Prisma/SQLite/Node/Socket.IO/Nginx/PM2;
- recursive federation;
- full private/VPN topology activation in protocol 1;
- making the intentional health pings 410 a remote-only defect;
- turning already-asynchronous actions into duplicate jobs;
- altering palette or site-migration ownership.

## Terminology

- master: public panel where the operator authenticates and selects a server.
- target or remote: additional Meowbox installation selected as a data plane.
- control plane: master-owned auth, registry, fleet, public ingress, and orchestration.
- data plane: resources and actions owned by the selected target.
- RemoteContext: canonical selected-server identity, endpoint, protocol, capability, trust, and status contract.
- federated operator: stable target User representing one master issuer/subject.
- service actor: non-human, one-purpose federation actor for webhook/VPN/internal delivery.
- generated stream: non-seekable direct stream with idle-timeout semantics.
- staged artifact: fixed file/object created by a durable operation, with known length/checksum and Range support.
- activation gate: evidence required before enabling a capability; not an unresolved design choice.

## Confirmed fault location and observation

Root cause is confirmed as a boundary mismatch across frontend selection, master relay, target identity/guards, public origins, runtime templates, and operation/WS substrates. It is not one unknown root.

| Layer | Verified current reference and observation | Failures |
|---|---|---|
| Frontend HTTP | web/composables/useApi.ts:getProxyPrefix prefixes normal, public, text, upload, and download paths; public helpers only disable JWT | CF2, CF3, CF7–CF10, CF18 |
| Selection | web/stores/server.ts persists meowbox-server and injects virtual main; web/layouts/default.vue reloads the same route | CF2, CF14, CF20 |
| Auth | web/stores/auth.ts proxies login/me/logout while refresh is master-local; login.vue and setup.vue have no recovery selector | CF2–CF4 |
| HTTP relay | api/src/proxy/proxy.controller.ts has class ADMIN and wildcard proxy; proxy.service.ts adds static X-Proxy-Token, uses one URL and 30/600-second total timeout | CF4, CF5, CF10, CF16–CF19, CF21 |
| Target identity | api/src/common/guards/proxy-auth.guard.ts selects oldest ADMIN; AiSession.userId and broad ownership require User FKs | CF4–CF6 |
| Guard/audit | IpAllowlistGuard runs before ProxyAuthGuard; audit.interceptor.ts expects a proxy marker not produced by HTTP auth | CF4, CF11 |
| WS | web/composables/useSocket.ts equates browser-master connect with readiness; agent.gateway.ts promotes proxy users, uses onAny, and disables upstream reconnect | CF5, CF6, CF15 |
| Provisioning | api/src/proxy/provision.service.ts uses master API_PORT; install.sh defaults loopback API 11860 and public panel 11862; registry commit precedes valid manifest/trust proof | CF1, CF21 |
| Adminer | database/service ticket producers return /adminer/sso.php; four UI callers open it on master; Adminer is target Nginx/PHP-FPM outside /api | CF7 |
| VPN | target public /api/vpn/sub/:token is local; vpn.vue constructs master window.location.origin; VpnUser is target-local | CF8 |
| Export | backup export returns relative /backup-exports/:id/download; initial/repeat web flows resolve to master; download may build a Blob | CF9, CF18 |
| Webhook | target /api/deploy/webhook/:domain is public/HMAC; generic relay is ADMIN-only; main.ts lacks complete direct raw-body capture | CF10 and BN2 |
| Operations | OperationsService has idempotency/locks/progress but startup marks active work failed; agent relay/job ownership is in-memory/incomplete | CF16, CF17 |
| Panel Access | panel-access service and agent template change target access, but no candidate/active/previous registry transaction exists | CF13, CF21 |
| Nginx | install.sh and panel-access.manager.ts duplicate panel templates with 30-second API inactivity | CF16 and BN3 |
| Fleet/capabilities | health uses /admin/update/version; main is a fake remote row; tags can come from selected remote | CF19, CF20 |
| Baseline | /health/:siteId/pings intentionally returns 410; site migration is deliberately direct source-to-target | BN1, SP7 |

Detailed CF17 duration values are operator-audited, not reproduced on this VPS. Phase 0 must bind each value to the actual current route/handler in disposable fixtures.

## Chosen architecture

~~~text
Browser
  ├── master auth/control API
  ├── selected data actions ──> master federation dispatcher
  └── typed public delivery ──> target, master gateway, or provider
                                  |
Master control plane              | pinned TLS + EdDSA assertion
  ├── registry / RemoteContext    v
  ├── capability/action policy   Target Nest data plane
  ├── delegation / audit         ├── federated principal
  ├── WS bridge                  ├── action guard / audit
  ├── VPN/webhook gateway        ├── operations / transfer grants
  └── RemoteOperationLink        └── agent / Nginx / PHP-FPM
~~~

### RemoteContext

Add canonical shared schemas in proposed shared/src/federation.ts, shared/src/federation-actions.ts, shared/src/public-delivery.ts, shared/src/operation-contract.ts, and shared/src/ws.ts.

RemoteContext contains:

- master registry ID and immutable target installation ID;
- display name and registry generation;
- separately normalized API origin/path, WS origin/socket path, browser-public origin, direct-transfer origin, SSH host/port;
- product version as informational data;
- federation protocol, manifest schema/revision, accepted master range;
- action capability map with schema, role/permissions, media, execution mode, idempotency, cancellation, deadlines, and legacy safety;
- independent transport, trust, capability, and browser states;
- precise reason code and timestamps/freshness;
- topology mode and per-server HTTP/WS/public/legacy kill switches.

Do not collapse partial capability, offline, auth failure, version incompatibility, and browser reachability into one boolean. Browser-facing DTOs omit private control origins and key data.

### Manifest and health

Proposed target routes:

- GET /api/federation/v1/health
- GET /api/federation/v1/manifest
- enrollment/rotation/revocation routes under /api/federation/v1

Health is lightweight, rate-limited, independent of GitHub/update APIs and local ADMIN existence, and returns no secret/user/endpoint detail. Manifest requires enrolled trust or a pending enrollment proof and advertises installation identity, endpoints, protocol range, action capabilities, and manifest revision.

A manifest is a signed claim. The master validates and pins each endpoint before use.

### Action catalogue

Every remote HTTP route and WS event has a stable action ID and descriptor:

- owner: master, target, public, or direct;
- method and concrete route template/event;
- request/response schema and media;
- minimum role and explicit permissions;
- INTERACTIVE, OPERATION, GENERATED_STREAM, STAGED_ARTIFACT, PUBLIC_ENDPOINT, or APP_HANDOFF;
- idempotency/replay/cancellation/reconciliation policy;
- connect/header/idle/operation budgets;
- safe legacy status.

Unknown actions, methods, routes, schema versions, and events fail closed. A generated coverage test fails when a controller route or relayed event is unclassified.

### Delegation and exact HTTP transport

Use one Ed25519 keypair per master-target relationship. Master private keys are encrypted under the master-key substrate; the target stores only public keys by issuer and kid. Target manifest signing uses a separate target key.

For an inbound target request of the form:

~~~text
/api/proxy/<canonical-server-uuid>/<suffix>[?<raw-query>]
~~~

the only outbound target is:

~~~text
/api/<suffix>[?<raw-query>]
~~~

The implementation:

- slices suffix/query from original request-target bytes;
- signs the exact concrete target path, including resource IDs and raw query;
- preserves query order, duplicates, empty values, plus characters, and escape form;
- rejects double slash, backslash, control characters, bad escapes, encoded separators, decoded dot segments, fragments, bare trailing question mark, credentials, unescaped non-ASCII, or oversized path/query;
- requires registered origin to be exactly https://host[:port], no credentials/path/query/fragment;
- rejects any URL serialization change;
- binds the action descriptor separately to the validated decoded route template.

Version-1 EdDSA canonical fields include:

~~~text
MEOWBOX-EDDSA-V1
key-id
timestamp / expiry
nonce / request ID
target installation ID
action ID
actor kind / issuer / subject / role / permissions / principal version
operation and idempotency IDs
method
exact target path plus raw query
canonical allowlisted headers
body SHA-256
~~~

Strip browser Authorization, Cookie, Host, Forwarded/X-Forwarded, all inbound X-Meowbox headers, and hop-by-hop headers. Allow only catalogued headers; initially accept, accept-language, content-type, idempotency-key, conditional headers, and range. Reject duplicate/control-bearing raw headers.

Capture exact bounded bytes before generic parsing. Generic signed control requests accept empty or JSON UTF-8 bodies up to 1 MiB and no compression. Multipart, binary, and large uploads use transfer sessions. Mutations require an 8–128-character printable-ASCII idempotency key.

Target verification occurs before IP bypass, JIT identity, controller, or audit. It checks signature, key state, audience, action, concrete target, method, headers, body, role ceiling, time, and replay. Persist and atomically consume replay hash through expiry plus skew; overload fails closed. Signed requests never retry with X-Proxy-Token.

Generic relay defaults:

- reject target Set-Cookie;
- reject redirects unless the action explicitly allows a same-origin, revalidated redirect;
- preserve target application status/media/body;
- preserve safe Content-Length/Content-Disposition where transport permits;
- propagate backpressure and abort;
- classify DNS, TLS, connect, header, idle, and application failures separately.

### Delegated identity and authorization

Add User.identityKind = LOCAL | FEDERATED and a one-to-one FederatedPrincipal.

Federated operators:

- are keyed by unique issuer/subject;
- JIT-upsert only after verified delegation;
- use collision-safe reserved username/email and a random unretained password hash;
- store the least existing role but never authorize from it;
- derive permissions from assertion ∩ target issuer policy ∩ action descriptor;
- never count toward setup;
- cannot use local login, refresh, profile, password, TOTP, sessions, recovery, or ordinary /users administration;
- are hidden/immutable in target local-user CRUD;
- tombstone rather than hard-delete;
- own target AI sessions, operations, sites, exports, and audit through real User FKs.

ServicePrincipal is separate and can invoke only service action namespaces. It never becomes a User or owns AI/personal data.

HTTP and WS consume the same effective action policy. ADMIN is not omnipotent outside its descriptor set; MANAGER receives the same allow/deny result over both transports. Unknown/VIEWER behavior is characterized and deny-by-default until explicitly catalogued.

### Master authentication boundary

Introduce explicit useMasterApi and useRemoteApi/requestScope helpers rather than scattered noProxy booleans.

Always master-owned:

- /auth/login, /auth/refresh, /auth/logout, /auth/me;
- /auth/totp/*, /auth/sessions/*, password/profile/security;
- /setup/status, /setup/init;
- master Basic Auth;
- /servers* and fleet/audit/provisioning;
- master palette and site-migration orchestration.

Selected target /users remains target-local administration and is distinct from current operator profile.

Logout:

1. attempt master logout/revocation;
2. in finally, clear browser credentials, reset selection to main, cancel target HTTP/WS state;
3. show “revocation uncertain” if master could not confirm logout.

Login/setup ignore any persisted target. This closes recovery even when a remote is offline or auth-failed.

### Registry, compatibility, and topology

Replace authoritative servers.json with master-only Prisma registry after staged import.

Preserve current server IDs. Store:

- PanelIdentity and local installation role;
- RemoteServer;
- active/candidate/previous RemoteEndpoint generations;
- capability/manifest snapshots;
- issuer/key/enrollment state;
- topology and pin data;
- exact status/reason/freshness;
- feature kill switches and legacy mode;
- cutover/projection journal.

Before cutover, JSON remains authoritative. During the rollback window, DB is authoritative and writes a mode-0600 journaled legacy projection. Projection failure freezes registry mutation. Registry import/cutover runs only on the control-plane installation; targets do not recursively import registries.

Pinned dialer is a hard predecessor of all delegation:

- validate every A/AAAA answer at connection time;
- reject loopback/private/CGNAT/link-local/multicast/unspecified/metadata for public v1;
- select and dial a validated address without a second resolver lookup;
- retain hostname for SNI and hostname verification;
- require normal CA plus enrolled SPKI/private-CA pin;
- require IP SAN plus pin for literal-IP origins;
- reject redirects for delegation;
- use identical policy for HTTP and Socket.IO.

Full v1 activation is public-origin only. TRUSTED_PRIVATE remains disabled until a separate private-network fixture and policy are approved.

### WebSocket channel

Browser-master authentication remains master JWT. Target channel setup uses a short-lived signed assertion bound to:

- target, operator/service, role/permissions;
- explicit allowed action IDs;
- channel ID, nonce, connection epoch, expiry.

Every event carries action ID, sequence, ack/correlation ID, and a schema-validated payload. The target checks the action is in the signed set and current policy; catalogue-marked high-risk events can require a fresh action assertion.

Remove arbitrary onAny forwarding. Before target READY:

- queue only bounded idempotent subscription/watch events;
- NACK terminal input, AI mutation, and side effects with REMOTE_NOT_READY.

Keep browser socket connected while upstream reconnects. Use bounded jitter, new assertion/epoch, and replay only explicit subscriptions/listeners/rooms. Reject stale epoch/sequence. Key/principal revocation closes channels. Provide ack, cancellation ownership, backpressure, event/payload/rate limits, and stale cleanup. Poll operations/status/metrics/persisted logs only where meaningful; terminal/live AI are unavailable when upstream cannot recover.

### Operations and agent jobs

Target Operation remains canonical. Master RemoteOperationLink stores target ID/operation ID, master operator, request/correlation, and polling/audit linkage only.

Extend target Operation with action/policy snapshot, attempt, lease, heartbeat, deadline, cancel request/outcome, retryability, recovery policy, and RECOVERING/UNKNOWN_RECOVERY_REQUIRED/NEEDS_ATTENTION states.

Add an in-process OperationsWorkerService using atomic SQLite claims. This is the default because the current deployment has one API process and an in-process scheduler; it is activation-gated, not presumed durable.

Add AgentJob with deterministic ID per operation/step and protocol:

- job.start;
- job.started;
- job.heartbeat;
- job.status;
- job.result;
- job.cancel.

Every agent child launch used by a job—spawn, execFile, shell, Restic, installer, restore, import/export, and long streams—must be owned by a process group/systemd scope, bounded output spool, and action-specific cancel/reconcile contract. SIGTERM gets five seconds before SIGKILL where cancellation is safe.

Retry only explicitly retry-safe actions. Lost non-idempotent work becomes NEEDS_ATTENTION and keeps conflicting locks. Client disconnect does not cancel.

Require a broker/separate worker if measured stop criteria persist: admission over 10 jobs/s, required mutations over two/target, queue/SQLite/lease limits fail, hard agent restart survival is mandatory, any child is unowned, or multiple API replicas are introduced without proven leases.

### Public delivery contracts

Use a discriminated union, never a single ambiguous URL:

- PublicEndpoint: stable VPN/webhook endpoint;
- AppHandoff: one-time Adminer/Manticore/MODX top-level handoff;
- TransferSession: generated stream or staged artifact, including HEAD/Range/upload/lease semantics;
- ExternalProvider: S3/presigned provider URL;
- AuthenticatedProxyResult: ordinary selected-target action.

Each response is absolute and includes purpose, delivery mode, target/resource binding, method, allowed headers, cache/referrer policy, expiry, one-time/reusable semantics, browser reachability requirement, range/resume support, and fallback reason.

#### Adminer/Manticore

Direct target only.

- Target creates AdminerHandoff with a 256-bit secret hash, encrypted credential/resource payload, actor snapshot, 60-second expiry, consumedAt.
- Return a target URL with ID/secret in the fragment.
- Target bootstrap removes fragment from history, uses no-store/no-referrer/restrictive CSP, and POSTs same-origin.
- Nest atomically consumes/revalidates the handoff and sets:
  - __Secure-meowbox_adminer_session;
  - Secure, HttpOnly, SameSite=Lax;
  - host-only, Path=/adminer;
  - fixed Max-Age 900, no sliding renewal.
- AES-256-GCM uses target-bound AAD; plaintext ≤2,048 bytes and serialized cookie ≤3,800 bytes.
- PHP validates only target/version/kind/audience/tag/absolute expiry and never renews.
- Existing sso.php query-ticket authentication returns 410.
- tools/adminer-src is the only editable source; never edit/dereference tools/adminer runtime symlink.
- A system migration synchronizes source/key/pool/Nginx state and fails closed on mismatch.

If the requester’s browser cannot reach the target, disable with TARGET_BROWSER_UNREACHABLE. Do not gateway it through master.

#### VPN

Master route is a stable opaque token endpoint, proposed /api/public/v1/vpn/subscriptions/:token.

Master owns FederatedVpnSubscription and explicit ordered sources; target VpnUser/services own credentials.

- default membership: selected target only;
- aggregation: explicit opt-in;
- deterministic configured source/service order;
- exact credential fingerprint dedupe only;
- encrypted signed fragments with epoch/expiry;
- immediate master token/source invalidation;
- target credential revocation during outage bounded by fragment expiry/invalidation;
- five-minute initial stale maximum, then omit or 503;
- no internal target names/private metadata;
- no-store and scoped public throttling.

#### Deploy webhook

Master route is an opaque WebhookRoute token bound to target/domain/site/provider/signature policy. Caller cannot choose target/domain.

- capture exact raw bytes before JSON parsing;
- validate provider signature/timestamp/replay at master using encrypted route verifier;
- reject before queue if invalid;
- atomically fsync encrypted filesystem spool plus SQLite metadata/idempotency receipt;
- return 202 only after capacity-safe acceptance;
- deliver with SERVICE assertion bound to target action/delivery ID;
- target revalidates original provider bytes where applicable and deduplicates;
- bounded retry, per-origin concurrency, DLQ/redrive authorization, disk reserve, cleanup/key rotation;
- repair existing direct target raw-body path separately for BN2.

#### Transfers

Two modes:

1. GeneratedStream: direct, non-resumable, backpressured, abortable, idle-timeout; no Range/known-length/checksum claim.
2. StagedArtifact: durable operation writes and fsyncs a fixed artifact, records length/SHA-256, then issues a Range-capable lease. First Range does not consume the session; resource/session/expiry controls reuse.

Use target Nginx/internal delivery or equivalent zero-copy path. Browser uses native navigation or streamed file writing, never whole-Blob for large data. Preserve S3 as ExternalProvider. Preserve migration source-to-target transfer.

Master fallback is only for ≤100 MiB under the explicit memory/concurrency/rate budget; no large upload fallback. Larger browser-unreachable transfers require target/VPN reachability or external provider.

#### MODX/domain login

Protocol-1 uses direct target one-time top-level handoff. Remove master-origin document.write. Legacy targets show upgrade/manual access guidance.

### IP, audit, and throttling

Create verified NetworkContext before IP allowlist:

- peerIp: actual master peer;
- browserIp: signed delegated browser address;
- trusted-proxy provenance.

Only a cryptographically verified federation channel bypasses target browser allowlist. Path strings never bypass it. Strip inbound forwarding/federation headers and rebuild at master.

Master OUT and target IN audit share signed request/operation/correlation ID and include issuer, operator/service subject, target principal, action, target, outcome, duration, peer/browser IP, and key ID. Keep secrets, raw bodies, URLs/tokens/cookies/credentials out. Update audit.interceptor.ts so federated target IN is not mistaken for ordinary local activity. Preserve System Overview read-audit suppression.

Rate keys:

- local: operator + action;
- master relay: operator + target + action;
- target delegated: issuer + subject + action;
- operation admission: actor + target + action/scope;
- public: token-hash prefix + source IP + route;
- service channel: issuer + action.

Retain global abuse ceilings and return Retry-After.

## Decision log

The selected and rejected DB1–DB12/Q1–Q8 alternatives are recorded in [debate.md](debate.md). Binding decisions:

- shadow User + FederatedPrincipal; separate service actor;
- per-target Ed25519, no HMAC/static bearer fallback;
- direct Adminer/Manticore, master VPN/webhook, direct/staged transfers;
- master VPN subscription with explicit sources;
- target Operation + in-process worker/AgentJob;
- public-only v1;
- DB-backed master registry with compatibility projection;
- main separate;
- protocol 1 plus legacy-static-v0;
- per-browser reachability;
- replace document.write;
- origin-local Basic Auth semantics.

## Dependency graph

~~~text
P0 characterize and protect
  └─> P1 contracts, pinned trust, manifest, registry, dual stack
        └─> P2 principals, HTTP/WS policy, auth, IP/audit
              └─> P3 provisioning and canonical endpoint readiness
                    └─> P4 worker/agent/artifact/cutover substrate
                          └─> P5 public surfaces, transfers, WS lifecycle
                                └─> P6 all-page UX/fleet/rates
                                      └─> P7 migration/release/canary/deprecation
~~~

Pinned dialing precedes any delegated read or WS. Worker/agent recovery precedes Panel Access cutover, staged transfers, queued webhooks, and long-action conversion. Direct-link UI waits for canonical endpoints and browser probes. Target protocol ships before master activation.

## Implementation tasks

### Phase 0 — characterization, fixtures, and safeguards

#### RPP-000 — worktree and production guard

Dependencies: none.

Deliverables:

- record branch, HEAD, VERSION, git status, .dev-mode, and a hunk-ownership manifest;
- identify every overlap with System Overview, especially proxy.controller.ts, useApi.ts, useSocket.ts, default.vue, install.sh, package/lock/workflow files;
- establish dedicated implementation worktree/branch and fixture-only environment variables;
- add guards that fixture hosts cannot resolve to production addresses.

Exit:

- no unowned overlap;
- current Dashboard proxy/fallback/contract/accessibility tests green;
- no runtime mutation.

#### RPP-010 / SUB-001 — machine-checked route/action matrix

Dependencies: RPP-000.

Files:

- new specs/remote-panel-parity/action-matrix.yaml;
- shared action schema/tests;
- route/event inventory test under api/test and shared tests.

For every 34-page action, 48 controller route, public route, upload/download, and WS event, record:

- exact file/controller/service/agent owner;
- master/target/public/direct ownership;
- role/action ID/schema/media;
- sync/operation/generated-stream/staged-artifact mode;
- idempotency, cancellation, current timeout/agent budget;
- capability and legacy behavior;
- CF/A/SP/IM/BN mapping;
- named test and metric.

Exit: unclassified routes/events fail CI.

#### RPP-020 — disposable fleet fixture

Dependencies: RPP-010.

Add e2e/remote-panel-parity with isolated master/targets:

- current, legacy, newer-compatible, newer-incompatible;
- offline, auth-failed, IP-blocked, partial capability;
- fresh/no-admin, existing-env/custom-port/token mismatch;
- public target, browser-reachable/unreachable profiles;
- private topology as disabled security probe;
- real generated Nginx/PHP-FPM/Adminer;
- restartable API/agent/Socket.IO;
- DNS rebinding/TLS/SPKI fixtures;
- sparse/logical 50 GiB streams;
- webhook provider and S3 fixtures.

No fixture uses real state/sites.

#### RPP-030 — lower-layer probes and CF17 catalogue

Dependencies: RPP-020.

Run isolated probes:

- exact Nginx→Express→Undici→Nginx→Nest request bytes;
- selected-address dialing and HTTP/WS TLS;
- Node AES-GCM→PHP Adminer cookie;
- SQLite operation claims/crash/restart/WAL behavior;
- agent child-process inventory/cancel/reconcile;
- Adminer assets/cookies/replay;
- raw webhook bytes;
- transfer Range/abort/disk/memory;
- Panel Access interruption points.

Produce per-CF17 route/handler classification. Do not misclassify existing async actions or BN1–BN3.

#### RPP-040 — test command and baseline integration

Dependencies: RPP-020.

Add aggregate API/agent federation test commands; extend web test:contracts and migration release tests; wire release CI. Preserve existing scripts. Record baseline p95/lock/memory values before feature activation.

### Phase 1 — contracts, trust, pinned networking, registry, capabilities

#### RPP-100 — shared federation contracts

Dependencies: RPP-010.

Files:

- new shared/src/federation.ts;
- shared/src/federation-actions.ts;
- shared/src/public-delivery.ts;
- shared/src/operation-contract.ts;
- extend shared/src/ws.ts and shared/src/index.ts.

Implement RemoteContext, action descriptors, discriminated public delivery, operation envelopes, WS envelopes, error union, validators, and compatibility intersection.

Tests: T-SIG-001 schema fixtures, manifest/capability errors, unknown action denial.

#### RPP-110 / SUB-010 — Panel identity, enrollment trust, and pinned dialer

Dependencies: RPP-100, RPP-030.

Files:

- new api/src/federation/ endpoint-normalizer, pinned-dispatcher, identity, enrollment, key services;
- refactor api/src/common/validators/safe-url.ts;
- refactor proxy HTTP and agent gateway WS clients;
- remove insecure IP TLS dispatcher.

Add stable installation ID/role, SSH fingerprint-bound bootstrap, target manifest key, per-target master delegation keys, rotation/revocation/recovery.

Tests: T-DIAL-001/002, bootstrap replay, fingerprint mismatch, literal IP SAN, multi-address DNS, redirect refusal.

Failure: target remains unenrolled/disabled; no registry commit.

#### RPP-120 / SUB-011 — DB registry and reversible JSON transition

Dependencies: RPP-100, RPP-110.

Files:

- api/prisma/schema.prisma and reviewed migration;
- new api/src/federation/remote-registry.service.ts, remote-context.service.ts, registry-import.service.ts;
- refactor api/src/proxy/proxy.service.ts as legacy compatibility adapter;
- existing /servers controller remains master-only.

Implement ID-preserving transactional import, encrypted legacy secrets, endpoint generations, manifest/status cache, kill switches, projection journal, freeze-on-projection-failure, export/rollback.

Tests: T-REG-001–003.

#### RPP-130 — target health/manifest and capability negotiation

Dependencies: RPP-100, RPP-110.

Files:

- new api/src/federation/health.controller.ts, manifest.controller.ts, manifest.service.ts, compatibility.service.ts;
- api/src/app.module.ts.

Implement lightweight health, authenticated signed manifest, cache/revision, exact state/reason mapping. Preserve dashboard exact-404 behavior separately.

#### RPP-140 / SUB-020 — EdDSA transport, raw parsing, replay, idempotency

Dependencies: RPP-110, RPP-120, RPP-130.

Files:

- api/src/main.ts;
- new federation delegation issuer/verifier/replay services/guard;
- api/src/proxy/proxy.controller.ts and proxy.service.ts;
- shared contracts.

Implement the exact concrete-target/header/body contract above. Persistent replay and idempotency conflict checks. Default cookie/redirect denial.

Tests: T-SIG-001–005.

#### RPP-150 — target-first dual stack and legacy-static-v0

Dependencies: RPP-130, RPP-140.

Implement flags: disabled, observe, v1-read-only, v1-enabled, legacy-upgrade-only. Ship target support before master activation. Exact legacy allowlist and telemetry; no identity-sensitive fallback.

### Phase 2 — identity, auth, RBAC, audit, IP, AI

#### RPP-200 / SUB-030 — shadow operators and service principals

Dependencies: RPP-140.

Files:

- schema migration;
- new federated-principal.service.ts and service-principal.service.ts;
- api/src/auth/auth.service.ts, setup.controller.ts;
- api/src/users/users.controller.ts/service.ts;
- profile/TOTP/session services;
- ownership tests.

Implement JIT, local filters, tombstones, role intersection, service isolation, last-local-admin/self-delete protections, rollback floor.

Tests: T-AUTH-001–005.

#### RPP-210 — master auth and API scope split

Dependencies: RPP-100.

Files:

- web/composables/useApi.ts;
- new useMasterApi.ts/useRemoteApi.ts or explicit requestScope;
- web/stores/auth.ts, login.vue, setup.vue, settings.vue;
- web/plugins/stores-init.client.ts and auth middleware.

Implement unconditional master lifecycle and deterministic logout/reset-main behavior.

#### RPP-220 — delegated dispatcher and shared RBAC

Dependencies: RPP-140, RPP-200.

Files:

- split proxy control routes from data dispatcher;
- proxy-auth.guard.ts becomes legacy-only;
- roles/action guards;
- app.module.ts.

Remove class-wide ADMIN from data plane; keep /servers control plane ADMIN. Enforce action policy at master and target. Generate ADMIN/MANAGER parity tests.

#### RPP-230 — IP and correlated audit

Dependencies: RPP-220.

Files:

- api/src/admin-security/ip-allowlist.guard.ts;
- api/src/common/http/client-ip.ts and new network-context.ts;
- api/src/common/interceptors/audit.interceptor.ts;
- api/src/proxy/proxy-audit.service.ts;
- schema audit fields.

Implement cryptographic channel context before allowlist, peer/browser IP separation, OUT/IN correlation, header stripping, and secret redaction.

Tests: T-IP-001 and T-AUD-001.

#### RPP-240 — AI and ownership parity

Dependencies: RPP-200, RPP-220.

Files:

- api/src/ai/ai.controller.ts/service.ts and WS handlers;
- web/pages/ai.vue.

Ensure REST and WS resolve the same shadow User. Test list/create/history/resume/title/rename/delete/multi-turn and two-operator isolation.

#### RPP-250 — rate-limit identity

Dependencies: RPP-220, RPP-230.

Refactor throttler tracker keys and add public/server/global ceilings. Multi-operator/NAT/master fan-out tests.

### Phase 3 — provisioning and endpoint readiness

#### RPP-300 — durable enrollment/provisioning

Dependencies: RPP-110, RPP-120, RPP-130.

Files:

- refactor api/src/proxy/provision.service.ts and DTO/controller;
- install.sh;
- new enrollment operation/state services.

Proposed master routes:

- POST /api/servers/enrollments;
- GET /api/servers/enrollments/:id;
- POST resume/cancel.

Workflow: prepare → SSH verify → install/preserve env → target identity/trust → manifest → normalize/pin/probe → authenticated no-admin health → atomic registry commit → bootstrap destroy. Failure keeps resumable sanitized attempt and no active server row.

Tests: T-PROV-001–003.

#### RPP-310 — canonical context/browser probe/SSH

Dependencies: RPP-120, RPP-300.

Files:

- master GET /api/servers/:id/context;
- web/stores/server.ts and new useRemoteContext.ts;
- api/src/sites/sites.service.ts:getSshCredentials;
- web/pages/sites/[id].vue.

Expose browser-safe context and actual target SSH host/port. Add per-session/per-surface browser probes, not global reachability.

#### RPP-320 — public-only topology gate

Dependencies: RPP-110, RPP-310.

Enforce public v1. Store but disable TRUSTED_PRIVATE. Document why topology rejection is POLICY_BLOCKED, not offline.

### Phase 4 — durable worker, slow actions, artifacts, Panel Access

#### RPP-400 / SUB-040 — Operation v2 and worker leases

Dependencies: RPP-200, RPP-220.

Files:

- api/src/operations/operations.service.ts/controller.ts/module.ts;
- schema Operation fields and RemoteOperationLink;
- new operations-worker.service.ts.

Implement atomic claims, leases, heartbeats, cancellation/reconcile routes, scoped/paginated reads, restart recovery, NEEDS_ATTENTION, queue limits, policy snapshots.

Tests: T-OPS-001–003.

#### RPP-410 / SUB-050 — AgentJob and process ownership

Dependencies: RPP-400.

Files:

- schema AgentJob;
- api/src/gateway/agent-relay.service.ts;
- agent/src/agent.service.ts, process-registry.ts, command-executor.ts;
- every manager identified by RPP-030.

Implement job protocol, boot IDs, dedupe, process group ownership, bounded output, cancel, reconciliation, no unsafe retry.

Tests: T-OPS-004–006.

#### RPP-420 — CF17 action conversion

Dependencies: RPP-400, RPP-410, RPP-030.

For each catalogued class, implement the selected contract:

- site/domain deletion;
- DB delete/import/export preparation;
- SSL;
- MODX update/doctor/normalize;
- Redis/Manticore/MinIO/service lifecycle;
- quick command;
- VPN runtime;
- country block;
- Panel Access certificate;
- storage tests/scans;
- Restic list/tree/diff;
- hostpanel cleanup;
- OS update check;
- PHP install/uninstall;
- global services/system.

Keep existing site create/duplicate/domain provisioning/backup/hostpanel async work and link existing operations. Remove LONG_RUNNING_PATHS only after matrix coverage is complete.

#### RPP-430 — staged artifact producer

Dependencies: RPP-400, RPP-410.

Files:

- backup-exports controller/service;
- DB/file/backup transfer owners from action matrix;
- new transfer module;
- schema artifact/session;
- target state spool and Nginx internal location.

Implement generated versus staged modes, disk reservation, atomic READY, checksum/length, cleanup/reconcile/cancel.

#### RPP-440 / SUB-075 — distributed Panel Access cutover

Dependencies: RPP-300, RPP-400, RPP-410.

Files:

- api/src/panel-access/*;
- agent/src/panel-access/panel-access.manager.ts;
- registry/context services;
- install.sh templates.

Candidate operation stages Nginx/firewall/certificate/listener while old endpoint stays active. Validate nginx -t, master pinned API/WS/manifest and browser probe, atomically activate registry, finalize target. Persist cutover ID/deadline; reconcile lost ack; auto-rollback; retain SSH recovery.

Tests: T-PA-001–003.

### Phase 5 — public surfaces, transfers, and WS lifecycle

#### RPP-500 — discriminated public grant substrate

Dependencies: RPP-140, RPP-200, RPP-400.

Files: new api/src/public-delivery and shared schemas. Store only token/secret hashes and encrypted payloads. Add redaction/no-store/no-referrer helpers.

#### RPP-510 / SUB-060–061 — Adminer/Manticore handoff

Dependencies: RPP-500, RPP-310.

Files:

- new api/src/adminer module/controller/service;
- databases.service.ts and services.service.ts;
- tools/adminer-src/index.php, sso.php, lib/sso.php, plugin;
- both panel templates and system migration;
- four UI callers;
- release workflow.

Implement exact direct handoff/cookie contract. Test T-ADM-001–005. Disable on browser-unreachable/key/runtime mismatch.

#### RPP-520 / SUB-080 — federated VPN subscription

Dependencies: RPP-500, RPP-200.

Files:

- schema subscription/source/cache;
- master public controller/service;
- target api/src/vpn controller/service scoped fragment action;
- web/pages/vpn.vue.

Implement stable URL/QR, explicit source management, encrypted fragments, deterministic output, stale/partial/revocation semantics, size/rate limits.

Tests: T-VPN-001–003.

#### RPP-530 / SUB-090 — webhook ingress and delivery

Dependencies: RPP-500, RPP-400.

Files:

- api/src/main.ts raw parser;
- new webhook route/delivery services/controller;
- deploy controller/service byte-oriented handler;
- schema metadata and encrypted filesystem spool;
- system migration/logrotate.

Implement route binding, provider verification, durable accept, service assertion, target revalidation/dedupe, retries/DLQ.

Tests: T-WEB-001–003.

#### RPP-540 / SUB-070 — transfer sessions and browser delivery

Dependencies: RPP-430, RPP-500, RPP-310.

Files:

- transfer controllers/services;
- backup export/DB/file callers;
- web useApi download/upload and pages/components.

Implement HEAD/GET single Range/If-Range, direct session, native/streamed web use, small master fallback, S3 preservation, initial/repeat export repair.

Tests: T-XFER-001–004 and T-BR-001/002.

#### RPP-550 — MODX and migration delivery

Dependencies: RPP-500, RPP-540.

Replace document.write with target handoff. Preserve constrained migration download and master orchestration; migrate its response to typed direct transfer vocabulary without turning it into generic proxy.

#### RPP-560 / SUB-065 — typed WS lifecycle

Dependencies: RPP-140, RPP-220, RPP-400.

Files:

- api/src/gateway/agent.gateway.ts and agent-relay.service.ts;
- new federated-socket-bridge/session registry;
- shared WS schemas;
- web/composables/useSocket.ts.

Implement channel/action/sequence/epoch contract, readiness states, reconnect, resubscribe, acks/cancel/backpressure, key closure, polling fallbacks.

Tests: T-WS-001–006.

### Phase 6 — frontend parity, navigation, fleet, labels

#### RPP-600 — context epoch and transport facades

Dependencies: RPP-310, RPP-540, RPP-560.

Each request captures server ID/registry generation/context epoch. Abort old requests; discard stale responses/events; never send mutation after context change. Preserve System Overview AbortSignal/status/metrics behavior.

#### RPP-610 — safe navigation

Dependencies: RPP-600.

On target change:

- /sites/:id → /sites;
- /dns/zones/:id → /dns;
- preserve only compatible tab/filter state;
- clear caches, transfer state, operation watches, and WS subscriptions before activation.

Test no old UUID read/mutation.

#### RPP-620 — settings, SSH, Panel Access, Basic Auth

Dependencies: RPP-310, RPP-440, RPP-600.

Split master account/Basic Auth from target settings. Display canonical target protocol/domain/port/SSH. Label direct target policies and scoped public bypasses exactly.

#### RPP-630 — main/fleet/update compatibility

Dependencies: RPP-120, RPP-150.

Files:

- web/stores/server.ts;
- web/pages/servers.vue;
- server update controller/service and release workflow metadata.

Separate MainServerNode and RemoteServerSummary. No main checkbox/edit/delete. Tags are master-owned. Verify protocol compatibility before and after target update. Label nested fleet out of scope.

#### RPP-640 — all-page capability pass

Dependencies: RPP-600–630.

Apply action/status gates to all 34 pages and shared components. Unsupported controls hide/disable with exact reason. Preserve Dashboard overview contract and exact-404 fallback.

#### RPP-650 — operator diagnostics and fair limits

Dependencies: RPP-230, RPP-250, RPP-560.

Expose bounded context reason/audit/operation/WS diagnostics. Show peer and browser IP separately where relevant.

### Phase 7 — migration, tests, rollout, docs, deprecation

#### RPP-700 / SUB-100 — migration and release rehearsal

Dependencies: all schema/system tasks.

Run cloned SQLite expand/rollback, registry import/projection, key backup/restore, Adminer runtime sync, Nginx regeneration, spool layout, old-compatible binary, and cutover recovery. Wire aggregate API/agent/web/migration/package tests into release CI.

#### RPP-710 — full traceability/security/performance gate

Dependencies: all functional tasks.

T-TRACE-001 must map every requirement to task/action/test/metric/gate. Run the matrices below and security review. No activation on partial evidence.

#### RPP-720 — target-first rollout

Dependencies: RPP-700, RPP-710.

1. ship target dual-stack protocol disabled;
2. enroll isolated target;
3. activate observe/read-only;
4. activate one canary at ≤5% for 24 hours;
5. activate 25% for 24 hours;
6. expand only after thresholds remain green;
7. keep per-server HTTP/WS/public/legacy kill switches;
8. retain compatibility projection/key grace through removal window.

#### RPP-730 — runbooks and operator docs

Dependencies: RPP-720.

Add:

- docs/runbook/remote-enrollment.md;
- federation-key-rotation.md;
- remote-panel-rollout.md;
- remote-panel-incident.md;
- panel-access-cutover-recovery.md;
- webhook-dlq.md;
- vpn-subscription-recovery.md;
- transfer-recovery.md;
- docs/remote-panel-topology.md;
- remote-panel-compatibility.md.

Cover public DNS/TLS/firewall, browser reachability, private deferral, broken endpoint, offline/auth-failed, compromise, rollback floor, and dev-mode safety.

#### RPP-740 — legacy retirement and release

Dependencies: telemetry and RPP-730.

Remove legacy only after DB9 criteria. Before authorized release: snapshot, clean release input, VERSION bump, commit/tag, workflow tarball, update only authorized release targets. Never make update on current dev-mode VPS.

## DB/config/system migration matrix

| ID | Change | Mechanism | Compatibility and rollback |
|---|---|---|---|
| DB-01 | PanelIdentity, RemoteServer/Endpoint/Manifest, issuer/key/enrollment/replay, projection/cutover journal | additive Prisma migration | JSON authoritative until commit; preserve IDs; old-compatible release ignores new tables |
| DB-02 | User.identityKind, FederatedPrincipal, ServicePrincipal | additive Prisma migration and local-user backfill | all existing users LOCAL; no v0.7.35 rollback after JIT |
| DB-03 | ProxyAuditLog/AuditLog correlation, network/issuer/action fields | additive Prisma migration/indexes | old readers ignore; redaction invariant |
| DB-04 | Operation recovery/lease/cancel fields, AgentJob, RemoteOperationLink | additive Prisma migration/indexes | activate only after worker tests; preserve old result/status representation |
| DB-05 | AdminerHandoff and bounded session/revocation metadata | additive Prisma migration | old sso disabled only after Node/PHP gate |
| DB-06 | FederatedVpnSubscription/Source/Cache metadata, WebhookRoute/Delivery metadata, grants/artifacts/sessions | additive Prisma migration | payloads/spools encrypted outside DB where large; routes feature-flagged |
| SYS-01 | installation role/ID defaults, key/spool directories and non-secret env budgets | new idempotent system migration | add missing values only; mode/owner checks; preserve secrets |
| SYS-02 | Adminer source→state sync, PHP-FPM key/pool, legacy sso disable | new idempotent system migration | stage/validate; restore prior source/runtime on failure |
| SYS-03 | panel federation/WS/transfer/public routes, timeouts, cutover template | new idempotent system migration, regenerate existing panels | nginx -t, old config/listener backup, rollback |
| SYS-04 | transfer artifact and webhook encrypted spool directories/logrotate/cleanup | new idempotent system migration | 0700, disk reserve, retain referenced data |
| APP-01 | servers.json import/projection/cutover | master-only application transaction | digest/checkpoint, mutation freeze, export, expand-compatible rollback floor |

Review SQLite table rebuilds/FKs/index creation and measure at representative volume. Never edit an applied migration. No new daemon/systemd unit is required unless worker stop criteria later select that alternative.

## Security threat model

| Threat/abuse | Control and required proof |
|---|---|
| confused deputy/wrong target | target audience, concrete path/query/body/action binding; T-SIG |
| static bearer theft | no ambient bearer in v1; legacy upgrade-only kill switch |
| target forges master | Ed25519 target holds public key only |
| key/bootstrap theft | per-target blast radius, encrypted key, one-use bootstrap, rotation/revocation |
| replay/clock | persistent atomic replay, short TTL/skew, overload fail-closed |
| stale role/principal | short assertion, principal version/deactivation, policy intersection |
| MANAGER escalation | shared HTTP/WS catalogue and role parity tests |
| WS injection/replay | signed channel action set, schema, sequence/epoch, ack/rate/backpressure |
| shadow local login/deletion | identityKind filters, random hash, hidden immutable rows, tombstone |
| audit spoof/XFF forgery | strip/rebuild headers; signed IDs/IP; correlated OUT/IN |
| SSRF/DNS rebinding | public-only, all-answer validation, pinned selected-address dial, no redirects |
| invalid HTTPS-by-IP | IP SAN plus SPKI pin; rejectUnauthorized true |
| public token enumeration | 256-bit opaque token, hash at rest, generic response, rate/size limits |
| Adminer replay/cookie leak | atomic handoff, fragment bootstrap, target-only cookie, no-referrer/no-store |
| webhook forgery/duplicate | master provider verification, route binding, raw bytes, idempotent target receipt |
| VPN stale credential | encrypted signed fragment expiry/invalidation, bounded stale, immediate master-token revoke |
| transfer amplification/disk | direct sessions, size/rate/concurrency/single-range/disk reserve/checksum/cancel |
| operation duplicate/orphan | idempotency, resource locks, leases, process ownership, NEEDS_ATTENTION |
| secret logging/metrics | centralized redaction; no assertion/token/cookie/raw body/credential/query |
| mixed-version downgrade | signed manifest, explicit legacy allowlist, no auth-failure fallback |
| registry rollback/key mismatch | projection journal, master-key snapshot, expand-compatible floor |

Security review is a release gate. Any bypass, wrong-target action, secret leak, or unsafe automatic retry is an immediate canary stop.

## Initial performance and resource budgets

Proposed, configurable activation defaults; load tests may revise through review.

| Area | Initial limit |
|---|---|
| assertion | TTL 60 s; skew ±30 s; replay retention ≥120 s; 10,000 active replay rows/target |
| manifest | fresh 60 s; stale display 5 min; stale never enables privileged action |
| signed control body | 1 MiB, identity encoding only |
| HTTP | connect/TLS 5 s each; headers 15 s; ordinary idle 30 s; generated-stream idle 60 s; no healthy-stream total timeout |
| operation queue | 128 nonterminal/target; 32/actor; reject excess 429 |
| operation execution | 2 claimed/target; at most 1 heavy mutation; exclusive resource lock |
| lease | 30 s; heartbeat 10 s; reclaim expiry +10 s; claim batch 4 |
| retries | 3 only retry-safe; otherwise 1; queue-age ceiling 15 min |
| WS | 32 safe pre-ready events or 256 KiB; 20 subscriptions; ack 10 s; reconnect 250 ms–30 s jitter; outbound 256 messages/1 MiB; stale cleanup 60 s |
| direct transfer | 50 GiB/session; 8 MiB chunks; first-byte TTL 15 min; idle 60 s; staged lease 4 h; 20 MiB/s/session, 40 MiB/s/target |
| transfer admission | 5 new/min/actor; 2 active/actor; 4 active/target; 2 streams/target |
| master fallback | ≤100 MiB; 16 MiB memory/stream; 2/operator-target; 4 global; 10 MiB/s/session, 20 MiB/s global |
| VPN | 8 sources; 256 KiB/source; 1 MiB aggregate; 256 entries; connect 10 s; total 30 s; stale ≤5 min |
| webhook | 64 KiB; queue 1,000; 4 global workers, 1/origin; attempt 10 s; retries 5 s/30 s/2 m/10 m/1 h; DLQ 7 d |
| Adminer | handoff 60 s; cookie 900 s; plaintext 2,048 bytes; serialized cookie 3,800 bytes |
| staging disk | reserve max(10 GiB, 10% filesystem) |
| operation retention | 30 d or reviewed row cap; result ≤1 MiB, larger external/paginated |
| metrics | bounded action/protocol/state/outcome/timeout and registry-controlled target bucket only |

Worker redesign stop criteria are stated in the operation section. These are not observed production capacities.

## Test plan

### Stable suite IDs

- T-SIG-001–005: exact target/query/header/raw bytes, EdDSA, replay, idempotency.
- T-DIAL-001–002: rebinding/address pinning/redirect/TLS/SPKI and HTTP/WS parity.
- T-AUTH-001–005: master/local boundaries, JIT, ownership, local login denial, tombstone, service isolation.
- T-IP-001 and T-AUD-001: guard order, peer/browser IP, OUT/IN correlation.
- T-OPS-001–006: competing claims, crash/restart, agent ID/dedupe, child inventory, cancellation, unsafe-loss handling.
- T-WS-001–006: readiness, action policy, sequence/epoch, reconnect/replay, revocation, ack/cancel/backpressure.
- T-ADM-001–005: one consume, Node/PHP AES-GCM, real Nginx/PHP-FPM, failure cases, legacy rejection.
- T-XFER-001–004: stream/artifact, 100 MiB boundary, multi-GB/50 GiB, Range/checksum/abort/memory/rate.
- T-VPN-001–003: source/order/size, pinning, stale/revocation/parser bounds.
- T-WEB-001–003: raw bytes, route binding, retry/DLQ/service dedupe.
- T-PROV-001–003: fresh/existing/custom/resume/manifest/commit.
- T-REG-001–003: import/projection/rollback floor.
- T-PA-001–003: cutover/lost ack/rollback/SSH.
- T-BR-001–002: per-surface reachability and direct-upload CORS/session.
- T-LEG-001–002: legacy allowlist and update skew.
- T-REL-001–003: aggregate suites, packaging, Adminer/key install/upgrade.
- T-TRACE-001: bidirectional requirement mapping.
- T-CAN-001: staged rollout and automated stops.

### HTTP/API integration

Cover JSON/text/raw/multipart/binary through their declared transports; exact raw webhook bytes; headers, compression, redirects, cookies; idempotency; target continuation after disconnect; replay across restart; audit correlation; target application errors versus transport errors.

### WS integration

Cover pre-ready race, upstream restart, browser persistence, listener/room replay, forged event, MANAGER policy, epoch/sequence replay, ack/cancel, backpressure, stale cleanup, key revocation, and polling limits.

### Provisioning/system integration

Cover fresh/no-admin, existing env, custom ports, token mismatch, failed/resumed install, target manifest, public/private decision, registry commit/rollback, template equivalence, Adminer sync, Panel Access interruptions, and system migration idempotency.

### Transfer/load integration

Cover small, below/at/above 100 MiB, simulated multi-GB, logical 50 GiB, Range resume, slow continuous, abort, checksum, disk reserve, rate/concurrency, browser/master RSS, and cleanup/reconciliation.

### Page matrix

| Group | Pages |
|---|---|
| auth/control | login.vue, setup.vue, servers.vue |
| dashboard/sites | index.vue, sites/index.vue, sites/create.vue, sites/[id].vue, activity.vue |
| admin/update/migration | admin/migrate-hostpanel/index.vue, admin/updates.vue, updates.vue |
| data/public | databases.vue, vpn.vue, backups.vue, backup-storages.vue, backup-checks.vue, storage.vue |
| DNS | dns/index.vue, dns/providers.vue, dns/zones/[id].vue |
| system | cron.vue, firewall.vue, health.vue, logs.vue, monitoring.vue, nginx.vue, php.vue, processes.vue, services.vue, ssl.vue, terminal.vue |
| identity/config | settings.vue, users.vue, ai.vue |

Run visible and hidden routes plus shared components/composables against main/current/legacy/newer/offline/auth-failed/IP-blocked/partial and ADMIN/MANAGER/characterized VIEWER.

## CF1–CF22 traceability

| Failure | Tasks | Tests / release evidence |
|---|---|---|
| CF1 provisioning | RPP-110/120/300 | T-DIAL, T-PROV, T-REG |
| CF2 stale auth | RPP-210/600 | T-AUTH, offline persisted-selection E2E |
| CF3 logout | RPP-210 | master failure/try-finally/revocation-uncertain E2E |
| CF4 identity/audit | RPP-200/230 | T-AUTH, T-AUD, two operators |
| CF5 RBAC | RPP-220/560 | HTTP/WS role matrix, T-WS |
| CF6 AI | RPP-200/240/560 | AI REST/WS ownership suite |
| CF7 Adminer | RPP-510 | T-ADM and all four callers |
| CF8 VPN | RPP-520 | T-VPN, URL/QR/partial/revoke |
| CF9 export | RPP-430/540 | T-XFER initial/repeat |
| CF10 public routes | RPP-500–550 | T-WEB/T-VPN/T-XFER/T-BR |
| CF11 IP | RPP-230 | T-IP |
| CF12 SSH | RPP-310/620 | non-22/target-host UI E2E |
| CF13 Panel Access | RPP-440 | T-PA |
| CF14 entity switch | RPP-610 | stale UUID no-request test |
| CF15 WS | RPP-560 | T-WS |
| CF16 timeout | RPP-010/400/420 | action metadata and timer-class tests |
| CF17 slow actions | RPP-030/400–420 | per-action >30/>600/recovery tests |
| CF18 transfer | RPP-430/540 | T-XFER, memory/rate gates |
| CF19 capabilities | RPP-100/130/150/640 | compatibility/state fixtures |
| CF20 fleet | RPP-630 | main/tag/nested-fleet tests |
| CF21 topology | RPP-110/120/300/440 | T-DIAL/T-PROV/T-PA |
| CF22 throttling | RPP-250/650 | NAT/operator/target/public limit tests |

## Acceptance A1–A20

| Acceptance | Required proof |
|---|---|
| A1 | persisted offline/auth-failed remote cannot affect setup/login/logout/profile/password/TOTP/sessions; selection resets main |
| A2 | same issuer/subject maps one target user; two operators have isolated AI/ownership/audit |
| A3 | generated ADMIN/MANAGER HTTP/WS action matrix; no elevation |
| A4 | same signed request/operation ID in master OUT and target IN; redaction tests |
| A5 | fresh/no-admin and existing-env/custom-port enrollment reaches verified manifest before commit |
| A6 | only verified channel bypasses allowlist; peer/browser IP visible separately |
| A7 | four Adminer/Manticore callers reach target; expiry/replay/key/cookie tests |
| A8 | stable VPN URL/QR; explicit source aggregation/order/dedupe/stale/revoke |
| A9 | initial/repeat export; staged Range/backpressure/resume; no large Blob |
| A10 | no-JWT webhook; exact bytes; provider verify; dedupe; outage retry/DLQ |
| A11 | target SSH/Panel facts; cutover commit or rollback |
| A12 | switch aborts old context and never requests/mutates stale entity ID |
| A13 | target WS restart reconnects/resubscribes without reload; deterministic pre-ready |
| A14 | >30/>600 work has durable status/reconcile; no ambiguous success |
| A15 | progressing stream governed by idle, not total time |
| A16 | deterministic current/legacy/newer/offline/auth/partial UI and reason |
| A17 | main cannot edit/delete/bulk; tags master-owned; recursion unavailable |
| A18 | Dashboard current and exact-404 legacy fallback remain green |
| A19 | T-TRACE-001 covers every page/action and CF1–CF22 |
| A20 | migrations, rollback, observability, security, performance, canary, and runbooks all signed off |

## Preserved behavior and intentional boundaries

| Item | Preservation gate |
|---|---|
| SP1 Dashboard | retain overview contract and exact-404 fallback; dirty tests mandatory |
| SP2 ordinary CRUD | protocol-1 delegated action catalogue covers verified routes/media |
| SP3 existing async | adapt/link existing operation, never double-enqueue |
| SP4 S3 | ExternalProvider URL unchanged |
| SP5 MODX | target-origin handoff replaces unsafe workaround |
| SP6 current streams | typed WS while ready; explicit degraded/polling limits |
| SP7 migration | master orchestration and direct source-target transfer unchanged |
| SP8 target update | capability/skew-gated trigger/poll and post-update manifest |
| IM1–IM6 | master registry/fleet/palette/migration/auth/Basic Auth remain master; no nested fleet |
| BN1 | intentional health 410 remains separately classified |
| BN2 | direct raw-body parser fixed separately from federation routing |
| BN3 | local Nginx inactivity repaired/aligned separately from relay timers |

## Observability

Structured logs/events:

- federation.context_check / manifest_refresh;
- federation.delegation_issue/reject/replay;
- federation.key_rotate/revoke/enroll;
- federation.http_result with timeout class;
- federation.audit_correlation;
- federation.ws_state/resubscribe/backpressure;
- operation.transition/lease/reconcile/needs_attention;
- public.adminer_handoff;
- public.vpn_fragment/partial;
- public.webhook_enqueue/retry/dlq;
- transfer.session/range/abort/checksum;
- registry.import/projection/cutover;
- panel_access.cutover/rollback.

Metrics use bounded action/protocol/state/outcome/timeout and registry-controlled target bucket labels. Never use user/entity/request/token/domain/URL/payload labels.

Alerts:

- auth/replay/key failure spikes;
- missing OUT/IN correlation;
- manifest incompatibility/endpoint drift;
- operation queue age/SQLite BUSY/lease reclaim;
- WS readiness/reconnect/backpressure;
- Adminer key/reuse/launch failures;
- VPN stale/partial rate;
- webhook backlog/DLQ;
- transfer checksum/disk/memory/failure;
- registry projection/Panel Access mismatch.

## Canary stop and rollback thresholds

Stages:

1. isolated target and ≤5% eligible volume for 24 h;
2. 25% for 24 h;
3. broad activation.

Immediate security stop:

- signature or replay bypass;
- TLS/SPKI/pinned-dial bypass;
- wrong target/actor/role;
- local login by federated identity;
- secret/cookie/raw-body leak;
- missing mutating OUT/IN audit;
- duplicated non-idempotent effect;
- unsafe auto-retry;
- accepted Adminer replay/key mismatch.

Rolling stop:

- ≥200 requests/15 min and feature failure >0.5%, error increase >2 points, or p95 increase >100 ms;
- queue depth ≥102 or oldest >120 s for 10 min;
- SQLite BUSY >1% or lease p95 >100 ms for 10 min;
- lease reclaim >0.5% or any non-retry-safe auto reclaim;
- WS READY failure >1% over ≥100 attempts/10 min or >5 protocol reconnects/channel;
- Adminer valid launch failure >1% after 50;
- transfer failure >1% after 50, any accepted checksum mismatch, or RSS +128 MiB;
- webhook backlog ≥800 or oldest >5 min for 10 min.

Security stop revokes/disables affected trust/capability and requires investigation/re-enrollment. Performance stop pauses promotion and drains safely. Preserve locks, spools, logs, and evidence. Do not automatically roll back committed schema or retry unsafe work.

## Rollout and rollback

### Rollout

- Reconcile dirty System Overview work before implementation.
- Build target protocol/trust/identity/manifest/pinned dialer first.
- Deploy target dual stack disabled.
- Migrate master registry in compare/dual-read mode.
- Enable observe, then v1 read-only, then selected capabilities per target.
- Public surfaces and WS have independent kill switches.
- Canary using thresholds above.
- Maintain active/previous key grace, JSON projection, old Panel Access listener, and expand-compatible release through observation.
- Retire legacy only after the measurable gate.

### Rollback boundaries

Pre-activation:

- disable feature;
- return registry authority to verified JSON;
- roll back to previous compatible code/config using normal release transaction.

After first JIT/new-only state:

- do not run v0.7.35;
- roll back only to expand-compatible federation release;
- keep new tables/rows and disable capabilities.

Panel Access:

- restore previous endpoint/config/listener via cutover journal; reconcile by ID; use SSH if necessary.

Operations:

- keep locks/evidence;
- reconcile or mark NEEDS_ATTENTION;
- never blind retry.

Trust compromise:

- immediate no-grace key revoke, close channels, invalidate grants, disable target, out-of-band re-enroll.

Snapshot/rehearsal includes consistent SQLite/WAL, state/data/.master-key or equivalent, registry JSON/projection, trust keys, webhook/artifact spools, target env, Nginx/PHP-FPM/firewall state, migration ledgers, and cutover journals.

Post-release commit failures use forward repair unless the established transaction explicitly supports the matching rollback state.

## Documentation/runbook work

Every runbook includes prerequisites, exact state checks, redacted evidence, safe commands, stop points, and recovery:

- enrollment/resume/removal;
- key rotation and master/target/bootstrap compromise;
- version/capability and legacy policy;
- public DNS/TLS/firewall and browser reachability;
- private topology deferral;
- Panel Access broken candidate/offline target/SSH recovery;
- registry import/projection and rollback floor;
- operation NEEDS_ATTENTION and child-process recovery;
- Adminer key/cookie/runtime recovery;
- VPN partial/stale/revoke;
- webhook DLQ/redrive;
- transfer disk/rate/resume;
- WS reconnect storms;
- mixed-fleet canary and kill switches;
- dev-mode/source-worktree release safety.

## Assumptions

### HIGH confidence

- Existing User FKs make shadow User the least disruptive operator identity.
- Per-target Ed25519 has lower verifier compromise authority than symmetric delegation.
- Adminer must run at the target origin in v1.
- Resumable Restic-style output requires a staged immutable artifact.
- Master auth must be independent of selected target.
- Existing Operation is the correct target ownership record; master needs links, not a second job state machine.

### MEDIUM confidence, activation-gated

- One API process with SQLite leases and durable AgentJob is sufficient for initial load.
- Exact request-target bytes can be preserved through the real proxy chain.
- Node and PHP can share the selected AES-GCM Adminer cookie safely.
- Proposed budgets fit expected fleet/load.
- Journaled registry projection is sufficient for the rollback window.

### LOW confidence / future

- Trusted private/VPN topology can be enabled without a separate network agent.
- Full Adminer parity is desirable when browsers cannot reach targets.
- Future multiple API replicas can share SQLite leases safely.
- Immediate offline target VPN credential revocation can be stronger than signed fragment expiry.

Low-confidence items are not required for protocol-1 activation.

## Operator unknowns and pending probes

No design choice blocks implementation. These block activation of the affected capability:

1. T-SIG exact byte/path/header preservation.
2. T-DIAL selected-address and TLS/SPKI behavior for HTTP/WS.
3. T-ADM real Node→Nginx→PHP-FPM interoperability.
4. T-OPS SQLite crash/lease and full child-process ownership.
5. transfer/VPN/webhook load and parser-amplification limits.
6. provisioning/registry/Panel Access rollback fixtures.
7. dependency-backed API/agent/web/migration aggregate suites and packaging.
8. canary automation and threshold evidence.

Non-blocking product defaults:

- public-only protocol 1;
- direct-only Adminer;
- selected-target VPN source by default, explicit aggregation;
- reset main on logout;
- main separate from fleet bulk;
- legacy removal after two releases plus 30 zero-use days.

## Pre-mortem residual risks

The pre-mortem verdict was fragile: the likely failure is activation before lower-layer evidence, not rejection of federation.

Highest residual risks:

1. design consensus mistaken for release approval;
2. federation changes overwrite dirty System Overview work;
3. provisioning/Panel Access template or endpoint generations diverge;
4. master health is mistaken for browser reachability;
5. Operation fields ship without a functioning worker/AgentJob/process contract;
6. Adminer key/runtime migration is incomplete;
7. generated stream is falsely advertised as resumable;
8. WS still uses browser-master connected as ready or retains onAny;
9. webhook/VPN raw/stale contracts are only partially implemented;
10. HMAC/static bearer or unsafe TLS survives despite final Ed25519 decision.

Each is prevented by the named dependency/test/kill-switch gates. A requirement for browser-unreachable Adminer, hard agent-restart job survival, private-only topology, or resumable output without staging would contradict a declared v1 boundary and requires a separate design.

## Hard boundaries / STOP

An implementation or rollout agent must stop when:

- unowned dirty-worktree overlap cannot be reconciled;
- .dev-mode would be removed/changed or make update would run on this VPS;
- a migration would use db push, edit an applied migration, or mutate production without authorized snapshot/rehearsal;
- delegated traffic would use HTTP, rejectUnauthorized:false, unpinned DNS, redirect, static bearer fallback, or forwarded master JWT/cookie;
- a federated user can enter local auth/setup/user-admin paths;
- an unclassified route/event would be remotely callable;
- an unsafe mutation lacks idempotency/reconciliation or would be retried blindly;
- a child process cannot be owned/cancelled/reconciled;
- tools/adminer runtime symlink would be edited/dereferenced as source;
- Adminer key/cookie fixture or browser reachability fails;
- a large transfer would use master fallback or browser whole-Blob;
- registry projection/cutover state disagrees;
- worker or canary stop thresholds fire;
- rollback would cross below the expand-compatible floor after new-only state;
- any secret/raw body/token/cookie appears in logs, metrics, or browser-visible context.

## Git stamp and drift status

Evidence was gathered from:

- root: /opt/meowbox;
- branch: main;
- commit: 1b1dab8dd87aa281b1fcdaff129e17d540819bc6;
- VERSION: v0.7.35;
- describe: v0.7.35-dirty;
- .dev-mode: present;
- date: 2026-08-24.

The worktree contained unrelated System Overview changes, including overlapping proxy, API/socket composables, layout, installer, package/workflow, and dashboard files. Implementation must rerun RPP-000/RPP-010 against its exact merge point. If routes, schemas, generated templates, operations, Adminer source/runtime layout, or System Overview contracts drift, update the action matrix and affected task/test mapping before editing. Do not silently apply this plan to a different repository state.

decision: consensus
