import { BadRequestException } from '@nestjs/common';

export const FEDERATION_ROLLOUT_STAGES = [
  'DISABLED',
  'OBSERVE',
  'READ_ONLY',
  'CANARY_5',
  'CANARY_25',
  'BROAD',
] as const;

export type FederationRolloutStage = typeof FEDERATION_ROLLOUT_STAGES[number];

export interface FederationCanaryEvidence {
  observedSeconds: number;
  eligiblePercent: number;
  requests15m: number;
  featureFailurePct: number;
  errorDeltaPoints: number;
  p95DeltaMs: number;
  queueDepth: number;
  queueOldestSeconds: number;
  sqliteBusyPct: number;
  leaseP95Ms: number;
  leaseReclaimPct: number;
  nonRetrySafeReclaims: number;
  wsAttempts10m: number;
  wsReadyFailurePct: number;
  wsReconnectsMax: number;
  adminerLaunches: number;
  adminerFailurePct: number;
  transferAttempts: number;
  transferFailurePct: number;
  checksumMismatches: number;
  rssDeltaMiB: number;
  webhookBacklog: number;
  webhookOldestSeconds: number;
  securityStops: number;
}

export interface FederationRolloutRequest {
  stage: FederationRolloutStage;
  expectedRegistryGeneration: number;
  reason: string;
  httpEnabled?: boolean;
  wsEnabled?: boolean;
  publicEnabled?: boolean;
  evidence?: FederationCanaryEvidence;
}

export interface FederationCanaryDecision {
  stopReasons: readonly string[];
  insufficientReasons: readonly string[];
  promotionReady: boolean;
}

const REQUEST_KEYS = new Set([
  'stage',
  'expectedRegistryGeneration',
  'reason',
  'httpEnabled',
  'wsEnabled',
  'publicEnabled',
  'evidence',
]);

