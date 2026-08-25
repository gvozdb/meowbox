import type {
  ActionRole,
  CancellationPolicy,
  ExecutionMode,
  IdempotencyPolicy,
} from './federation-actions';
import {
  ACTION_ROLES,
  CANCELLATION_POLICIES,
  EXECUTION_MODES,
  IDEMPOTENCY_POLICIES,
  UNKNOWN_REQUIRES_CHARACTERIZATION,
} from './federation-actions';
import {
  isContractRecord,
  requireBoolean,
  requireEnum,
  requireExactKeys,
  requireHttpsOrigin,
  requireInteger,
  requireIsoDate,
  requireString,
  requireUniqueStrings,
} from './contract-validation';

export const FEDERATION_PROTOCOL_VERSION = 1 as const;
export const FEDERATION_MANIFEST_SCHEMA_VERSION = 1 as const;

export const FEDERATION_MANIFEST_ENDPOINT_STATES = [
  'UNCONFIGURED',
  'READY',
] as const;
export type FederationManifestEndpointState =
  (typeof FEDERATION_MANIFEST_ENDPOINT_STATES)[number];

export const FEDERATION_PROTOCOL_MODES = [
  'disabled',
  'observe',
  'v1-read-only',
  'v1-enabled',
  'legacy-upgrade-only',
] as const;
export type FederationProtocolMode = (typeof FEDERATION_PROTOCOL_MODES)[number];

export const FEDERATION_REASON_CODES = [
  'READY',
  'DISABLED',
  'OFFLINE',
  'AUTH_FAILED',
  'IP_BLOCKED',
  'TRUST_REQUIRED',
  'TRUST_REVOKED',
  'MANIFEST_STALE',
  'MANIFEST_INVALID',
  'PROTOCOL_INCOMPATIBLE',
  'CAPABILITY_UNAVAILABLE',
  'PARTIAL_CAPABILITY',
  'TARGET_BROWSER_UNREACHABLE',
  'POLICY_BLOCKED',
  'ENDPOINT_CUTOVER',
  'REGISTRY_FROZEN',
  'LEGACY_UPGRADE_REQUIRED',
  'UNKNOWN',
] as const;
export type FederationReasonCode = (typeof FEDERATION_REASON_CODES)[number];

export const FEDERATION_ERROR_CODES = [
  'REMOTE_DISABLED',
  'REMOTE_OFFLINE',
  'REMOTE_DNS_FAILED',
  'REMOTE_TLS_FAILED',
  'REMOTE_CONNECT_TIMEOUT',
  'REMOTE_HEADER_TIMEOUT',
  'REMOTE_IDLE_TIMEOUT',
  'REMOTE_ABORTED',
  'REMOTE_AUTH_FAILED',
  'REMOTE_REPLAY_REJECTED',
  'REMOTE_ACTION_UNKNOWN',
  'REMOTE_ACTION_UNSUPPORTED',
  'REMOTE_SCHEMA_MISMATCH',
  'REMOTE_PERMISSION_DENIED',
  'REMOTE_IDEMPOTENCY_CONFLICT',
  'REMOTE_NOT_READY',
  'REMOTE_APPLICATION_ERROR',
  'REMOTE_REGISTRY_FROZEN',
  'REMOTE_BROWSER_UNREACHABLE',
  'REMOTE_POLICY_BLOCKED',
] as const;
export type FederationErrorCode = (typeof FEDERATION_ERROR_CODES)[number];

export interface FederationErrorContract {
  code: FederationErrorCode;
  message: string;
  requestId: string;
  targetInstallationId: string | null;
  actionId: string | null;
  retryable: boolean;
  retryAfterSeconds: number | null;
  targetStatus: number | null;
}

export const REMOTE_TRANSPORT_STATES = ['UNKNOWN', 'ONLINE', 'OFFLINE', 'DEGRADED', 'AUTH_FAILED'] as const;
export const REMOTE_TRUST_STATES = ['UNENROLLED', 'PENDING', 'ACTIVE', 'ROTATING', 'REVOKED', 'FAILED'] as const;
export const REMOTE_CAPABILITY_STATES = ['UNKNOWN', 'FRESH', 'STALE', 'INCOMPATIBLE', 'PARTIAL'] as const;
export const REMOTE_BROWSER_STATES = ['UNKNOWN', 'PROBING', 'REACHABLE', 'UNREACHABLE'] as const;
export const REMOTE_TOPOLOGY_MODES = ['PUBLIC', 'TRUSTED_PRIVATE'] as const;

