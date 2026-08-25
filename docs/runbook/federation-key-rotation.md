# Federation key rotation and compromise recovery

Read [remote-panel-common.md](remote-panel-common.md) first.

## Routine relationship-key rotation

Prerequisites: target trust and HTTP federation are active, the target advertises all `federation/v1/trust/*` actions, clocks are synchronized, and no previous rotation is unresolved.

As master ADMIN, use a unique printable `Idempotency-Key`:

```text
POST /api/servers/<server-id>/federation-keys/rotate
Idempotency-Key: <8-128 printable characters>
{ "graceSeconds": 3600 }
```

The master creates a pending Ed25519 key, sends only its public key in a request signed by the previous key, reconciles a lost response through signed target key status, then activates the private key locally. The target stores no relationship private key. Grace is 60–86400 seconds and contains at most two usable keys.

Verify:

- response `activeKid` differs from `previousKid`;
- `graceUntil` is bounded;
- subsequent OUT/IN audit uses the new key ID;
- old-key traffic is rejected after grace;
- WS channels reconnect under a fresh assertion/epoch.

Do not repeat with a different idempotency key while a pending key exists. Retry the original request so status reconciliation can complete.

## Immediate compromise revocation

```text
POST /api/servers/<server-id>/federation-keys/revoke
Idempotency-Key: <8-128 printable characters>
```

The master attempts signed target revocation, then always revokes local issuer/key state and disables HTTP, WS, public delivery, legacy fallback, and rollout. `targetConfirmed=false` means the target was unreachable; local revocation is still complete.

After compromise:

1. close active browser/WS sessions for the target;
2. invalidate Adminer, VPN, webhook, and transfer grants bound to the relationship;
3. preserve correlated audit and replay evidence;
4. repair the target out of band;
5. re-enroll with verified SSH and SPKI fingerprints;
6. remain `DISABLED` until all trust and activation gates pass again.

Never add grace to a compromised key. Never repair trust with direct DB edits or by copying key material.

## Target manifest-key compromise

Disable the relationship immediately. Replace the target manifest key only through the target’s release/bootstrap recovery path, verify its fingerprint out of band, and re-enroll. The master must never silently repin a changed manifest key.

