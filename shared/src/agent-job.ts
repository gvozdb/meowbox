import {
  isContractRecord,
  requireBoolean,
  requireEnum,
  requireExactKeys,
  requireInteger,
  requireIsoDate,
  requireString,
} from './contract-validation';

export const AGENT_JOB_PROTOCOL_VERSION = 1;
export const AGENT_JOB_EVENTS = {
  START: 'job:start',
  STARTED: 'job:started',
  HEARTBEAT: 'job:heartbeat',
  STATUS: 'job:status',
  RESULT: 'job:result',
  CANCEL: 'job:cancel',
} as const;

export const AGENT_JOB_STATES = [
  'STARTING',
  'RUNNING',
  'CANCEL_REQUESTED',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'NEEDS_ATTENTION',
] as const;

export type AgentJobState = (typeof AGENT_JOB_STATES)[number];

export interface AgentJobStartRequest {
  protocolVersion: 1;
  jobId: string;
  operationId: string;
  actionId: string;
  step: string;
  requestHash: string;
  deadlineAt: string;
  cancelSafe: boolean;
  payload: unknown;
}

export interface AgentJobStarted {
  success: boolean;
  jobId: string;
  operationId: string;
  bootId: string;
  state: AgentJobState;
  replayed: boolean;
  error: string | null;
}

export interface AgentJobHeartbeat {
  jobId: string;
  operationId: string;
  bootId: string;
  sequence: number;
  progress: number;
  step: string;
  timestamp: string;
}

export interface AgentJobResult {
  jobId: string;
  operationId: string;
  bootId: string;
  sequence: number;
  success: boolean;
  cancelled: boolean;
  result: unknown;
  error: string | null;
  timestamp: string;
}

export interface AgentJobStatusRequest {
  jobId: string;
  operationId: string;
}

export interface AgentJobStatus {
  success: boolean;
  jobId: string;
  operationId: string;
  bootId: string;
  state: AgentJobState;
  sequence: number;
  progress: number;
  step: string;
  result: unknown;
  error: string | null;
}

export interface AgentJobCancelRequest extends AgentJobStatusRequest {}

export interface AgentJobCancelResult {
  success: boolean;
  jobId: string;
  operationId: string;
  state: AgentJobState;
  outcome: 'REQUESTED' | 'ALREADY_TERMINAL' | 'NOT_CANCELLABLE' | 'NOT_FOUND';
  error: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTION_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9_-]+)+$/;