export interface ProtocolRange {
  min: number;
  max: number;
}

export interface RemoteState<TState extends string> {
  state: TState;
  reasonCode: FederationReasonCode;
  observedAt: string;
  freshUntil: string | null;
}

export interface RemoteActionCapability {
  actionId: string;
  schemaVersion: number;
  enabled: boolean;
  roles: readonly ActionRole[];
  permissions: readonly string[];
  requestMedia: readonly string[];
  responseMedia: readonly string[];
  executionMode: ExecutionMode;
  idempotency: IdempotencyPolicy;
  cancellation: CancellationPolicy;
  connectMs: number;
  headersMs: number;
  idleMs: number;
  operationMs: number;
  legacySafe: boolean;
}

export interface FederationManifestEndpointSet {
  apiOrigin: string;
  apiPath: '/api';
  wsOrigin: string;
  socketPath: string;
  browserPublicOrigin: string;
  directTransferOrigin: string;
}

export interface SignedFederationManifest {
  schemaVersion: number;
  revision: string;
  catalogueSha256: string;
  installationId: string;
  installationRole: 'MASTER' | 'TARGET';
  protocolMode: FederationProtocolMode;
  productVersion: string;
  protocol: ProtocolRange;
  acceptedMasterProtocol: ProtocolRange;
  endpointState: FederationManifestEndpointState;
  endpoints: Readonly<Record<string, never>> | FederationManifestEndpointSet;
  actions: Readonly<Record<string, RemoteActionCapability>>;
  generatedAt: string;
  validUntil: string;
  signature: Readonly<{
    algorithm: 'Ed25519';
    kid: string;
    value: string;
  }>;
}

export interface RemoteEndpointSet {
  apiOrigin: string;
  apiPath: string;
  wsOrigin: string;
  socketPath: string;
  browserPublicOrigin: string;
  directTransferOrigin: string;
  sshHost: string;
  sshPort: number;
}

export interface RemoteFeatureKillSwitches {
  http: boolean;
  ws: boolean;
  publicDelivery: boolean;
  legacy: boolean;
}

export interface RemoteContext {
  serverId: string;
  targetInstallationId: string;
  displayName: string;
  registryGeneration: number;
  contextEpoch: number;
  endpoints: RemoteEndpointSet;
  productVersion: string;
  protocol: {
    mode: FederationProtocolMode;
    selected: number | null;
    target: ProtocolRange;
    acceptedMaster: ProtocolRange;
  };
  manifest: {
    schemaVersion: number;
    revision: string;
    validUntil: string;
  };
  capabilities: Readonly<Record<string, RemoteActionCapability>>;
  status: {
    transport: RemoteState<(typeof REMOTE_TRANSPORT_STATES)[number]>;
    trust: RemoteState<(typeof REMOTE_TRUST_STATES)[number]>;
    capability: RemoteState<(typeof REMOTE_CAPABILITY_STATES)[number]>;
    browser: RemoteState<(typeof REMOTE_BROWSER_STATES)[number]>;
  };
  topologyMode: (typeof REMOTE_TOPOLOGY_MODES)[number];
  killSwitches: RemoteFeatureKillSwitches;
}

export interface BrowserRemoteContext {
  serverId: string;
  targetInstallationId: string;
  displayName: string;
  registryGeneration: number;
  contextEpoch: number;
  browserPublicOrigin: string;
  directTransferOrigin: string;
  sshHost: string;
  sshPort: number;
  productVersion: string;
  protocol: RemoteContext['protocol'];
  manifest: RemoteContext['manifest'];
  capabilities: RemoteContext['capabilities'];
  status: RemoteContext['status'];
  topologyMode: RemoteContext['topologyMode'];
  killSwitches: RemoteFeatureKillSwitches;
}

export interface FederationCompatibilityResult {
  compatible: boolean;
  selectedProtocol: number | null;
  reasonCode: 'READY' | 'PROTOCOL_INCOMPATIBLE';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REGISTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ACTION_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9_-]+)+$/;
const PERMISSION = /^[a-z][a-z0-9]*(?:[.:_-][a-z0-9]+)*$/;
const MEDIA = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+*-]+$/i;

function assertRange(range: ProtocolRange, label: string): void {
  if (
    !isContractRecord(range) ||
    !Number.isSafeInteger(range.min) ||
    !Number.isSafeInteger(range.max) ||
    range.min < 1 ||
    range.max < range.min
  ) throw new Error(`${label} is invalid`);
}

