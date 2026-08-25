spec
meta:
  file: specs/remote-panel-parity/idea.md
  title: Remote panel parity
  status: draft-for-fusion-planning
  product: Meowbox v0.7.35
  source: exhaustive read-only audit of current worktree

terms:
  master: panel origin where operator authenticates and selects servers
  remote: additional Meowbox server registered on master
  remote_context: server identity, API/WS/public origins, capabilities, protocol version, delegated operator
  control_plane: master-owned server registry, fleet orchestration, global auth, palettes
  data_plane: selected server resources and operations
  delegated_principal: stable target-side identity derived from authenticated master operator
  public_surface: route used without master JWT, including subscriptions, webhooks, SSO handoffs, signed downloads

goal:
  G1: Selecting remote makes every supported data-plane feature behave like the same feature on master.
  G2: Master-only behavior is explicit in UI and API; no feature silently uses the wrong server.
  G3: HTTP, WebSocket, audit, ownership, RBAC, links, downloads, timeouts, and version handling share one remote_context contract.
  G4: Remote access remains secure, observable, backward-compatible, and safe to roll out on production fleets.

non_goals:
  NG1: Recursive federation of a remote server's own child-server registry.
  NG2: Forwarding master JWTs to remotes or keeping first-remote-admin impersonation.
  NG3: Sending multi-gigabyte transfers through master as the preferred path.
  NG4: Big-bang removal of current X-Proxy-Token compatibility.
  NG5: Implementing code in the specification/planning turn.

facts:
  F1: Generic @All proxy reaches ordinary same-version REST CRUD; controller-family reachability is not the main defect.
  F2: Current selector changes REST prefix and Socket.IO target, but browser origin, auth identity, public URLs, capabilities, and control-plane scope remain ambiguous.
  F3: Confirmed gaps include provisioning, auth lifecycle, identity/RBAC/audit, AI persistence, Adminer, VPN subscriptions, STREAM exports, public webhooks, IP allowlist, SSH info, Panel Access, entity-route switching, WS recovery, timeout coverage, large transfers, version skew, and fleet UI semantics.
  F4: Dashboard Overview and its explicit legacy fallback already support remotes and must not regress.
  F5: Site create/duplicate/retry, backup triggers/restores/checks, and normal hostpanel migration are asynchronous and are not classified as proxy-timeout defects.

decisions:
  D1: master remains sole control_plane; selected remote supplies data_plane.
  D2: /auth login, refresh, logout, setup, profile, password, TOTP, and master sessions never depend on selected remote.
  D3: replace ambient first-admin impersonation with short-lived signed delegation and a stable delegated_principal usable by DB foreign keys, ownership, AI, notifications, and audit.
  D4: HTTP and WebSocket use identical operator identity and permission semantics; target policy may reduce but never increase master permissions.
  D5: split overloaded server.url into validated API, WebSocket, public-browser, and direct-transfer endpoint metadata plus a capability/protocol manifest.
  D6: every public_surface declares one explicit delivery strategy: stable master gateway, direct target signed URL, or external provider URL.
  D7: long mutations become asynchronous operations with idempotency and polling where practical; streams use idle timeout, backpressure, range/resume, and cancellation instead of path-prefix total timeouts.
  D8: target capabilities gate UI actions with explicit reasons; Dashboard legacy fallback remains a narrow compatibility path.
  D9: rollout is dual-stack and reversible: target support first, master negotiation second, migration/cutover third, legacy removal last.
  D10: remote registry UI treats main as a distinct non-editable control-plane node, not a fake ServerConfig row.

required_outcomes:
  O1 provisioning:
    - fresh and existing remote installation produces a reachable canonical endpoint manifest
    - correct target ports/binds are discovered from target, never copied from master env
    - trust bootstrap and rotation are idempotent
    - no direct remote UI setup is required before health/auth works
  O2 identity_security:
    - no oldest-admin substitution
    - ADMIN/MANAGER behavior is consistent across HTTP and WS
    - WS events are allowlisted and permission-checked
    - master OUT and target IN audit records share correlation ID and real delegated operator
  O3 origins:
    - Adminer/Manticore SSO reaches target service
    - VPN subscription URL/QR is stable and valid
    - STREAM export works initially and on repeat without master-origin confusion
    - deploy webhook and other public routes work without master ADMIN JWT
    - SSH and Panel Access use selected target metadata
  O4 resilience:
    - explicit proxy ready/degraded/reconnecting states
    - WS reconnect restores subscriptions/listeners
    - timeout cannot report failure while mutation continues without a recoverable operation status
  O5 compatibility:
    - manifest exposes protocol and feature capabilities
    - old, current, newer, offline, and partially configured remotes have deterministic UX
  O6 transfers:
    - large downloads avoid browser Blob and master bottlenecks
    - uploads are streamed or use target-signed direct transfer with bounded resource use
  O7 navigation_control_plane:
    - server switch never reuses an entity ID from previous server
    - fleet tags, update targets, main node actions, nested fleet scope, palette, migration, and Basic Auth ownership are explicit

constraints:
  C1: current VPS is production plus source dev-mode; preserve /opt/meowbox/.dev-mode and never run make update here.
  C2: preserve unrelated dirty worktree changes, especially System Overview dashboard work.
  C3: persistent data remains under /opt/meowbox/state; never write it into releases/current.
  C4: schema changes require Prisma migration; never prisma db push.
  C5: nginx/php-fpm/logrotate/cron/systemd templates, new env, filesystem layout, or OS-state changes require idempotent system migration and regeneration where applicable.
  C6: before release, bump VERSION; delivery uses tag/workflow/release process, not direct production edits.
  C7: do not expose tokens, passwords, signed URLs, request bodies, or private data in logs/audit/metrics.
  C8: preserve SSRF protection; any private-network support requires an explicit trusted-network policy, not a blanket bypass.

acceptance:
  A1: feature-action matrix covers all 34 current pages plus shared composables/components and every API/WS/public transport.
  A2: same operator, role, ownership, audit identity, and result are observed on master and selected remote.
  A3: logout/login/setup always work with persisted offline remote selection.
  A4: Adminer, VPN subscription, STREAM export, deploy webhook, SSH, Panel Access, and entity switching pass remote E2E tests.
  A5: WS target restart recovers without page reload and without privilege escalation.
  A6: slow mutations expose durable status; retries are idempotent; continuous large streams are not killed by a total 30/600 second timer.
  A7: current Dashboard remote and legacy fallback contracts remain green.
  A8: rollout and rollback work across mixed fleet versions without losing access.

open_questions:
  Q1: delegated_principal storage = shadow User rows or a new polymorphic Principal model?
  Q2: delegation trust = Ed25519 signing, per-server HMAC, mTLS, or layered combination?
  Q3: Adminer/public browser access = master reverse gateway or direct target origin?
  Q4: VPN subscription ownership and aggregation = panel operator, VPN user, tenant, or explicit subscription entity?
  Q5: private RFC1918/CGNAT/ULA remotes remain unsupported or gain explicit trusted-network enrollment?
  Q6: should remote Panel Access and Basic Auth remain direct-origin settings, and how must UI label them?
  Q7: does fleet update ever include main, or must main update remain a separate workflow?
  Q8: minimum supported legacy proxy protocol and deprecation window?
