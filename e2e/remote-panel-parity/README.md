# RPP-020 disposable fleet fixtures

This directory is the bounded, non-networked foundation for the remote-panel parity fixture work. It describes an isolated master and deterministic target profiles without starting Meowbox, Nginx, PHP-FPM, Socket.IO, Docker, or any other service.

The safety boundary is intentional:

- `MEOWBOX_RPP_FIXTURE_MODE` must be exactly `rpp-020`.
- `MEOWBOX_RPP_NETWORK` must be exactly `disabled`; an explicit network-enable flag is rejected.
- `MEOWBOX_RPP_ROOT` and every derived root must be below the operating-system temporary directory. `/opt/meowbox`, `/opt/meowbox/state`, web roots, Nginx/PHP roots, and other production roots are rejected.
- Origins must use fixture hosts such as `current.rpp.test`, contain no credentials/path/query/fragment, and use an unprivileged port.
- A/AAAA answers come only from a static map or an injected resolver. Every answer is checked; public, metadata, multicast, link-local, CGNAT, unspecified, and configured production addresses fail closed.
- Private answers are accepted only for the `disabled-private` probe, and that profile is marked non-dialable and activation-disabled.
- Configured real panel/target hosts can be supplied as a deny-list and are rejected if used by a fixture.

## Safe invocation

From the repository root, the focused suite is:

```bash
node --test e2e/remote-panel-parity/test/*.test.mjs
```

An explicit environment invocation is also safe. The root is created under `/tmp` and the check still uses only the profile’s static DNS map:

```bash
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/meowbox-rpp-run-XXXXXX")"
MEOWBOX_RPP_FIXTURE_MODE=rpp-020 \
MEOWBOX_RPP_ROOT="$fixture_root" \
MEOWBOX_RPP_NETWORK=disabled \
node e2e/remote-panel-parity/check.mjs
```

The check reads only the named fixture variables, materializes the complete profile set, prints a summary, and removes the exact marker-checked temporary root. Do not point `MEOWBOX_RPP_ROOT` at a checkout, `/opt/meowbox/state`, a site root, or a release directory. Do not add a resolver that calls the ambient network resolver. The factory cleans up roots it created itself; a caller-owned non-empty temporary directory is refused.

## Fixture API

```js
import {
  createDisposableFleet,
  getFixtureProfile,
  createLogicalStreamDescriptor,
} from './index.mjs';

const fleet = await createDisposableFleet({
  profileNames: ['current', 'partial-capability', 'browser-unreachable'],
});

const stream = createLogicalStreamDescriptor(); // logical, bounded 50 GiB
const restarted = fleet.restartService('current', 'api'); // plan-only state transition
await fleet.cleanup();
```

The reserved profiles cover current, legacy, newer-compatible/incompatible, offline, auth-failed, IP-blocked, partial-capability, no-admin/fresh-no-admin, existing environment, custom port, token mismatch, browser reachable/unreachable, public, and the disabled private-topology probe. Each profile has deterministic IDs, ports, origins, static DNS answers, roots, capabilities, service plans, and status probes. `api`, `agent`, and `socketIo` are restartable in the in-memory plan only; no process is launched.

The logical stream helper represents up to 50 GiB as deterministic bounded chunks. It never creates a large file or opens a transfer connection.

## External activation evidence

This source-only foundation is not activation evidence. The following lower-layer contracts must run in an isolated integration fixture and produce a redacted, content-addressed, Ed25519-signed gate report:

- generated Nginx and PHP-FPM configuration, Adminer runtime/cookie interoperability, and local restart/recovery;
- real TLS/SNI/SPKI validation and DNS-rebinding/multi-address dialing probes;
- restartable API, agent, and Socket.IO processes with crash/reconnect behavior;
- generated versus staged transfer behavior, Range/abort/backpressure, disk budgets, and large-stream memory checks;
- a local webhook provider that preserves exact raw bytes, retries, deduplicates, and exercises DLQ behavior;
- a local S3-compatible provider or explicitly bounded fake for presigned/external delivery semantics;
- provisioning, custom-port, token-mismatch, Panel Access, SQLite/WAL recovery, and process ownership fixtures.

Those fixture runs must remain disposable and network-scoped to temporary resources. They must not mutate production state or use real panel/target hosts. Verify each result with `tools/remote-panel-activation-evidence.mjs`; the activation release gate rejects missing, unsigned, stale, tampered, release-mismatched, or unsafe evidence.