function assertRemoteState(
  value: unknown,
  states: readonly string[],
  label: string,
): void {
  if (!isContractRecord(value)) throw new Error(`${label} is invalid`);
  requireExactKeys(value, ['state', 'reasonCode', 'observedAt', 'freshUntil'], [], label);
  requireEnum(value.state, states, `${label}.state`);
  requireEnum(value.reasonCode, FEDERATION_REASON_CODES, `${label}.reasonCode`);
  requireIsoDate(value.observedAt, `${label}.observedAt`);
  if (value.freshUntil !== null) requireIsoDate(value.freshUntil, `${label}.freshUntil`);
}

function assertActionCapability(value: unknown, key: string): void {
  if (!isContractRecord(value)) throw new Error(`capabilities.${key} is invalid`);
  requireExactKeys(value, [
    'actionId', 'schemaVersion', 'enabled', 'roles', 'permissions', 'requestMedia',
    'responseMedia', 'executionMode', 'idempotency', 'cancellation', 'connectMs',
    'headersMs', 'idleMs', 'operationMs', 'legacySafe',
  ], [], `capabilities.${key}`);
  const actionId = requireString(value.actionId, `capabilities.${key}.actionId`, { pattern: ACTION_ID });
  if (actionId !== key) throw new Error(`capabilities.${key}.actionId does not match its key`);
  requireInteger(value.schemaVersion, `capabilities.${key}.schemaVersion`, 1, 1000);
  requireBoolean(value.enabled, `capabilities.${key}.enabled`);
  const roles = requireUniqueStrings(value.roles, `capabilities.${key}.roles`, { maxItems: 8, maxLength: 64 });
  if (roles.some((role) => !ACTION_ROLES.includes(role as never) || role === UNKNOWN_REQUIRES_CHARACTERIZATION)) {
    throw new Error(`capabilities.${key}.roles is invalid`);
  }
  requireUniqueStrings(value.permissions, `capabilities.${key}.permissions`, { maxItems: 64, pattern: PERMISSION });
  requireUniqueStrings(value.requestMedia, `capabilities.${key}.requestMedia`, { maxItems: 16, pattern: MEDIA });
  requireUniqueStrings(value.responseMedia, `capabilities.${key}.responseMedia`, { maxItems: 16, pattern: MEDIA });
  const executionMode = requireString(value.executionMode, `capabilities.${key}.executionMode`, { max: 64 });
  const idempotency = requireString(value.idempotency, `capabilities.${key}.idempotency`, { max: 64 });
  const cancellation = requireString(value.cancellation, `capabilities.${key}.cancellation`, { max: 64 });
  if (
    !EXECUTION_MODES.includes(executionMode as never) ||
    executionMode === UNKNOWN_REQUIRES_CHARACTERIZATION ||
    !IDEMPOTENCY_POLICIES.includes(idempotency as never) ||
    idempotency === UNKNOWN_REQUIRES_CHARACTERIZATION ||
    !CANCELLATION_POLICIES.includes(cancellation as never) ||
    cancellation === UNKNOWN_REQUIRES_CHARACTERIZATION
  ) throw new Error(`capabilities.${key} policy is invalid`);
  for (const field of ['connectMs', 'headersMs', 'idleMs', 'operationMs'] as const) {
    requireInteger(value[field], `capabilities.${key}.${field}`, 0, 86_400_000);
  }
  requireBoolean(value.legacySafe, `capabilities.${key}.legacySafe`);
}

function assertManifestEndpoints(
  endpointState: FederationManifestEndpointState,
  endpoints: unknown,
): void {
  if (!isContractRecord(endpoints)) {
    throw new Error('FederationManifest.endpoints is invalid');
  }
  if (endpointState === 'UNCONFIGURED') {
    requireExactKeys(endpoints, [], [], 'FederationManifest.endpoints');
    return;
  }
  requireExactKeys(endpoints, [
    'apiOrigin',
    'apiPath',
    'wsOrigin',
    'socketPath',
    'browserPublicOrigin',
    'directTransferOrigin',
  ], [], 'FederationManifest.endpoints');
  requireHttpsOrigin(endpoints.apiOrigin, 'FederationManifest.endpoints.apiOrigin');
  requireHttpsOrigin(endpoints.wsOrigin, 'FederationManifest.endpoints.wsOrigin');
  requireHttpsOrigin(
    endpoints.browserPublicOrigin,
    'FederationManifest.endpoints.browserPublicOrigin',
  );
  requireHttpsOrigin(
    endpoints.directTransferOrigin,
    'FederationManifest.endpoints.directTransferOrigin',
  );
  requireString(endpoints.apiPath, 'FederationManifest.endpoints.apiPath', {
    pattern: /^\/api$/,
  });
  const socketPath = requireString(
    endpoints.socketPath,
    'FederationManifest.endpoints.socketPath',
    { pattern: /^\/[A-Za-z0-9][A-Za-z0-9._/-]*\/?$/ },
  );
  if (
    socketPath.includes('//') ||
    socketPath.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error('FederationManifest.endpoints.socketPath is invalid');
  }
}

