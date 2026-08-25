import {
  isContractRecord,
  requireBoolean,
  requireEnum,
  requireExactKeys,
  requireInteger,
  requireIsoDate,
  requireString,
  requireUniqueStrings,
} from './contract-validation';

export const OPERATION_STATES = [
  'PENDING',
  'QUEUED',
  'CLAIMED',
  'RUNNING',
  'RECOVERING',
  'CANCEL_REQUESTED',
  'CANCELLED',
  'SUCCEEDED',
  'FAILED',
  'UNKNOWN_RECOVERY_REQUIRED',
  'NEEDS_ATTENTION',
] as const;
export type FederatedOperationState = (typeof OPERATION_STATES)[number];

export const OPERATION_RECOVERY_POLICIES = [
  'RETRY_SAFE',
  'RECONCILE_ONLY',
  'MANUAL',
] as const;
export type OperationRecoveryPolicy = (typeof OPERATION_RECOVERY_POLICIES)[number];

export const OPERATION_CANCEL_OUTCOMES = [
  'NOT_REQUESTED',
  'PENDING',
  'CANCELLED',
  'TOO_LATE',
  'UNSAFE',
  'FAILED',
] as const;
export type OperationCancelOutcome = (typeof OPERATION_CANCEL_OUTCOMES)[number];

export interface OperationPolicySnapshot {
  actionId: string;
  schemaVersion: number;
  actorKind: 'OPERATOR' | 'SERVICE';
  issuerId: string;
  subject: string;
  role: 'ADMIN' | 'MANAGER' | 'VIEWER' | 'SERVICE';
  permissions: readonly string[];
  idempotencyId: string;
  requestId: string;
  recoveryPolicy: OperationRecoveryPolicy;
  retryable: boolean;
}

export interface FederatedOperationEnvelope {
  operationId: string;
  targetInstallationId: string;
  state: FederatedOperationState;
  progress: number;
  attempt: number;
  policy: OperationPolicySnapshot;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  deadlineAt: string;
  cancelRequestedAt: string | null;
  cancelOutcome: OperationCancelOutcome;
  result: {
    inlineJson: string | null;
    artifactId: string | null;
  };
  error: {
    code: string;
    message: string;
    retryable: boolean;
  } | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface OperationAcceptedEnvelope {
  operationId: string;
  requestId: string;
  state: 'PENDING' | 'QUEUED';
  statusPath: string;
  retryAfterSeconds: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTION_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9_-]+)+$/;
const PERMISSION = /^[a-z][a-z0-9]*(?:[.:_-][a-z0-9]+)*$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,127}$/;

export function isTerminalOperationState(state: FederatedOperationState): boolean {
  return ['CANCELLED', 'SUCCEEDED', 'FAILED', 'UNKNOWN_RECOVERY_REQUIRED', 'NEEDS_ATTENTION'].includes(state);
}

