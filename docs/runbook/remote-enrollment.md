# Remote enrollment

Read [remote-panel-common.md](remote-panel-common.md) first.

## Prerequisites

- Master registry authority is `DB`, not `JSON` or `FROZEN`.
- Target runs the federation-capable release with protocol mode disabled or observe.
- Target public origin has normal CA-valid TLS and the enrolled SPKI fingerprint.
- SSH hostname, port, and host-key fingerprint are independently verified out of band.
- API, WS, browser, and transfer origins normalize to the same protocol-1 public origin.
- No active or pending server uses the requested display name or installation ID.

## Create and resume

Create from the master as ADMIN:

```text
POST /api/servers/enrollments
{
  "displayName": "edge-eu-1",
  "sshHost": "edge-eu-1.example.net",
  "sshPort": 22,
  "sshFingerprint": "SHA256:<verified-host-key-fingerprint>",
  "apiOrigin": "https://edge-eu-1.example.net",
  "wsOrigin": "https://edge-eu-1.example.net",
  "wsPath": "/socket.io",
  "browserPublicOrigin": "https://edge-eu-1.example.net",
  "directTransferOrigin": "https://edge-eu-1.example.net",
  "spkiSha256": "sha256/<verified-spki-pin>",
  "maxRole": "ADMIN"
}
```

The create call stores no SSH password. Resume supplies it once to the bounded SSH workflow:

```text
POST /api/servers/enrollments/<enrollment-id>/resume
{ "sshPassword": "<supply through the authenticated UI; never log>" }
```

Poll:

```text
GET /api/servers/enrollments/<enrollment-id>
```

Success requires `COMPLETED` only after SSH verification, target identity, target trust, signed manifest verification, endpoint pin/probe, and atomic registry commit. A failed attempt remains resumable and must not create an active remote row.

## Failure and recovery

- Fingerprint mismatch: stop. Re-verify the host out of band; never accept the observed replacement automatically.
- Existing env/custom ports: inspect the sanitized enrollment state, correct the target config through the normal release workflow, then resume.
- Manifest/key/endpoint mismatch: cancel the pending enrollment and investigate the target. Do not downgrade to static bearer auth.
- Lost response: poll the same enrollment ID. Do not create a second enrollment.
- Pending attempt no longer wanted:

```text
POST /api/servers/enrollments/<enrollment-id>/cancel
```

Completed relationships use the key revocation lifecycle, not enrollment cancellation.

## Exit checks

```text
GET /api/servers/<server-id>/context
GET /api/servers/<server-id>/federation-rollout
```

Expected initial state: `DISABLED`, all federation transports killed, `legacy=false`, signed context present. Enrollment never activates traffic.

