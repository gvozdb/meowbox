# Federated VPN subscription recovery

Read [remote-panel-common.md](remote-panel-common.md) first.

## Model

The master owns the stable opaque subscription token and ordered source list. Each target owns VPN credentials. Default membership is the selected target only; aggregation is explicit.

Inspect through the authenticated VPN page and master API. Validate source order, server/user binding, fragment epoch/expiry, cache age, partial state, and output size. Never log the subscription URL, QR content, credentials, target private metadata, or encrypted fragments.

## Recovery actions

- Add explicit source:

```text
POST /api/servers/vpn-subscriptions/<subscription-id>/sources
{ "serverId": "<server-id>", "vpnUserId": "<vpn-user-id>" }
```

- Reorder sources:

```text
PATCH /api/servers/vpn-subscriptions/<subscription-id>/sources/order
{ "sourceIds": ["<source-id-1>", "<source-id-2>"] }
```

- Remove source: `DELETE /api/servers/vpn-subscriptions/<subscription-id>/sources/<source-id>`.
- Rotate stable public token: `POST /api/servers/vpn-subscriptions/<subscription-id>/rotate`.
- Revoke subscription: `DELETE /api/servers/vpn-subscriptions/<subscription-id>`.

During target outage, cached signed fragments may be used only within the five-minute stale limit. After it expires, omit the failed source or return `503` if no valid source remains. Target credential revocation cannot be claimed immediate while that target is offline; it is bounded by fragment expiry. Master token/source revocation is immediate.

Stop on unexpected source membership/order, non-identical dedupe, stale output beyond policy, internal target metadata, parser/size limit, or public throttling failure.