const TRANSITIONS: Readonly<Record<FederatedOperationState, ReadonlySet<FederatedOperationState>>> = {
  PENDING: new Set(['QUEUED', 'CANCELLED', 'FAILED']),
  QUEUED: new Set(['CLAIMED', 'CANCELLED', 'FAILED']),
  CLAIMED: new Set(['RUNNING', 'RECOVERING', 'QUEUED', 'FAILED', 'NEEDS_ATTENTION']),
  RUNNING: new Set(['CANCEL_REQUESTED', 'SUCCEEDED', 'FAILED', 'RECOVERING', 'UNKNOWN_RECOVERY_REQUIRED', 'NEEDS_ATTENTION']),
  RECOVERING: new Set(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN_RECOVERY_REQUIRED', 'NEEDS_ATTENTION']),
  CANCEL_REQUESTED: new Set(['CANCELLED', 'RUNNING', 'FAILED', 'NEEDS_ATTENTION']),
  CANCELLED: new Set(),
  SUCCEEDED: new Set(),
  FAILED: new Set(),
  UNKNOWN_RECOVERY_REQUIRED: new Set(['NEEDS_ATTENTION', 'SUCCEEDED', 'FAILED']),
  NEEDS_ATTENTION: new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']),
};

export function assertOperationTransition(
  from: FederatedOperationState,
  to: FederatedOperationState,
): void {
  if (!TRANSITIONS[from]?.has(to)) {
    throw new Error(`Operation transition ${from} -> ${to} is not allowed`);
  }
}

function validatePolicy(value: unknown): void {
  if (!isContractRecord(value)) throw new Error('operation.policy is invalid');
  requireExactKeys(value, [
    'actionId', 'schemaVersion', 'actorKind', 'issuerId', 'subject', 'role',
    'permissions', 'idempotencyId', 'requestId', 'recoveryPolicy', 'retryable',
  ], [], 'operation.policy');
  requireString(value.actionId, 'operation.policy.actionId', { pattern: ACTION_ID });
  requireInteger(value.schemaVersion, 'operation.policy.schemaVersion', 1, 1000);
  requireEnum(value.actorKind, ['OPERATOR', 'SERVICE'] as const, 'operation.policy.actorKind');
  requireString(value.issuerId, 'operation.policy.issuerId', { pattern: UUID });
  requireString(value.subject, 'operation.policy.subject', { max: 128, pattern: /^[\x21-\x7e]+$/ });
  const role = requireEnum(value.role, ['ADMIN', 'MANAGER', 'VIEWER', 'SERVICE'] as const, 'operation.policy.role');
  if ((value.actorKind === 'SERVICE') !== (role === 'SERVICE')) {
    throw new Error('operation.policy actor/role mismatch');
  }
  requireUniqueStrings(value.permissions, 'operation.policy.permissions', { maxItems: 64, pattern: PERMISSION });
  requireString(value.idempotencyId, 'operation.policy.idempotencyId', { min: 8, max: 128, pattern: /^[\x21-\x7e]+$/ });
  requireString(value.requestId, 'operation.policy.requestId', { pattern: UUID });
  requireEnum(value.recoveryPolicy, OPERATION_RECOVERY_POLICIES, 'operation.policy.recoveryPolicy');
  requireBoolean(value.retryable, 'operation.policy.retryable');
  if (value.recoveryPolicy !== 'RETRY_SAFE' && value.retryable === true) {
    throw new Error('Only RETRY_SAFE operations may be retryable');
  }
}

export function validateFederatedOperation(value: unknown): FederatedOperationEnvelope {
  if (!isContractRecord(value)) throw new Error('FederatedOperation is invalid');
  requireExactKeys(value, [
    'operationId', 'targetInstallationId', 'state', 'progress', 'attempt', 'policy',
    'leaseOwner', 'leaseExpiresAt', 'heartbeatAt', 'deadlineAt', 'cancelRequestedAt',
    'cancelOutcome', 'result', 'error', 'createdAt', 'updatedAt', 'completedAt',
  ], [], 'operation');
  requireString(value.operationId, 'operation.operationId', { pattern: UUID });
  requireString(value.targetInstallationId, 'operation.targetInstallationId', { pattern: UUID });
  const state = requireEnum(value.state, OPERATION_STATES, 'operation.state');
  requireInteger(value.progress, 'operation.progress', 0, 100);
  requireInteger(value.attempt, 'operation.attempt', 0, 100);
  validatePolicy(value.policy);
  if (value.leaseOwner !== null) requireString(value.leaseOwner, 'operation.leaseOwner', { max: 128 });
  if (value.leaseExpiresAt !== null) requireIsoDate(value.leaseExpiresAt, 'operation.leaseExpiresAt');
  if (value.heartbeatAt !== null) requireIsoDate(value.heartbeatAt, 'operation.heartbeatAt');
  requireIsoDate(value.deadlineAt, 'operation.deadlineAt');
  if (value.cancelRequestedAt !== null) requireIsoDate(value.cancelRequestedAt, 'operation.cancelRequestedAt');
  requireEnum(value.cancelOutcome, OPERATION_CANCEL_OUTCOMES, 'operation.cancelOutcome');

  if (!isContractRecord(value.result)) throw new Error('operation.result is invalid');
  requireExactKeys(value.result, ['inlineJson', 'artifactId'], [], 'operation.result');
  if (value.result.inlineJson !== null) {
    const inline = requireString(value.result.inlineJson, 'operation.result.inlineJson', { min: 0, max: 1_048_576 });
    try { JSON.parse(inline); } catch { throw new Error('operation.result.inlineJson is invalid JSON'); }
  }
  if (value.result.artifactId !== null) {
    requireString(value.result.artifactId, 'operation.result.artifactId', { pattern: UUID });
  }
  if (value.result.inlineJson !== null && value.result.artifactId !== null) {
    throw new Error('operation result must be inline or artifact, not both');
  }

  if (value.error !== null) {
    if (!isContractRecord(value.error)) throw new Error('operation.error is invalid');
    requireExactKeys(value.error, ['code', 'message', 'retryable'], [], 'operation.error');
    requireString(value.error.code, 'operation.error.code', { pattern: SAFE_CODE });
    requireString(value.error.message, 'operation.error.message', { max: 2048 });
    requireBoolean(value.error.retryable, 'operation.error.retryable');
  }
  requireIsoDate(value.createdAt, 'operation.createdAt');
  requireIsoDate(value.updatedAt, 'operation.updatedAt');
  if (value.completedAt !== null) requireIsoDate(value.completedAt, 'operation.completedAt');
  if (isTerminalOperationState(state) !== (value.completedAt !== null)) {
    throw new Error('operation terminal state/completedAt mismatch');
  }
  return value as unknown as FederatedOperationEnvelope;
}

export function validateOperationAccepted(value: unknown): OperationAcceptedEnvelope {
  if (!isContractRecord(value)) throw new Error('OperationAccepted is invalid');
  requireExactKeys(value, ['operationId', 'requestId', 'state', 'statusPath', 'retryAfterSeconds'], [], 'operationAccepted');
  requireString(value.operationId, 'operationAccepted.operationId', { pattern: UUID });
  requireString(value.requestId, 'operationAccepted.requestId', { pattern: UUID });
  requireEnum(value.state, ['PENDING', 'QUEUED'] as const, 'operationAccepted.state');
  requireString(value.statusPath, 'operationAccepted.statusPath', { pattern: /^\/api\/operations\/[0-9a-f-]{36}$/ });
  requireInteger(value.retryAfterSeconds, 'operationAccepted.retryAfterSeconds', 1, 60);
  return value as unknown as OperationAcceptedEnvelope;
}