const EVIDENCE_RANGES: Readonly<Record<keyof FederationCanaryEvidence, readonly [number, number]>> = {
  observedSeconds: [0, 31_536_000],
  eligiblePercent: [0, 100],
  requests15m: [0, 100_000_000],
  featureFailurePct: [0, 100],
  errorDeltaPoints: [-100, 100],
  p95DeltaMs: [-60_000, 600_000],
  queueDepth: [0, 1_000_000],
  queueOldestSeconds: [0, 31_536_000],
  sqliteBusyPct: [0, 100],
  leaseP95Ms: [0, 600_000],
  leaseReclaimPct: [0, 100],
  nonRetrySafeReclaims: [0, 1_000_000],
  wsAttempts10m: [0, 100_000_000],
  wsReadyFailurePct: [0, 100],
  wsReconnectsMax: [0, 1_000_000],
  adminerLaunches: [0, 100_000_000],
  adminerFailurePct: [0, 100],
  transferAttempts: [0, 100_000_000],
  transferFailurePct: [0, 100],
  checksumMismatches: [0, 1_000_000],
  rssDeltaMiB: [-1_048_576, 1_048_576],
  webhookBacklog: [0, 1_000_000],
  webhookOldestSeconds: [0, 31_536_000],
  securityStops: [0, 1_000_000],
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEvidence(value: unknown): FederationCanaryEvidence {
  if (!isObject(value)) throw new BadRequestException('evidence must be an object');
  const expectedKeys = Object.keys(EVIDENCE_RANGES).sort();
  if (Object.keys(value).sort().join(',') !== expectedKeys.join(',')) {
    throw new BadRequestException('evidence fields are incomplete or unknown');
  }
  const parsed = {} as Record<keyof FederationCanaryEvidence, number>;
  for (const key of expectedKeys as (keyof FederationCanaryEvidence)[]) {
    const candidate = value[key];
    const [minimum, maximum] = EVIDENCE_RANGES[key];
    if (
      typeof candidate !== 'number' ||
      !Number.isFinite(candidate) ||
      candidate < minimum ||
      candidate > maximum
    ) throw new BadRequestException(`evidence.${key} is out of range`);
    parsed[key] = candidate;
  }
  return parsed;
}

export function parseFederationRolloutRequest(value: unknown): FederationRolloutRequest {
  if (!isObject(value)) throw new BadRequestException('rollout request must be an object');
  if (Object.keys(value).some((key) => !REQUEST_KEYS.has(key))) {
    throw new BadRequestException('rollout request contains unknown fields');
  }
  if (!(FEDERATION_ROLLOUT_STAGES as readonly unknown[]).includes(value.stage)) {
    throw new BadRequestException('stage is invalid');
  }
  if (
    typeof value.expectedRegistryGeneration !== 'number' ||
    !Number.isSafeInteger(value.expectedRegistryGeneration) ||
    value.expectedRegistryGeneration < 1
  ) throw new BadRequestException('expectedRegistryGeneration is invalid');
  if (
    typeof value.reason !== 'string' ||
    value.reason.trim().length < 8 ||
    value.reason.trim().length > 512 ||
    /[\x00-\x1f\x7f]/.test(value.reason)
  ) throw new BadRequestException('reason must be 8-512 printable characters');
  for (const key of ['httpEnabled', 'wsEnabled', 'publicEnabled'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') {
      throw new BadRequestException(`${key} must be boolean`);
    }
  }
  const httpEnabled = value.httpEnabled as boolean | undefined;
  const wsEnabled = value.wsEnabled as boolean | undefined;
  const publicEnabled = value.publicEnabled as boolean | undefined;
  return {
    stage: value.stage as FederationRolloutStage,
    expectedRegistryGeneration: value.expectedRegistryGeneration,
    reason: value.reason.trim(),
    ...(httpEnabled === undefined ? {} : { httpEnabled }),
    ...(wsEnabled === undefined ? {} : { wsEnabled }),
    ...(publicEnabled === undefined ? {} : { publicEnabled }),
    ...(value.evidence === undefined ? {} : { evidence: parseEvidence(value.evidence) }),
  };
}

export function evaluateFederationCanary(
  evidence: FederationCanaryEvidence,
  targetStage: FederationRolloutStage,
): FederationCanaryDecision {
  const stopReasons: string[] = [];
  const insufficientReasons: string[] = [];
  if (evidence.securityStops > 0) stopReasons.push('SECURITY_STOP');
  if (
    evidence.requests15m >= 200 &&
    (evidence.featureFailurePct > 0.5 || evidence.errorDeltaPoints > 2 || evidence.p95DeltaMs > 100)
  ) stopReasons.push('HTTP_REGRESSION');
  if (evidence.queueDepth >= 102 || evidence.queueOldestSeconds > 120) stopReasons.push('OPERATION_QUEUE');
  if (evidence.sqliteBusyPct > 1 || evidence.leaseP95Ms > 100) stopReasons.push('SQLITE_LEASE');
  if (evidence.leaseReclaimPct > 0.5 || evidence.nonRetrySafeReclaims > 0) stopReasons.push('UNSAFE_RECLAIM');
  if (
    (evidence.wsAttempts10m >= 100 && evidence.wsReadyFailurePct > 1) ||
    evidence.wsReconnectsMax > 5
  ) stopReasons.push('WS_READINESS');
  if (evidence.adminerLaunches >= 50 && evidence.adminerFailurePct > 1) stopReasons.push('ADMINER_FAILURE');
  if (
    (evidence.transferAttempts >= 50 && evidence.transferFailurePct > 1) ||
    evidence.checksumMismatches > 0 ||
    evidence.rssDeltaMiB > 128
  ) stopReasons.push('TRANSFER_FAILURE');
  if (evidence.webhookBacklog >= 800 || evidence.webhookOldestSeconds > 300) stopReasons.push('WEBHOOK_BACKLOG');

  const needsPromotionEvidence = targetStage === 'CANARY_25' || targetStage === 'BROAD';
  if (needsPromotionEvidence && evidence.observedSeconds < 86_400) {
    insufficientReasons.push('OBSERVATION_WINDOW_LT_24H');
  }
  if (needsPromotionEvidence && evidence.requests15m < 200) {
    insufficientReasons.push('HTTP_SAMPLE_LT_200');
  }
  if (targetStage === 'CANARY_5' && evidence.eligiblePercent > 5) {
    stopReasons.push('CANARY_VOLUME_GT_5');
  }
  if (targetStage === 'CANARY_25' && evidence.eligiblePercent > 25) {
    stopReasons.push('CANARY_VOLUME_GT_25');
  }
  return {
    stopReasons,
    insufficientReasons,
    promotionReady: stopReasons.length === 0 && insufficientReasons.length === 0,
  };
}

export function rolloutStageIndex(stage: FederationRolloutStage): number {
  return FEDERATION_ROLLOUT_STAGES.indexOf(stage);
}
