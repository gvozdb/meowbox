plan
meta:
  file: specs/remote-panel-parity/planner_prompt.md
  title: Fusion planner prompt for complete remote panel parity
  status: ready
  output_dir: specs/remote-panel-parity

planner_contract:
  role: Fusion planning agent with zero prior chat context
  task: produce the complete implementation plan for remote-panel parity; do not implement code
  inspect:
    - current repository and dirty worktree before proposing edits
    - specs/remote-panel-parity/idea.md
    - CONTEXT.md if present
    - docs/adr if present
    - existing specs, runbooks, migrations, tests, release tooling, and runtime templates relevant to the feature
  publish:
    tool: fusion_spec_write
    directory: specs/remote-panel-parity
    artifacts:
      - plan.md
      - debate.md
  publish_rules:
    - use fusion_spec_write for both final artifacts
    - do not write planning artifacts outside specs/remote-panel-parity
    - do not overwrite idea.md or planner_prompt.md
    - do not implement application code, migrations, config changes, commits, tags, releases, restarts, or production mutations
    - plan.md must be executable by a fresh implementation agent without conversation context
    - debate.md must preserve alternatives, tradeoffs, rejected options, decisions, and unresolved blockers

operator_intent:
  O1: make additional Meowbox servers selected from the top-left sidebar support the full panel correctly and predictably
  O2: create a complete, ideal, maximum-detail work plan covering every audited gap and production nuance
  O3: prefer clean compatible design over endpoint-by-endpoint hacks
  O4: state risks and compromises directly; no praise, filler, vague recommendations, or invented facts
  O5: preserve current stack and avoid unnecessary architecture complexity

project_context:
  P1:
    root: /opt/meowbox
    version: v0.7.35
    branch: main
    stack: Nuxt/Vue frontend, NestJS API, Prisma/SQLite data layer, Node agent, Socket.IO, Nginx, PM2/system services
  P2:
    mode: production VPS also used as source dev workspace
    invariant: /opt/meowbox/.dev-mode must remain present and untouched
    forbidden_here: make update, release-mode conversion, destructive production experiments
  P3:
    persistent_root: /opt/meowbox/state
    release_model: VERSION bump -> git tag -> workflow tarball -> make update on appropriate release target
  P4:
    worktree: dirty with unrelated System Overview dashboard implementation
    rule: preserve all unrelated existing/untracked changes
  P5:
    current_audit_scope:
      vue_pages: 34
      api_controllers: 48
      agent_ts_modules: 66
      result: ordinary same-version REST CRUD is generally path-reachable through generic proxy