/** Deterministic JSON used by manifest revision and Ed25519 verification. */
export function canonicalFederationJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalFederationJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalFederationJson(object[key])}`)
    .join(',')}}`;
}

export function validateSignedFederationManifest(
  value: unknown,
): SignedFederationManifest {
  if (!isContractRecord(value)) throw new Error('FederationManifest is invalid');
  requireExactKeys(value, [
    'schemaVersion',
    'revision',
    'catalogueSha256',
    'installationId',
    'installationRole',
    'protocolMode',
    'productVersion',
    'protocol',
    'acceptedMasterProtocol',
    'endpointState',
    'endpoints',
    'actions',
    'generatedAt',
    'validUntil',
    'signature',
  ], [], 'FederationManifest');
  requireInteger(
    value.schemaVersion,
    'FederationManifest.schemaVersion',
    FEDERATION_MANIFEST_SCHEMA_VERSION,
    FEDERATION_MANIFEST_SCHEMA_VERSION,
  );
  requireString(value.revision, 'FederationManifest.revision', {
    pattern: /^[0-9a-f]{64}$/,
  });
  requireString(value.catalogueSha256, 'FederationManifest.catalogueSha256', {
    pattern: /^[0-9a-f]{64}$/,
  });
  requireString(value.installationId, 'FederationManifest.installationId', {
    pattern: UUID,
  });
  requireEnum(
    value.installationRole,
    ['MASTER', 'TARGET'] as const,
    'FederationManifest.installationRole',
  );
  requireEnum(
    value.protocolMode,
    FEDERATION_PROTOCOL_MODES,
    'FederationManifest.protocolMode',
  );
  requireString(value.productVersion, 'FederationManifest.productVersion', {
    max: 64,
    pattern: /^[v0-9A-Za-z.+-]+$/,
  });
  assertRange(value.protocol as ProtocolRange, 'FederationManifest.protocol');
  assertRange(
    value.acceptedMasterProtocol as ProtocolRange,
    'FederationManifest.acceptedMasterProtocol',
  );
  const endpointState = requireEnum(
    value.endpointState,
    FEDERATION_MANIFEST_ENDPOINT_STATES,
    'FederationManifest.endpointState',
  );
  assertManifestEndpoints(endpointState, value.endpoints);
  if (!isContractRecord(value.actions)) {
    throw new Error('FederationManifest.actions is invalid');
  }
  if (Object.keys(value.actions).length > 1024) {
    throw new Error('FederationManifest.actions exceeds the supported limit');
  }
  for (const [key, capability] of Object.entries(value.actions)) {
    if (!ACTION_ID.test(key)) throw new Error(`FederationManifest.actions.${key} key is invalid`);
    assertActionCapability(capability, key);
  }
  requireIsoDate(value.generatedAt, 'FederationManifest.generatedAt');
  requireIsoDate(value.validUntil, 'FederationManifest.validUntil');
  const generatedAt = Date.parse(value.generatedAt as string);
  const validUntil = Date.parse(value.validUntil as string);
  if (validUntil <= generatedAt || validUntil - generatedAt > 300_000) {
    throw new Error('FederationManifest validity window is invalid');
  }
  if (!isContractRecord(value.signature)) {
    throw new Error('FederationManifest.signature is invalid');
  }
  requireExactKeys(
    value.signature,
    ['algorithm', 'kid', 'value'],
    [],
    'FederationManifest.signature',
  );
  requireEnum(
    value.signature.algorithm,
    ['Ed25519'] as const,
    'FederationManifest.signature.algorithm',
  );
  requireString(value.signature.kid, 'FederationManifest.signature.kid', {
    pattern: /^ed25519-[A-Za-z0-9_-]{22}$/,
  });
  requireString(value.signature.value, 'FederationManifest.signature.value', {
    pattern: /^[A-Za-z0-9_-]{86}$/,
  });
  return value as unknown as SignedFederationManifest;
}

