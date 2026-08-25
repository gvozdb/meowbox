# Remote panel topology policy

Protocol 1 is public-origin only.

Accepted target control origin is exactly `https://host[:port]` with no credentials, path, query, or fragment. API, WS, browser-public, and direct-transfer origins are normalized separately but enrollment currently requires one public target origin. SSH host/port remain separate.

At every connection:

- validate all A/AAAA answers;
- reject loopback, RFC1918/private, CGNAT, link-local, multicast, unspecified, and metadata ranges;
- dial one validated address without a second resolver lookup;
- retain hostname for SNI and hostname verification;
- require normal CA validation plus enrolled SPKI/private-CA pin;
- require IP SAN plus pin for literal-IP origins;
- reject redirects.

Master reachability does not prove browser reachability. Adminer/Manticore, MODX handoff, native download, upload, and WS use separate per-session/per-surface browser probes.

`TRUSTED_PRIVATE` may be stored but remains `POLICY_BLOCKED`. Do not weaken SSRF/TLS policy to make it work. Private/VPN activation requires a separate approved fixture and policy.

Direct-only surfaces are unavailable when the browser cannot reach the target. Adminer is never gatewayed through the master. Transfers may use the bounded <=100 MiB master fallback; larger delivery needs target/VPN reachability or external storage.

