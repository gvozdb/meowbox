'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  evaluateFederationCanary,
  parseFederationRolloutRequest,
} = require('../src/federation/federation-rollout-policy');
const { healthyFederationRolloutEvidence: healthyEvidence } = require('./helpers/federation-rollout-evidence');

test('T-CAN-001 strict parser rejects incomplete, unknown, and out-of-range evidence', () => {
  const base = {
    stage: 'CANARY_5',
    expectedRegistryGeneration: 7,
    reason: 'Promote isolated target after verified observation',
    evidence: healthyEvidence(),
  };
  assert.deepEqual(parseFederationRolloutRequest(base), base);
  assert.throws(
    () => parseFederationRolloutRequest({ ...base, unknown: true }),
    /unknown fields/i,
  );
  const { queueDepth, ...incomplete } = healthyEvidence();
  assert.throws(
    () => parseFederationRolloutRequest({ ...base, evidence: incomplete }),
    /incomplete or unknown/i,
  );
  assert.throws(
    () => parseFederationRolloutRequest({ ...base, evidence: healthyEvidence({ queueDepth: -1 }) }),
    /out of range/i,
  );
});

test('T-CAN-001 exact rolling thresholds pass at boundary and stop above it', () => {
  assert.deepEqual(evaluateFederationCanary(healthyEvidence(), 'CANARY_25'), {
    stopReasons: [],
    insufficientReasons: [],
    promotionReady: true,
  });
  const decision = evaluateFederationCanary(healthyEvidence({
    featureFailurePct: 0.5001,
    queueDepth: 102,
    sqliteBusyPct: 1.0001,
    leaseReclaimPct: 0.5001,
    wsReconnectsMax: 6,
    adminerFailurePct: 1.0001,
    transferFailurePct: 1.0001,
    webhookBacklog: 800,
  }), 'CANARY_25');
  assert.deepEqual(decision.stopReasons, [
    'HTTP_REGRESSION',
    'OPERATION_QUEUE',
    'SQLITE_LEASE',
    'UNSAFE_RECLAIM',
    'WS_READINESS',
    'ADMINER_FAILURE',
    'TRANSFER_FAILURE',
    'WEBHOOK_BACKLOG',
  ]);
  assert.equal(decision.promotionReady, false);
});

test('T-CAN-001 promotion requires 24 hours and HTTP sample while emergency signals always stop', () => {
  const insufficient = evaluateFederationCanary(healthyEvidence({
    observedSeconds: 86_399,
    requests15m: 199,
  }), 'BROAD');
  assert.deepEqual(insufficient.insufficientReasons, [
    'OBSERVATION_WINDOW_LT_24H',
    'HTTP_SAMPLE_LT_200',
  ]);
  assert.equal(insufficient.promotionReady, false);

  assert.deepEqual(
    evaluateFederationCanary(healthyEvidence({ securityStops: 1 }), 'CANARY_5').stopReasons,
    ['SECURITY_STOP'],
  );
  assert.deepEqual(
    evaluateFederationCanary(healthyEvidence({ checksumMismatches: 1 }), 'CANARY_5').stopReasons,
    ['TRANSFER_FAILURE'],
  );
});