export function intersectFederationProtocol(
  master: ProtocolRange,
  target: ProtocolRange,
  acceptedMaster: ProtocolRange,
): FederationCompatibilityResult {
  assertRange(master, 'master protocol range');
  assertRange(target, 'target protocol range');
  assertRange(acceptedMaster, 'accepted master protocol range');
  const min = Math.max(master.min, target.min, acceptedMaster.min);
  const max = Math.min(master.max, target.max, acceptedMaster.max);
  return min <= max
    ? { compatible: true, selectedProtocol: max, reasonCode: 'READY' }
    : { compatible: false, selectedProtocol: null, reasonCode: 'PROTOCOL_INCOMPATIBLE' };
}

export function validateRemoteContext(value: unknown): RemoteContext {
  if (!isContractRecord(value)) throw new Error('RemoteContext is invalid');
  requireExactKeys(value, [
    'serverId', 'targetInstallationId', 'displayName', 'registryGeneration',
    'contextEpoch', 'endpoints', 'productVersion', 'protocol', 'manifest',
    'capabilities', 'status', 'topologyMode', 'killSwitches',
  ], [], 'RemoteContext');
  // Existing registry IDs are preserved during JSON -> DB cutover. Delegated
  // request paths use targetInstallationId, which remains a canonical UUID.
  requireString(value.serverId, 'RemoteContext.serverId', { pattern: REGISTRY_ID });
  requireString(value.targetInstallationId, 'RemoteContext.targetInstallationId', { pattern: UUID });
  requireString(value.displayName, 'RemoteContext.displayName', { max: 128 });
  requireInteger(value.registryGeneration, 'RemoteContext.registryGeneration', 1);
  requireInteger(value.contextEpoch, 'RemoteContext.contextEpoch', 1);
  requireString(value.productVersion, 'RemoteContext.productVersion', { max: 64 });

  if (!isContractRecord(value.endpoints)) throw new Error('RemoteContext.endpoints is invalid');
  requireExactKeys(value.endpoints, [
    'apiOrigin', 'apiPath', 'wsOrigin', 'socketPath', 'browserPublicOrigin',
    'directTransferOrigin', 'sshHost', 'sshPort',
  ], [], 'RemoteContext.endpoints');
  requireHttpsOrigin(value.endpoints.apiOrigin, 'RemoteContext.endpoints.apiOrigin');
  requireHttpsOrigin(value.endpoints.wsOrigin, 'RemoteContext.endpoints.wsOrigin');
  requireHttpsOrigin(value.endpoints.browserPublicOrigin, 'RemoteContext.endpoints.browserPublicOrigin');
  requireHttpsOrigin(value.endpoints.directTransferOrigin, 'RemoteContext.endpoints.directTransferOrigin');
  requireString(value.endpoints.apiPath, 'RemoteContext.endpoints.apiPath', { pattern: /^\/api$/ });
  const socketPath = requireString(value.endpoints.socketPath, 'RemoteContext.endpoints.socketPath', {
    pattern: /^\/[A-Za-z0-9][A-Za-z0-9._/-]*\/?$/,
  });
  if (
    socketPath.includes('//') ||
    socketPath.split('/').some((segment) => segment === '.' || segment === '..')
  ) throw new Error('RemoteContext.endpoints.socketPath is invalid');
  requireString(value.endpoints.sshHost, 'RemoteContext.endpoints.sshHost', { max: 253, pattern: /^[A-Za-z0-9.:-]+$/ });
  requireInteger(value.endpoints.sshPort, 'RemoteContext.endpoints.sshPort', 1, 65535);

  if (!isContractRecord(value.protocol)) throw new Error('RemoteContext.protocol is invalid');
  requireExactKeys(value.protocol, ['mode', 'selected', 'target', 'acceptedMaster'], [], 'RemoteContext.protocol');
  requireEnum(value.protocol.mode, FEDERATION_PROTOCOL_MODES, 'RemoteContext.protocol.mode');
  if (value.protocol.selected !== null) requireInteger(value.protocol.selected, 'RemoteContext.protocol.selected', 1, 1000);
  assertRange(value.protocol.target as ProtocolRange, 'RemoteContext.protocol.target');
  assertRange(value.protocol.acceptedMaster as ProtocolRange, 'RemoteContext.protocol.acceptedMaster');

  if (!isContractRecord(value.manifest)) throw new Error('RemoteContext.manifest is invalid');
  requireExactKeys(value.manifest, ['schemaVersion', 'revision', 'validUntil'], [], 'RemoteContext.manifest');
  requireInteger(value.manifest.schemaVersion, 'RemoteContext.manifest.schemaVersion', 1, 1000);
  requireString(value.manifest.revision, 'RemoteContext.manifest.revision', { max: 128 });
  requireIsoDate(value.manifest.validUntil, 'RemoteContext.manifest.validUntil');

  if (!isContractRecord(value.capabilities)) throw new Error('RemoteContext.capabilities is invalid');
  for (const [key, capability] of Object.entries(value.capabilities)) {
    if (!ACTION_ID.test(key)) throw new Error(`capabilities.${key} key is invalid`);
    assertActionCapability(capability, key);
  }

  if (!isContractRecord(value.status)) throw new Error('RemoteContext.status is invalid');
  requireExactKeys(value.status, ['transport', 'trust', 'capability', 'browser'], [], 'RemoteContext.status');
  assertRemoteState(value.status.transport, REMOTE_TRANSPORT_STATES, 'RemoteContext.status.transport');
  assertRemoteState(value.status.trust, REMOTE_TRUST_STATES, 'RemoteContext.status.trust');
  assertRemoteState(value.status.capability, REMOTE_CAPABILITY_STATES, 'RemoteContext.status.capability');
  assertRemoteState(value.status.browser, REMOTE_BROWSER_STATES, 'RemoteContext.status.browser');
  requireEnum(value.topologyMode, REMOTE_TOPOLOGY_MODES, 'RemoteContext.topologyMode');

  if (!isContractRecord(value.killSwitches)) throw new Error('RemoteContext.killSwitches is invalid');
  requireExactKeys(value.killSwitches, ['http', 'ws', 'publicDelivery', 'legacy'], [], 'RemoteContext.killSwitches');
  for (const field of ['http', 'ws', 'publicDelivery', 'legacy'] as const) {
    requireBoolean(value.killSwitches[field], `RemoteContext.killSwitches.${field}`);
  }
  return value as unknown as RemoteContext;
}

