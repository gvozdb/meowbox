'use strict';

function healthyFederationRolloutEvidence(overrides = {}) {
  return {
    observedSeconds: 86_400,
    eligiblePercent: 5,
    requests15m: 200,
    featureFailurePct: 0.5,
    errorDeltaPoints: 2,
    p95DeltaMs: 100,
    queueDepth: 101,
    queueOldestSeconds: 120,
    sqliteBusyPct: 1,
    leaseP95Ms: 100,
    leaseReclaimPct: 0.5,
    nonRetrySafeReclaims: 0,
    wsAttempts10m: 100,
    wsReadyFailurePct: 1,
    wsReconnectsMax: 5,
    adminerLaunches: 50,
    adminerFailurePct: 1,
    transferAttempts: 50,
    transferFailurePct: 1,
    checksumMismatches: 0,
    rssDeltaMiB: 128,
    webhookBacklog: 799,
    webhookOldestSeconds: 300,
    securityStops: 0,
    ...overrides,
  };
}

module.exports = { healthyFederationRolloutEvidence };