terms:
  master: public panel where operator authenticates and selects server
  remote: additional Meowbox server registered on master
  control_plane: master-owned registry, fleet orchestration, auth lifecycle, palettes
  data_plane: resources and actions belonging to selected server
  remote_context: selected server identity plus API, WebSocket, public origins, protocol/capabilities, and delegated operator
  delegated_principal: stable target-side representation of master operator
  current_proxy: master /api/proxy/:serverId/* HTTP relay plus Socket.IO upstream relay authenticated by X-Proxy-Token/PROXY_TOKEN
  public_surface: route usable without master JWT
  long_operation: mutation or read whose legitimate duration can exceed ordinary interactive request budget

current_architecture:
  CA1 frontend_http:
    file: web/composables/useApi.ts
    behavior: normal endpoints receive /proxy/{currentServerId}; /servers*, /proxy/*, and explicit noProxy bypass it
    transports: JSON, raw text, upload, download all share selected prefix
  CA2 frontend_selection:
    files:
      - web/stores/server.ts
      - web/layouts/default.vue
      - web/plugins/stores-init.client.ts
    behavior: current server persists in localStorage and switch performs full reload while preserving route
  CA3 frontend_auth:
    files:
      - web/stores/auth.ts
      - web/pages/login.vue
      - web/pages/setup.vue
    behavior: login/setup/profile/logout currently inherit selected proxy; refresh is master-local
  CA4 backend_http:
    files:
      - api/src/proxy/proxy.controller.ts
      - api/src/proxy/proxy.service.ts
      - api/src/proxy/proxy.dto.ts
    behavior: @All forwards method/query/raw body to server.url + /api + target path, strips master Authorization/Cookie, adds X-Proxy-Token
    authorization: outer controller requires master ADMIN
    timeout: total 30 seconds by default, 600 seconds for static startsWith list
  CA5 target_auth:
    files:
      - api/src/common/guards/proxy-auth.guard.ts
      - api/src/common/guards/jwt-auth.guard.ts
    behavior: valid proxy token maps request to oldest target ADMIN
  CA6 websocket:
    files:
      - web/composables/useSocket.ts
      - api/src/gateway/agent.gateway.ts
      - api/src/gateway/agent-relay.service.ts
    behavior: browser connects to master with proxyServerId; master opens non-reconnecting upstream socket using target proxy token; target assigns synthetic proxy:{masterUserId} with ADMIN role
  CA7 provisioning:
    files:
      - api/src/proxy/provision.service.ts
      - install.sh
      - agent/src/panel-access/panel-access.manager.ts
    behavior: master provisions over SSH, generates token, installs remote, then records a URL derived from master API_PORT
  CA8 persistence:
    server_registry: data/servers.json via ProxyService
    database_schema: api/prisma/schema.prisma

confirmed_failures:
  CF1 auto_provision [p0]:
    - fresh target env sets API_HOST=127.0.0.1 and default API_PORT=11860
    - firewall/public Nginx exposes PANEL_PORT, normally 11862, not raw API_PORT
    - master records http://host:{master API_PORT}; custom master port can be wrong for target
    - fresh install has no ADMIN until direct panel setup; HTTP proxy rejects without target ADMIN
    - existing .env is not overwritten, so generated master token can differ from existing target PROXY_TOKEN
    - result: nominally provisioned target is offline/unusable through registry
  CF2 stale_remote_auth [p0]:
    - selected remote persists across logout
    - publicPost/publicGet remove JWT but still add proxy prefix
    - /auth/login, /setup/status, /setup/init hit ADMIN-only master proxy and fail before target @Public metadata
    - login/setup pages have no server selector or recovery path
  CF3 logout [p0]:
    - /auth/logout is proxied
    - master refresh token is checked with target refresh secret and failure is silently treated as success
    - local storage clears but master refresh session remains valid
  CF4 identity_ownership_audit [p0]:
    - HTTP target principal is oldest target ADMIN, not master operator
    - /auth/me can overwrite displayed master identity
    - profile email/password/TOTP/session revocation modifies target admin
    - ownership, createdBy, personal notification/settings, and activity attribution are wrong
    - multiple master operators collapse into one target identity
    - target AuditInterceptor expects a proxy marker but receives real admin ID; intended IN proxy records are absent/misattributed
    - master ProxyAuditLog OUT can retain real operator, but target Activity lies and lacks trustworthy correlation
  CF5 rbac [security,p0]:
    - HTTP proxy permits only master ADMIN even when target endpoint allows MANAGER
    - WS proxy accepts master ADMIN or MANAGER
    - target WS promotes every proxy connection to ADMIN
    - relay forwards arbitrary application event names
    - MANAGER can gain target terminal/live/admin capabilities if server ID is available
  CF6 ai [p0]:
    - AI REST session list/get/rename/delete runs as oldest target ADMIN
    - AI WS uses synthetic proxy:{masterUserId}
    - AiSession.userId has FK to User.id; synthetic user does not exist
    - first streamed response may run, but persistence/history/resume/title/delete/multi-turn are inconsistent or fail
    - target admin AI history can be exposed to unrelated master operator
  CF7 adminer [p0]:
    - database and Manticore ticket endpoints return relative /adminer/sso.php URLs
    - four UI entry points open that URL on master origin: web/pages/databases.vue, web/components/SiteDatabasesTab.vue, web/components/SiteServicesTab.vue, web/pages/sites/[id].vue
    - ticket encryption key and DB/service live on target, while master Adminer receives ticket
    - Adminer is outside generic /api proxy
  CF8 vpn_subscription [p0]:
    - web/pages/vpn.vue builds window.location.origin + /api/vpn/sub/{remoteToken}
    - URL and QR hit master DB with target-local token
    - public subscription cannot be exposed through ADMIN-only /proxy route
    - per-service credentials/raw config work
    - one stable aggregated subscription across servers is not implemented; current data model is target-local and not tied to a federated panel principal
  CF9 stream_export [p0]:
    - backend returns relative /backup-exports/{id}/download URLs
    - initial native download uses master apiBase without selected prefix
    - repeat remote workaround only activates for obsolete URLs beginning /api/; current URLs do not
    - both initial and repeat STREAM downloads therefore hit master
    - S3 presigned export is separate and works
  CF10 public_routes [p0]:
    - outer proxy ADMIN requirement erases target @Public semantics
    - external deploy webhook cannot call central remote path without master JWT
    - same protocol boundary affects VPN subscription and one-shot download URLs
    - domain application/MODX login currently works only because authenticated UI fetches raw HTML through proxy and document.write; preserve or replace safely
    - site-to-site migration intentionally uses direct public one-shot target download and should remain master-orchestrated
  CF11 ip_allowlist [p0]:
    - target bypass checks /api/proxy/* or /proxy/*
    - master strips proxy prefix and calls target /api/*
    - IP allowlist guard executes before ProxyAuthGuard
    - valid proxy token can be blocked unless master source IP is allowlisted
    - current-IP UI can show proxy/master peer instead of operator IP
  CF12 ssh [p1]:
    - web/pages/sites/[id].vue uses window.location.hostname and fixed port 22
    - selected remote API host/port response is ignored
  CF13 panel_access [p1]:
    - remote state/mutations use selected server
    - displayed current URL, protocol, and port come from master browser origin
    - remote domain/protocol/port changes do not update master server registry
    - target can become unreachable after a valid Panel Access change
  CF14 entity_switch [p1]:
    - server switch reloads current route
    - /sites/:id and /dns/zones/:id reuse previous server UUID and usually 404
  CF15 websocket_lifecycle [p1]:
    - browser reports connected when master socket connects before upstream readiness is explicit
    - events emitted during handshake can be lost
    - upstream reconnection=false
    - upstream disconnect causes server-initiated browser disconnect, which Socket.IO does not automatically reconnect
    - singleton listeners attached to old socket are not reliably replayed to replacement socket
    - no proxy-ready, degraded, resubscribe, or supported fallback contract
    - affected surfaces include terminal, log tail, metrics, AI, deploy/backup/PHP/provision logs and progress, hostpanel migration events
  CF16 timeout_policy [p1]:
    - current LONG_RUNNING_PATHS uses startsWith and contains stale/dead prefixes such as /sites/clone, /database/import, /database/dump, /ssl/issue, /sites/install, /storage/auth
    - actual nested routes frequently begin /sites, /backup-exports, /vpn, /panel-access, /country-block, or /storage
    - proxy AbortSignal is total wall-clock timeout and can kill an active stream
    - target mutation may continue after master returns 502; blind retry can duplicate or conflict
    - generated Nginx also has generic 30-second inactivity timeout; distinguish baseline local issue from proxy total-time issue
  CF17 known_slow_actions [p1]:
    - site/domain deletion with snapshots up to 900 seconds
    - DB delete/export/import/upload/download up to 600 seconds
    - nested SSL issue/revoke 180/90 seconds
    - MODX update 900 seconds, doctor 60 seconds, permission normalize 120 seconds
    - per-site Redis/Manticore/MinIO lifecycle/reconfigure 60-300 seconds
    - Node Quick Command up to 660 seconds
    - VPN runtime install/uninstall up to 600 seconds and other lifecycle calls using 120-second agent default
    - country-block refresh/apply/sync/toggle/CRUD auto-apply/clear 60-600 seconds
    - Panel Access certificate operations 60-180 seconds
    - storage-location test and top-files scan 60 seconds
    - Restic snapshot list/tree/diff operations 60-600 seconds
    - hostpanel force-retry cleanup 90 seconds
    - OS update check 180 seconds
    - PHP install/uninstall backend budgets 930/630 seconds while proxy long cap is 600 seconds
    - global service/system paths can race the exact 600-second cap plus overhead
    - site creation, site duplication, normal domain provisioning, backup triggers/restores/checks, normal hostpanel probe/start/retry are asynchronous and must not be incorrectly converted into timeout defects
  CF18 large_transfers [p1]:
    - proxy upload body is buffered on master up to 100 MB before forwarding
    - response strips Content-Length/Content-Encoding
    - useApi.download without Content-Length falls back to whole-response Blob behavior
    - master remains bandwidth/connection bottleneck
    - file, DB, backup, and future 50 GB STREAM transfers are not production-safe through current path
    - normal /backups downloads get 600-second total cap; many file/DB/export paths get 30 seconds
  CF19 version_capability [p1]:
    - master UI version drives all remotes
    - only Dashboard has explicit legacy endpoint fallback; palette sync is best-effort; migration has explicit minimum v0.6.59
    - old target missing a route yields raw 404/schema error with no action gating
    - newer target functionality is invisible to older master UI
    - health/offline classification depends on /admin/update/version and conflates missing endpoint, missing admin, token mismatch, and network failure
  CF20 fleet_ui [p1]:
    - server store injects virtual main as if it were ServerConfig
    - main is offered for checkbox bulk update, edit, and delete although backend has no row
    - main-only bulk fails; mixed bulk silently ignores main
    - release tags are fetched from currently selected remote while /servers/update-bulk remains master-local
    - remote's own server registry/audit/children are inaccessible because /servers* always belongs to master
  CF21 topology_config [p1]:
    - manual UI examples use private 10.0.0.5 and obsolete port 3000
    - safe URL validator intentionally rejects private, loopback, CGNAT, and ULA topology
    - one server.url is overloaded for HTTP API, Socket.IO, health, and direct migration download
    - URL path prefixes are accepted by DTO but incompatible with constructed HTTP and Socket.IO paths
    - remote Panel Access changes can invalidate this URL
    - no coordinated proxy-token rotation or dual-token grace exists
  CF22 throttling [p2]:
    - generic proxy adds 120 requests/minute per client IP
    - target endpoint throttles can see aggregated master traffic
    - several operators/tabs behind one NAT can receive remote-only 429 responses

intentional_master_scope:
  IM1: /servers registry CRUD, health refresh, provisioning orchestration, server audit, and fleet bulk update
  IM2: palette map stored per server on master with best-effort target sync
  IM3: Meowbox site-to-site migration start/status orchestration using explicit noProxy and direct node transfer
  IM4: master refresh-token rotation and global auth lifecycle
  IM5: Nuxt Basic Auth protecting current master origin
  IM6: no recursive remote-child fleet management for this feature unless product explicitly reverses this decision

currently_supported_preserve:
  SP1: Dashboard Overview current endpoint and exact-404 legacy fallback to dashboard summary, system metrics, and sites
  SP2: ordinary same-version ADMIN CRUD for sites, domains, DNS, Nginx, PHP, services, firewall, cron, processes, monitoring, storage metadata, users, and server-local settings within transport limits
  SP3: asynchronous site create, site duplicate, domain provisioning/retry, backup trigger/restore/check, standard hostpanel discovery/probe/start/retry
  SP4: S3 presigned exports
  SP5: domain application/MODX authenticated HTML login workaround
  SP6: terminal, tails, metrics, and progress streams while initial WS relay remains healthy
  SP7: site-to-site migration when source and target URLs are mutually reachable and compatible
  SP8: target panel update trigger and polling

baseline_not_proxy_specific:
  BN1: standalone web/pages/health.vue calls legacy /health/:siteId/pings which intentionally returns 410 locally and remotely; plan may include adjacent repair but must not mislabel it as remote-only
  BN2: deploy webhook raw-body/HMAC preservation requires verification even for direct target delivery; separate generic bug from public proxy routing requirement
  BN3: generated Nginx 30-second inactivity timeout affects local synchronous calls too; proxy adds distinct total timeout and extra hop

security_invariants:
  SI1: current X-Proxy-Token is a static ADMIN bearer, not HMAC despite comments/docs
  SI2: HTTP remote URLs currently expose bearer in cleartext
  SI3: HTTPS by IP currently disables certificate verification
  SI4: final design must authenticate master, target, operator, audience, role/permissions, expiry, request correlation, and replay policy
  SI5: target role/permissions <= delegated master role/permissions AND target policy
  SI6: public relays use narrow scoped one-time/stable tokens, never general proxy admin credential
  SI7: secrets, one-time URLs, credentials, raw webhook bodies, and private data are redacted from logs and metrics
  SI8: SSRF, DNS rebinding, metadata IP, link-local, loopback, redirect-to-private, and path-prefix cases need explicit validation and tests

required_architecture_topics:
  RA1 remote_context:
    - canonical server ID and display name
    - API base URL, WebSocket base URL, browser public base URL, direct-transfer base URL
    - proxy protocol version, product version, feature capabilities, compatibility range
    - online/degraded/auth-failed/version-incompatible status with precise reason
  RA2 delegated_identity:
    - one signed short-lived identity contract shared by HTTP and WebSocket
    - stable target-side principal compatible with Prisma FK ownership and AiSession
    - just-in-time creation/update or explicit synchronization lifecycle
    - no interactive login credentials for shadow/federated identities
    - issuer+subject uniqueness and safe deletion/deactivation semantics
  RA3 trust_rotation:
    - long-lived bootstrap secret is not sent as ambient ADMIN bearer on every request
    - key enrollment, storage, rotation, revocation, dual-key grace, compromise recovery
    - compare Ed25519, per-server HMAC, mTLS, or layered design in debate.md
  RA4 auth_boundary:
    - login/setup/refresh/logout/profile/password/TOTP/master sessions are always master-owned
    - remote selection must not prevent authentication or recovery
    - decide whether logout preserves selected server; either outcome must be deterministic and safe
    - remote /users remains explicitly server-scoped administration, distinct from current master operator profile
  RA5 public_link_contract:
    - typed response distinguishes proxy-authenticated URL, direct target signed URL, master public gateway URL, and external provider URL
    - no browser-origin inference for selected target
    - Adminer/Manticore, VPN subscriptions, STREAM exports, deploy webhooks, migration downloads, and domain app login each get explicit strategy
  RA6 adminer:
    - debate master reverse gateway versus direct target signed SSO
    - account for relative assets, cookies, paths, encryption keys, expiry, one-time use, browser reachability, and target availability
  RA7 vpn:
    - define ownership of subscription entity/token
    - support valid stable URL/QR
    - plan optional/required aggregation of configs from multiple servers, partial outage semantics, deduplication, ordering, cache TTL, token rotation, and disabled services/users
  RA8 webhooks:
    - stable external endpoint without master JWT
    - preserve exact raw bytes and provider signature validation
    - route to target using scoped identity
    - idempotency, replay window, target outage/retry/dead-letter behavior
  RA9 large_transfer:
    - preferred direct target signed URL/upload session
    - optional master streaming fallback with backpressure
    - Content-Length, Content-Disposition, Range, resume, checksum, cancellation, expiration, one-time use
    - avoid browser whole-Blob for multi-gigabyte files
    - explicit size, rate, concurrency, disk, memory, and bandwidth budgets
  RA10 operation_protocol:
    - replace stale path-prefix timeout policy with endpoint metadata/capability or asynchronous operation contract
    - operation ID, state, progress, idempotency key, cancellation, retryability, final error, reconciliation after disconnect
    - distinguish total, connect, headers, idle, and operation deadlines
    - align Nest, Undici, browser, Nginx, Socket.IO, agent, and upstream timeouts
  RA11 websocket:
    - proxy:connecting/ready/degraded/reconnecting/failed states
    - buffer bounded safe events or reject before ready
    - reconnect upstream with bounded backoff and jitter
    - restore rooms/subscriptions/listeners and in-flight operation progress
    - event allowlist plus per-event permission and payload validation
    - ack timeout, cancellation, backpressure, stale socket cleanup
    - polling fallback only where semantically useful; no fake connected state
  RA12 ip_and_audit:
    - authenticated server channel bypass occurs after cryptographic verification, not path string
    - separate trusted master peer IP from delegated browser IP
    - UI labels both when relevant
    - correlated master OUT and target IN audit records include operator, issuer, target, route/action, outcome, duration, request ID
  RA13 provisioning:
    - install target trust/protocol and discover target manifest before registry commit
    - use target-reported canonical public/API/WS ports; never master API_PORT
    - bind raw API safely; prefer Nginx/public origin instead of exposing raw API
    - bootstrap target for proxy without requiring direct first-admin setup
    - handle new install and existing .env idempotently without silently replacing unrelated secrets
    - health validation before commit; rollback/cleanup on partial failure; resumable SSH logs
  RA14 panel_access:
    - display selected target canonical URL/protocol/port from remote_context
    - apply domain/cert/port change transactionally
    - update registry only after new endpoint health passes
    - retain rollback endpoint/path if new access configuration fails
    - clearly label direct-target Basic Auth and access policy versus master-origin enforcement
  RA15 navigation:
    - server switch from entity pages navigates to safe collection route or resolves a stable cross-server identity
    - never issue mutation/read against same UUID on new server without explicit mapping
    - preserve intended tab/filter only when compatible
  RA16 fleet_ui:
    - main is separate view model; no edit/delete fake row
    - decide explicit main update workflow versus remote-only bulk
    - release tags and compatibility rules come from master control plane
    - offline/skewed selected remote cannot break fleet controls
    - nested remote fleet remains out of scope and is labeled
  RA17 capabilities:
    - lightweight health endpoint independent of GitHub/update functionality and local ADMIN existence where safe
    - negotiated protocol/capability manifest with cache and refresh
    - UI hides/disables unsupported action with exact reason
    - current, legacy, newer, offline, auth-failed, and partial-capability states
    - dual-stack fallback and deprecation telemetry
  RA18 rate_limits:
    - budgets keyed by operator+target+route or operation, not only client IP
    - retain abuse protection for public surfaces and server channel
    - prevent master fan-out from consuming one target bucket unfairly
  RA19 observability:
    - bounded metrics for local/remote, target, protocol, action class, result, timeout type, WS state
    - no unbounded entity IDs or secret-bearing labels
    - structured logs with request/operation correlation
    - dashboards/alerts for auth failures, version skew, reconnect storms, queue age, transfer failures

rejected_shortcuts:
  RJ1: keep using oldest target ADMIN and patch only audit display
  RJ2: forward master JWT directly to target with unrelated JWT secret/audience
  RJ3: make master proxy public for every target @Public route
  RJ4: concatenate window.location.origin or server.url ad hoc in individual pages
  RJ5: add more startsWith paths to LONG_RUNNING_PATHS as final timeout architecture
  RJ6: route all large files through master and increase timeout/memory limits
  RJ7: trust any private URL or disable SSRF validation globally
  RJ8: recursive master-of-master fleet traversal
  RJ9: big-bang protocol switch requiring simultaneous fleet update
  RJ10: prisma db push, direct production edits, make update on current dev-mode VPS, or destructive validation against real sites

planning_requirements:
  PR1 plan_structure:
    - executive outcome and chosen architecture
    - scope/non-goals/terminology
    - verified current-state references with exact files/symbols/routes
    - decision log linked to debate.md
    - dependency graph and phased order
    - per-task files, contracts, data changes, failure modes, tests, observability, rollout, rollback
    - acceptance matrix covering every confirmed failure and preserved supported feature
    - open questions labeled blocking or non-blocking
  PR2 phase_expectation:
    - Phase 0 characterization tests and feature/action matrix
    - Phase 1 protocol/capability/trust foundations on target with backward compatibility
    - Phase 2 delegated identity, consistent RBAC, audit, auth boundary
    - Phase 3 canonical endpoints, provisioning, Panel Access registry updates, IP policy
    - Phase 4 public surfaces and large-transfer architecture
    - Phase 5 WS lifecycle and async operation/timeout model
    - Phase 6 page-specific UX cleanup: SSH, navigation, fleet, Basic Auth labels, rate limits
    - Phase 7 mixed-version rollout, migration, release gates, legacy deprecation
    - planner may reorder when dependencies require, but must explain the changed order
  PR3 task_granularity:
    - tasks must be implementable and independently verifiable
    - avoid vague verbs improve/support/handle/fix without observable result
    - identify shared helpers/contracts instead of duplicating business logic
    - name likely files/modules, but verify them in current repo before finalizing
    - identify whether each task changes Prisma schema, env, Nginx/system templates, filesystem layout, or OS state
  PR4 migrations:
    - schema change -> Prisma migration; never db push
    - new env default -> idempotent system migration updates state/.env
    - Nginx/php-fpm/logrotate/cron/systemd template change -> idempotent system migration and regeneration of all existing affected sites/panels
    - filesystem move/rename or OS state change -> idempotent system migration
    - use tools/new-migration.sh convention where applicable
    - plan rollback/data compatibility and giant-volume query/index cost
    - do not execute migrations during this planning task
  PR5 testing:
    - unit tests for URL normalization, capabilities, delegation validation, role mapping, token expiry/rotation, IP extraction, timeout policy
    - API integration tests for raw JSON/multipart/binary, public routes, redirects/cookies if retained, audit correlation, idempotency, target continuation
    - WS integration tests for readiness race, reconnect, listener replay, event authorization, ack/cancel, target restart
    - provisioning tests for fresh/existing install, no admin, custom ports, token mismatch, failed install resume, public/private topology decisions
    - E2E matrix: main/current remote/legacy remote/newer remote/offline/auth-failed/IP-blocked
    - role matrix: ADMIN/MANAGER and any current VIEWER behavior
    - origin matrix: master gateway/direct target/external provider
    - transfer tests: small, 100 MB boundary, multi-GB simulated stream, 50 GB logical fixture, Range resume, slow continuous stream, abort
    - long-operation tests: >30 seconds, >600 seconds, target completion after client disconnect, safe retry/reconciliation
    - page matrix for all visible and hidden routes plus shared components/composables
    - preserve dashboard proxy/fallback/contract/accessibility tests
    - use isolated fixtures/containers/temp remotes; never mutate production sites/data
  PR6 rollout:
    - target-first dual-stack protocol so old master still functions
    - master feature-detects and uses new path only when advertised
    - migrate servers.json or replacement registry backward-compatibly and reversibly
    - shadow principal/backfill strategy if chosen
    - key/token dual-read/dual-write grace and revocation procedure
    - canary one test remote, then mixed legacy fleet, then broader rollout
    - per-server kill switch/fallback to legacy read-only behavior
    - health, metrics, logs, snapshot, rollback checkpoints
    - no direct production code edits
  PR7 release_rules:
    - before dangerous operations: make snapshot on authorized implementation rollout
    - before commit/tag/release: bump VERSION
    - release via tag/workflow tarball
    - current VPS stays .dev-mode and must not run make update
  PR8 docs_ops:
    - operator enrollment/runbook
    - trust rotation and compromise response
    - version compatibility table and deprecation policy
    - public URL/DNS/TLS/firewall requirements
    - private-network policy if accepted
    - recovery from broken Panel Access URL, offline target, or partial provisioning

debate_requirements:
  DB1: shadow User versus new Principal model; evaluate Prisma/FK impact, AI/ownership/audit, migrations, login isolation
  DB2: Ed25519 versus HMAC versus mTLS delegation; evaluate rotation, storage, replay, multi-master, operational recovery
  DB3: direct target public URLs versus master reverse gateway per Adminer, subscription, webhook, and transfer surface
  DB4: VPN aggregation ownership/data model, consistency, partial failures, privacy, cache, token semantics
  DB5: async operations versus longer synchronous proxy metadata for each slow-action class
  DB6: public-only remotes versus explicit trusted private-network enrollment
  DB7: servers.json evolution versus DB-backed registry; consider secrets, atomicity, migrations, rollback, query/index needs
  DB8: whether main participates in fleet update and how update compatibility prevents remote > master protocol skew
  DB9: minimum legacy protocol/version and removal criteria
  DB10: browser reachability requirement for direct download/Adminer and master fallback behavior
  DB11: preserve or replace document.write MODX handoff with safer mechanism
  DB12: Basic Auth and Panel Access product semantics when configuring a remote from master origin

acceptance_required_in_plan:
  A1: persisted offline remote cannot block setup/login/logout/profile/security lifecycle
  A2: same master operator maps to stable remote principal; different operators never share ownership/history/audit
  A3: MANAGER has identical allowed/denied actions over HTTP and WS; no target privilege escalation
  A4: master OUT and target IN audit correlate without secret leakage
  A5: fresh and existing provisioning produce reachable remote with correct endpoint manifest and recoverable trust
  A6: target IP allowlist permits authenticated trusted master channel while preserving operator-IP visibility and browser perimeter
  A7: all four Adminer/Manticore entry points reach correct target and reject expired/replayed ticket
  A8: VPN URL/QR works; aggregation semantics are explicit and tested across partial outages
  A9: initial and repeated STREAM export work; large download supports backpressure/resume and avoids whole-browser Blob
  A10: deploy webhook accepts provider request without master JWT, preserves raw signature semantics, is idempotent, and survives transient target outage per chosen policy
  A11: SSH command and Panel Access show target host/protocol/port; access changes update registry safely or roll back
  A12: switching server on entity route cannot query/mutate stale entity ID
  A13: target WS restart reconnects and resubscribes without page reload; pre-ready events are deterministic
  A14: >30s and >600s operations expose durable status; client timeout never creates ambiguous success
  A15: continuous large stream is governed by idle timeout, not fixed total timeout
  A16: capabilities give deterministic UI for current, legacy, newer, offline, auth-failed, and partial remotes
  A17: fleet page cannot edit/delete fake main; tags are master-owned; nested fleet boundary is explicit
  A18: Dashboard current remote and legacy fallback remain unchanged and green
  A19: test matrix covers every current page/action and every confirmed failure CF1-CF22
  A20: migrations, rollout, rollback, observability, security review, performance budgets, and operator runbooks are release gates

open_questions:
  Q1 [blocking]: choose delegated_principal persistence model and justify migration/rollback cost
  Q2 [blocking]: choose delegation trust/signing/rotation protocol and compromise-recovery path
  Q3 [blocking]: choose public delivery strategy separately for Adminer, VPN, webhooks, and large transfers
  Q4 [blocking]: define VPN subscription owner, aggregation scope, and partial-outage contract
  Q5: decide whether explicitly enrolled private/VPN remotes are in scope while retaining SSRF defenses
  Q6: define remote Panel Access and Basic Auth product semantics from master origin
  Q7: decide whether main participates in fleet update or remains a separate update workflow
  Q8: set minimum legacy proxy protocol, compatibility window, and removal gates

required_final_artifacts:
  plan.md:
    must_include:
      - final recommended architecture
      - phased tasks with stable IDs and dependencies
      - exact likely files/modules/routes/contracts per task after repository verification
      - DB/config/system migration matrix
      - security threat model and abuse cases
      - performance/resource budgets
      - test matrix and acceptance mapping
      - mixed-version rollout and rollback
      - production/dev-mode safety gates
      - documentation/runbook work
  debate.md:
    must_include:
      - alternatives DB1-DB12
      - decision criteria and tradeoffs
      - selected option and explicit rejected options
      - unresolved questions with blocking status and recommended default
      - consequences for compatibility, security, complexity, operations, and migrations

final_instruction:
  F1: inspect first, resolve facts from code, then publish specs/remote-panel-parity/plan.md and specs/remote-panel-parity/debate.md using fusion_spec_write
  F2: do not implement code or mutate runtime state
  F3: do not finish until both artifacts are written and internally cross-referenced