export function toBrowserRemoteContext(context: RemoteContext): BrowserRemoteContext {
  const valid = validateRemoteContext(context);
  return {
    serverId: valid.serverId,
    targetInstallationId: valid.targetInstallationId,
    displayName: valid.displayName,
    registryGeneration: valid.registryGeneration,
    contextEpoch: valid.contextEpoch,
    browserPublicOrigin: valid.endpoints.browserPublicOrigin,
    directTransferOrigin: valid.endpoints.directTransferOrigin,
    sshHost: valid.endpoints.sshHost,
    sshPort: valid.endpoints.sshPort,
    productVersion: valid.productVersion,
    protocol: valid.protocol,
    manifest: valid.manifest,
    capabilities: valid.capabilities,
    status: valid.status,
    topologyMode: valid.topologyMode,
    killSwitches: valid.killSwitches,
  };
}

export function validateFederationError(value: unknown): FederationErrorContract {
  if (!isContractRecord(value)) throw new Error('FederationError is invalid');
  requireExactKeys(value, [
    'code', 'message', 'requestId', 'targetInstallationId', 'actionId',
    'retryable', 'retryAfterSeconds', 'targetStatus',
  ], [], 'FederationError');
  requireEnum(value.code, FEDERATION_ERROR_CODES, 'FederationError.code');
  requireString(value.message, 'FederationError.message', { max: 1024 });
  requireString(value.requestId, 'FederationError.requestId', { pattern: UUID });
  if (value.targetInstallationId !== null) {
    requireString(value.targetInstallationId, 'FederationError.targetInstallationId', { pattern: UUID });
  }
  if (value.actionId !== null) {
    requireString(value.actionId, 'FederationError.actionId', { pattern: ACTION_ID });
  }
  requireBoolean(value.retryable, 'FederationError.retryable');
  if (value.retryAfterSeconds !== null) {
    requireInteger(value.retryAfterSeconds, 'FederationError.retryAfterSeconds', 1, 86_400);
  }
  if (value.targetStatus !== null) {
    requireInteger(value.targetStatus, 'FederationError.targetStatus', 100, 599);
  }
  return value as unknown as FederationErrorContract;
}
