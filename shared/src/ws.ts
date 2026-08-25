import {
  SiteStatus,
  BackupStatus,
  NotificationEvent,
} from './enums';

import type { SystemMetrics } from './entities';
import {
  isContractRecord,
  requireEnum,
  requireExactKeys,
  requireInteger,
  requireIsoDate,
  requireString,
  requireUniqueStrings,
} from './contract-validation';

// =============================================================================
// WebSocket event name constants
// =============================================================================

export const WsEvents = {
  SITE_STATUS: 'site:status',
  SITE_DEPLOY_LOG: 'site:deploy:log',
  SITE_LOGS: 'site:logs',
  SYSTEM_METRICS: 'system:metrics',
  BACKUP_PROGRESS: 'backup:progress',
  TERMINAL_DATA: 'terminal:data',
  NOTIFICATION: 'notification',
} as const;

export type WsEventName = (typeof WsEvents)[keyof typeof WsEvents];

// =============================================================================
// WebSocket event payloads
// =============================================================================

export interface WsSiteStatusPayload {
  siteId: string;
  status: SiteStatus;
  previousStatus: SiteStatus;
  timestamp: string;
}

export interface WsDeployLogPayload {
  siteId: string;
  deployLogId: string;
  line: string;
  stream: 'stdout' | 'stderr';
  timestamp: string;
}

export interface WsSiteLogsPayload {
  siteId: string;
  logType: 'access' | 'error' | 'php' | 'pm2';
  line: string;
  timestamp: string;
}

export interface WsSystemMetricsPayload extends SystemMetrics {}

export interface WsBackupProgressPayload {
  backupId: string;
  siteId: string;
  status: BackupStatus;
  progress: number;
  message: string;
  timestamp: string;
}

export interface WsTerminalDataPayload {
  sessionId: string;
  data: string;
}

export interface WsNotificationPayload {
  id: string;
  event: NotificationEvent;
  title: string;
  message: string;
  siteId: string | null;
  timestamp: string;
}

// =============================================================================
// Typed event map (for type-safe Socket.io usage)
// =============================================================================

export interface ServerToClientEvents {
  [WsEvents.SITE_STATUS]: (payload: WsSiteStatusPayload) => void;
  [WsEvents.SITE_DEPLOY_LOG]: (payload: WsDeployLogPayload) => void;
  [WsEvents.SITE_LOGS]: (payload: WsSiteLogsPayload) => void;
  [WsEvents.SYSTEM_METRICS]: (payload: WsSystemMetricsPayload) => void;
  [WsEvents.BACKUP_PROGRESS]: (payload: WsBackupProgressPayload) => void;
  [WsEvents.TERMINAL_DATA]: (payload: WsTerminalDataPayload) => void;
  [WsEvents.NOTIFICATION]: (payload: WsNotificationPayload) => void;
}

export interface ClientToServerEvents {
  'site:logs:subscribe': (payload: { siteId: string; logType: string }) => void;
  'site:logs:unsubscribe': (payload: { siteId: string }) => void;
  'site:deploy:subscribe': (payload: { siteId: string; deployLogId: string }) => void;
  'site:deploy:unsubscribe': (payload: { siteId: string }) => void;
  'terminal:input': (payload: { sessionId: string; data: string }) => void;
  'terminal:resize': (payload: { sessionId: string; cols: number; rows: number }) => void;
  'terminal:open': (callback: (payload: { sessionId: string }) => void) => void;
  'terminal:close': (payload: { sessionId: string }) => void;
}

// =============================================================================
// Federation protocol v1 envelopes
// =============================================================================

export const FEDERATED_WS_STATES = [
  'MASTER_CONNECTED',
  'TARGET_CONNECTING',
  'READY',
  'DEGRADED',
  'CLOSED',
] as const;
export type FederatedWsState = (typeof FEDERATED_WS_STATES)[number];

export const FEDERATED_WS_MESSAGE_KINDS = [
  'EVENT',
  'ACK',
  'NACK',
  'CANCEL',
  'STATE',
] as const;
export type FederatedWsMessageKind = (typeof FEDERATED_WS_MESSAGE_KINDS)[number];

export interface FederatedWsChannelAssertion {
  channelId: string;
  targetInstallationId: string;
  epoch: number;
  nonce: string;
  actionIds: readonly string[];
  issuedAt: string;
  expiresAt: string;
  assertion: string;
  signature: string;
}

export interface FederatedWsEnvelope<TPayload = unknown> {
  channelId: string;
  epoch: number;
  sequence: number;
  actionId: string;
  correlationId: string;
  event: string;
  kind: FederatedWsMessageKind;
  payload: TPayload;
}

export interface FederatedWsAckPayload<TResult = unknown> {
  acceptedSequence: number;
  outcome: 'ACCEPTED' | 'COMPLETED' | 'REJECTED' | 'CANCELLED';
  code: string | null;
  message: string | null;
  result: TResult | null;
}

export interface FederatedWsStatePayload {
  state: FederatedWsState;
  reasonCode: string;
  readyAt: string | null;
  retryAfterMs: number | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTION_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9_-]+)+$/;