const STEP = /^[a-z][a-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_PAYLOAD_BYTES = 1024 * 1024;

function requireJsonSize(value: unknown, label: string, maxBytes = MAX_PAYLOAD_BYTES): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`${label} is not JSON-serializable`);
  }
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes`);
  }
}

function validateIdentity(value: Record<string, unknown>, label: string): void {
  requireString(value.jobId, `${label}.jobId`, { pattern: UUID });
  requireString(value.operationId, `${label}.operationId`, { pattern: UUID });
}

export function validateAgentJobStart(value: unknown): AgentJobStartRequest {
  if (!isContractRecord(value)) throw new Error('agentJobStart is invalid');
  requireExactKeys(value, [
    'protocolVersion', 'jobId', 'operationId', 'actionId', 'step',
    'requestHash', 'deadlineAt', 'cancelSafe', 'payload',
  ], [], 'agentJobStart');
  requireInteger(value.protocolVersion, 'agentJobStart.protocolVersion', 1, 1);
  validateIdentity(value, 'agentJobStart');
  requireString(value.actionId, 'agentJobStart.actionId', { max: 192, pattern: ACTION_ID });
  requireString(value.step, 'agentJobStart.step', { max: 128, pattern: STEP });
  requireString(value.requestHash, 'agentJobStart.requestHash', { pattern: SHA256 });
  requireIsoDate(value.deadlineAt, 'agentJobStart.deadlineAt');
  requireBoolean(value.cancelSafe, 'agentJobStart.cancelSafe');
  requireJsonSize(value.payload, 'agentJobStart.payload');
  return value as unknown as AgentJobStartRequest;
}

export function validateAgentJobHeartbeat(value: unknown): AgentJobHeartbeat {
  if (!isContractRecord(value)) throw new Error('agentJobHeartbeat is invalid');
  requireExactKeys(value, [
    'jobId', 'operationId', 'bootId', 'sequence', 'progress', 'step', 'timestamp',
  ], [], 'agentJobHeartbeat');
  validateIdentity(value, 'agentJobHeartbeat');
  requireString(value.bootId, 'agentJobHeartbeat.bootId', { pattern: UUID });
  requireInteger(value.sequence, 'agentJobHeartbeat.sequence', 1);
  requireInteger(value.progress, 'agentJobHeartbeat.progress', 0, 100);
  requireString(value.step, 'agentJobHeartbeat.step', { max: 128, pattern: STEP });
  requireIsoDate(value.timestamp, 'agentJobHeartbeat.timestamp');
  return value as unknown as AgentJobHeartbeat;
}

export function validateAgentJobStarted(value: unknown): AgentJobStarted {
  if (!isContractRecord(value)) throw new Error('agentJobStarted is invalid');
  requireExactKeys(value, [
    'success', 'jobId', 'operationId', 'bootId', 'state', 'replayed', 'error',
  ], [], 'agentJobStarted');
  requireBoolean(value.success, 'agentJobStarted.success');
  validateIdentity(value, 'agentJobStarted');
  requireString(value.bootId, 'agentJobStarted.bootId', { pattern: UUID });
  requireEnum(value.state, AGENT_JOB_STATES, 'agentJobStarted.state');
  requireBoolean(value.replayed, 'agentJobStarted.replayed');
  if (value.error !== null) requireString(value.error, 'agentJobStarted.error', { max: 4096 });
  if (value.success === (value.error !== null)) {
    throw new Error('agentJobStarted outcome is inconsistent');
  }
  return value as unknown as AgentJobStarted;
}

export function validateAgentJobResult(value: unknown): AgentJobResult {
  if (!isContractRecord(value)) throw new Error('agentJobResult is invalid');
  requireExactKeys(value, [
    'jobId', 'operationId', 'bootId', 'sequence', 'success', 'cancelled',
    'result', 'error', 'timestamp',
  ], [], 'agentJobResult');
  validateIdentity(value, 'agentJobResult');
  requireString(value.bootId, 'agentJobResult.bootId', { pattern: UUID });
  requireInteger(value.sequence, 'agentJobResult.sequence', 1);
  requireBoolean(value.success, 'agentJobResult.success');
  requireBoolean(value.cancelled, 'agentJobResult.cancelled');
  if (value.error !== null) requireString(value.error, 'agentJobResult.error', { max: 4096 });
  if (value.success && (value.cancelled || value.error !== null)) {
    throw new Error('agentJobResult success flags are inconsistent');
  }
  if (value.cancelled && value.success) throw new Error('agentJobResult cancellation is invalid');
  requireIsoDate(value.timestamp, 'agentJobResult.timestamp');
  requireJsonSize(value.result, 'agentJobResult.result');
  return value as unknown as AgentJobResult;
}

export function validateAgentJobStatusRequest(value: unknown): AgentJobStatusRequest {
  if (!isContractRecord(value)) throw new Error('agentJobStatusRequest is invalid');
  requireExactKeys(value, ['jobId', 'operationId'], [], 'agentJobStatusRequest');
  validateIdentity(value, 'agentJobStatusRequest');
  return value as unknown as AgentJobStatusRequest;
}

export function validateAgentJobStatus(value: unknown): AgentJobStatus {
  if (!isContractRecord(value)) throw new Error('agentJobStatus is invalid');
  requireExactKeys(value, [
    'success', 'jobId', 'operationId', 'bootId', 'state', 'sequence',
    'progress', 'step', 'result', 'error',
  ], [], 'agentJobStatus');
  requireBoolean(value.success, 'agentJobStatus.success');
  validateIdentity(value, 'agentJobStatus');
  requireString(value.bootId, 'agentJobStatus.bootId', { pattern: UUID });
  requireEnum(value.state, AGENT_JOB_STATES, 'agentJobStatus.state');
  requireInteger(value.sequence, 'agentJobStatus.sequence', 0);
  requireInteger(value.progress, 'agentJobStatus.progress', 0, 100);
  requireString(value.step, 'agentJobStatus.step', { max: 128, pattern: STEP });
  if (value.error !== null) requireString(value.error, 'agentJobStatus.error', { max: 4096 });
  requireJsonSize(value.result, 'agentJobStatus.result');
  return value as unknown as AgentJobStatus;
}

export function validateAgentJobCancelResult(value: unknown): AgentJobCancelResult {
  if (!isContractRecord(value)) throw new Error('agentJobCancelResult is invalid');
  requireExactKeys(value, [
    'success', 'jobId', 'operationId', 'state', 'outcome', 'error',
  ], [], 'agentJobCancelResult');
  requireBoolean(value.success, 'agentJobCancelResult.success');
  validateIdentity(value, 'agentJobCancelResult');
  requireEnum(value.state, AGENT_JOB_STATES, 'agentJobCancelResult.state');
  requireEnum(value.outcome, [
    'REQUESTED', 'ALREADY_TERMINAL', 'NOT_CANCELLABLE', 'NOT_FOUND',
  ] as const, 'agentJobCancelResult.outcome');
  if (value.error !== null) requireString(value.error, 'agentJobCancelResult.error', { max: 4096 });
  return value as unknown as AgentJobCancelResult;
}