const EVENT = /^[a-z][a-z0-9]*(?::[a-z0-9_-]+)+$/;
const NONCE = /^[A-Za-z0-9_-]{22,64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const MAX_WS_PAYLOAD_BYTES = 256 * 1024;

function payloadByteLength(payload: unknown): number {
  try {
    const encoded = JSON.stringify(payload);
    if (encoded === undefined) throw new Error('undefined');
    return new TextEncoder().encode(encoded).byteLength;
  } catch {
    throw new Error('federated WS payload is not JSON-serializable');
  }
}

export function validateFederatedWsChannelAssertion(
  value: unknown,
): FederatedWsChannelAssertion {
  if (!isContractRecord(value)) throw new Error('FederatedWsChannelAssertion is invalid');
  requireExactKeys(value, [
    'channelId', 'targetInstallationId', 'epoch', 'nonce', 'actionIds',
    'issuedAt', 'expiresAt', 'assertion', 'signature',
  ], [], 'channelAssertion');
  requireString(value.channelId, 'channelAssertion.channelId', { pattern: UUID });
  requireString(value.targetInstallationId, 'channelAssertion.targetInstallationId', { pattern: UUID });
  requireInteger(value.epoch, 'channelAssertion.epoch', 1);
  requireString(value.nonce, 'channelAssertion.nonce', { pattern: NONCE });
  requireUniqueStrings(value.actionIds, 'channelAssertion.actionIds', { maxItems: 128, pattern: ACTION_ID });
  const issuedAt = requireIsoDate(value.issuedAt, 'channelAssertion.issuedAt');
  const expiresAt = requireIsoDate(value.expiresAt, 'channelAssertion.expiresAt');
  const ttl = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (ttl <= 0 || ttl > 60_000) throw new Error('channelAssertion lifetime is invalid');
  requireString(value.assertion, 'channelAssertion.assertion', { max: 16_384, pattern: /^[A-Za-z0-9_-]+$/ });
  requireString(value.signature, 'channelAssertion.signature', { pattern: SIGNATURE });
  return value as unknown as FederatedWsChannelAssertion;
}

export function validateFederatedWsEnvelope<TPayload = unknown>(
  value: unknown,
): FederatedWsEnvelope<TPayload> {
  if (!isContractRecord(value)) throw new Error('FederatedWsEnvelope is invalid');
  requireExactKeys(value, [
    'channelId', 'epoch', 'sequence', 'actionId', 'correlationId', 'event',
    'kind', 'payload',
  ], [], 'wsEnvelope');
  requireString(value.channelId, 'wsEnvelope.channelId', { pattern: UUID });
  requireInteger(value.epoch, 'wsEnvelope.epoch', 1);
  requireInteger(value.sequence, 'wsEnvelope.sequence', 0);
  requireString(value.actionId, 'wsEnvelope.actionId', { pattern: ACTION_ID });
  requireString(value.correlationId, 'wsEnvelope.correlationId', { pattern: UUID });
  requireString(value.event, 'wsEnvelope.event', { pattern: EVENT });
  requireEnum(value.kind, FEDERATED_WS_MESSAGE_KINDS, 'wsEnvelope.kind');
  if (payloadByteLength(value.payload) > MAX_WS_PAYLOAD_BYTES) {
    throw new Error('federated WS payload exceeds 256 KiB');
  }
  return value as unknown as FederatedWsEnvelope<TPayload>;
}

export function validateFederatedWsAck(value: unknown): FederatedWsAckPayload {
  if (!isContractRecord(value)) throw new Error('FederatedWsAck is invalid');
  requireExactKeys(value, ['acceptedSequence', 'outcome', 'code', 'message', 'result'], [], 'wsAck');
  requireInteger(value.acceptedSequence, 'wsAck.acceptedSequence', 0);
  requireEnum(value.outcome, ['ACCEPTED', 'COMPLETED', 'REJECTED', 'CANCELLED'] as const, 'wsAck.outcome');
  if (value.code !== null) requireString(value.code, 'wsAck.code', { max: 128, pattern: /^[A-Z][A-Z0-9_]+$/ });
  if (value.message !== null) requireString(value.message, 'wsAck.message', { max: 1024 });
  if (payloadByteLength(value.result) > MAX_WS_PAYLOAD_BYTES) {
    throw new Error('federated WS ack result exceeds 256 KiB');
  }
  return value as unknown as FederatedWsAckPayload;
}

export function validateFederatedWsState(value: unknown): FederatedWsStatePayload {
  if (!isContractRecord(value)) throw new Error('FederatedWsState is invalid');
  requireExactKeys(value, ['state', 'reasonCode', 'readyAt', 'retryAfterMs'], [], 'wsState');
  requireEnum(value.state, FEDERATED_WS_STATES, 'wsState.state');
  requireString(value.reasonCode, 'wsState.reasonCode', {
    max: 128,
    pattern: /^[A-Z][A-Z0-9_]*$/,
  });
  if (value.readyAt !== null) requireIsoDate(value.readyAt, 'wsState.readyAt');
  if (value.retryAfterMs !== null) requireInteger(value.retryAfterMs, 'wsState.retryAfterMs', 0, 30_000);
  if ((value.state === 'READY') !== (value.readyAt !== null)) {
    throw new Error('wsState.readyAt must exist only for READY');
  }
  return value as unknown as FederatedWsStatePayload;
}
