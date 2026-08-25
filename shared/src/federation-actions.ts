/**
 * Phase-0 federation action catalogue contract.
 *
 * The catalogue is deliberately strict: it describes the existing surface,
 * but does not make a legacy action remotely callable.  A later protocol phase
 * must replace conservative characterisation markers before it can opt an
 * action into remote activation.
 */

export const ACTION_MATRIX_SCHEMA_VERSION = 'meowbox.remote-panel-parity.action-matrix/v1' as const;
export const UNKNOWN_REQUIRES_CHARACTERIZATION = 'UNKNOWN_REQUIRES_CHARACTERIZATION' as const;

export const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'ALL',
  'HEAD',
  'OPTIONS',
] as const;

export const ACTION_OWNERS = ['master', 'target', 'public', 'direct'] as const;
export const ACTION_ROLES = [
  'ADMIN',
  'MANAGER',
  'VIEWER',
  'SERVICE',
  'PUBLIC',
  'AUTHENTICATED_ANY',
  UNKNOWN_REQUIRES_CHARACTERIZATION,
] as const;
export const EXECUTION_MODES = [
  'INTERACTIVE',
  'OPERATION',
  'GENERATED_STREAM',
  'STAGED_ARTIFACT',
  'PUBLIC_ENDPOINT',
  'APP_HANDOFF',
  UNKNOWN_REQUIRES_CHARACTERIZATION,
] as const;
export const IDEMPOTENCY_POLICIES = [
  'DECLARED',
  'NOT_DECLARED',
  'UNKNOWN_REQUIRES_CHARACTERIZATION',
] as const;
export const CANCELLATION_POLICIES = [
  'SUPPORTED',
  'UNSUPPORTED',
  'UNKNOWN_REQUIRES_CHARACTERIZATION',
] as const;
export const REMOTE_ACTIVATION_POLICIES = ['DENY', 'ALLOW'] as const;
export const SOCKET_IO_CHANNELS = [
  'agent-rpc',
  'agent-telemetry',
  'browser-command',
  'browser-notification',
  'proxy-lifecycle',
  'agent-lifecycle',
  'proxy-relay',
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];
export type ActionOwner = (typeof ACTION_OWNERS)[number];
export type ActionRole = (typeof ACTION_ROLES)[number];
export type ExecutionMode = (typeof EXECUTION_MODES)[number];
export type IdempotencyPolicy = (typeof IDEMPOTENCY_POLICIES)[number];
export type CancellationPolicy = (typeof CANCELLATION_POLICIES)[number];
export type RemoteActivationPolicy = (typeof REMOTE_ACTIVATION_POLICIES)[number];
export type SocketIoChannel = (typeof SOCKET_IO_CHANNELS)[number];
export type CharacterizationValue = number | typeof UNKNOWN_REQUIRES_CHARACTERIZATION;

export interface HttpActionTransport {
  readonly kind: 'http';
  readonly method: HttpMethod;
  readonly routeTemplate: string;
}

export interface SocketIoActionTransport {
  readonly kind: 'socket.io';
  readonly channel: SocketIoChannel;
  readonly event: string;
  readonly direction: 'browser_to_api' | 'api_to_browser' | 'api_to_agent' | 'agent_to_api' | 'transport_lifecycle';
}

export type ActionTransport = HttpActionTransport | SocketIoActionTransport;

export interface ActionAuthorization {
  readonly roles: readonly ActionRole[];
  readonly permissions: readonly string[];
}

export interface ActionPayloadContract {
  readonly schema: string;
  readonly media: readonly string[];
}

export interface ActionIdempotency {
  readonly policy: IdempotencyPolicy;
  readonly currentBehavior: string;
}

export interface ActionCancellation {
  readonly policy: CancellationPolicy;
  readonly currentBehavior: string;
}

export interface ActionDeadline {
  readonly connectMs: CharacterizationValue;
  readonly headersMs: CharacterizationValue;
  readonly idleMs: CharacterizationValue;
  readonly operationMs: CharacterizationValue;
  readonly currentTimeoutMs: CharacterizationValue;
  readonly currentTimeoutSource: string;
}

export interface ActionLegacyBehavior {
  readonly behavior: string;
  readonly remoteActivation: RemoteActivationPolicy;
}

export interface ActionCodeOwner {
  readonly file: string;
  readonly symbol: string;
}

export interface ActionTraceability {
  readonly cf: readonly string[];
  readonly a: readonly string[];
  readonly sp: readonly string[];
  readonly im: readonly string[];
  readonly bn: readonly string[];
}

export interface ActionVerification {
  readonly test: string;
  readonly metric: {
    readonly name: string;
    readonly comparator: 'EQ' | 'LTE' | 'GTE';
    readonly threshold: number;
    readonly unit: string;
  };
}

export interface FederationActionDescriptor {
  readonly actionId: string;
  readonly transport: ActionTransport;
  readonly owner: ActionOwner;
  readonly authorization: ActionAuthorization;
  readonly request: ActionPayloadContract;
  readonly response: ActionPayloadContract;
  readonly execution: {
    readonly mode: ExecutionMode;
  };
  readonly idempotency: ActionIdempotency;
  readonly cancellation: ActionCancellation;
  readonly deadline: ActionDeadline;
  readonly capability: string;
  readonly legacy: ActionLegacyBehavior;
  readonly codeOwner: ActionCodeOwner;
  /** Canonical source-inventory key used by the API coverage test. */
  readonly sourceKey: string;
  /** Every direction-qualified source declaration represented by this action. */
  readonly sourceBindings: readonly string[];
  readonly traceability: ActionTraceability;
  readonly verification: ActionVerification;
}

export type FederationActionDescriptorProfile = Omit<
  FederationActionDescriptor,
  'actionId' | 'transport' | 'owner' | 'authorization' | 'codeOwner' | 'sourceKey' | 'sourceBindings' | 'traceability'
>;

export type FederationActionMatrixEntry =
  & Pick<
    FederationActionDescriptor,
    'actionId' | 'transport' | 'owner' | 'authorization' | 'codeOwner' | 'sourceKey' | 'sourceBindings' | 'traceability'
  >
  & {
    readonly profile?: string;
  }
  & Partial<FederationActionDescriptorProfile>;

const PROFILE_FIELDS = [
  'request', 'response', 'execution', 'idempotency', 'cancellation',
  'deadline', 'capability', 'legacy', 'verification',
] as const;

export interface FederationActionMatrixDocument {
  readonly schemaVersion: typeof ACTION_MATRIX_SCHEMA_VERSION;
  readonly profiles?: Readonly<Record<string, FederationActionDescriptorProfile>>;
  readonly actions: readonly FederationActionMatrixEntry[];
  readonly legacyUnsafeFindings?: readonly LegacyUnsafeSocketFinding[];
}

export interface ValidatedFederationActionMatrix {
  readonly schemaVersion: typeof ACTION_MATRIX_SCHEMA_VERSION;
  readonly actions: readonly FederationActionDescriptor[];
  readonly legacyUnsafeFindings: readonly LegacyUnsafeSocketFinding[];
}

export interface HttpActionLookup {
  readonly kind: 'http';
  readonly actionId: string;
  readonly method: HttpMethod;
  readonly routeTemplate: string;
}

export interface SocketIoActionLookup {
  readonly kind: 'socket.io';
  readonly actionId: string;
  readonly channel: SocketIoChannel;
  readonly event: string;
  readonly direction: SocketIoActionTransport['direction'];
}

export type FederationActionLookup = HttpActionLookup | SocketIoActionLookup;

export interface ConcreteHttpActionLookup {
  readonly kind: 'http';
  readonly actionId: string;
  readonly method: HttpMethod;
  readonly concretePath: string;
}

/**
 * Inventory-only record for the current generic proxy `onAny` relays.  It is
 * intentionally not an action descriptor and cannot ever participate in an
 * action lookup.
 */
export interface LegacyUnsafeSocketFinding {
  readonly findingId: string;
  readonly transport: {
    readonly kind: 'socket.io';
    readonly channel: 'proxy-relay';
    readonly event: '*';
    readonly direction: 'relay_bidirectional';
  };
  readonly codeOwner: ActionCodeOwner;
  readonly sourceKey: string;
  readonly behavior: string;
  readonly remoteActivation: 'DENY';
  readonly verification: ActionVerification;
}

export class FederationActionDescriptorError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid federation action descriptor: ${issues.join('; ')}`);
    this.name = 'FederationActionDescriptorError';
    this.issues = issues;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const isOneOf = <T extends readonly string[]>(value: unknown, values: T): value is T[number] =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(isNonEmptyString);

const isCharacterizationValue = (value: unknown): value is CharacterizationValue =>
  value === UNKNOWN_REQUIRES_CHARACTERIZATION ||
  (typeof value === 'number' && Number.isFinite(value) && value >= 0);

const appendUnknownFieldIssues = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  issues: string[],
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`${label}.${key} is not allowed`);
  }
};

const isSafeRouteTemplate = (value: string): boolean =>
  value.startsWith('/api/') &&
  !value.includes('//') &&
  !value.includes('\\') &&
  !value.includes('?') &&
  !value.includes('#') &&
  !value.includes('..') &&
  /^[A-Za-z0-9._~:/\-*]+$/.test(value);

const decodeRouteParameter = (value: string): string | null => {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 &&
      decoded !== '.' &&
      decoded !== '..' &&
      !decoded.includes('/') &&
      !decoded.includes('\\') &&
      !/[\x00-\x1f\x7f]/.test(decoded)
      ? decoded
      : null;
  } catch {
    return null;
  }
};

/**
 * Matches a previously validated concrete request path to one controller
 * template. Static segments are byte-exact; only `:param` segments may be
 * percent-decoded. Wildcards never participate in federation routing.
 */
export const matchesFederationRouteTemplate = (
  routeTemplate: string,
  concretePath: string,
): boolean => {
  if (
    !isSafeRouteTemplate(routeTemplate) ||
    routeTemplate.includes('*') ||
    !concretePath.startsWith('/api/') ||
    concretePath.includes('?') ||
    concretePath.includes('#') ||
    concretePath.includes('//') ||
    concretePath.includes('\\') ||
    !/^[\x21-\x7e]+$/.test(concretePath)
  ) return false;

  const templateSegments = routeTemplate.split('/');
  const concreteSegments = concretePath.split('/');
  if (templateSegments.length !== concreteSegments.length) return false;

  return templateSegments.every((templateSegment, index) => {
    const concreteSegment = concreteSegments[index];
    if (!templateSegment.startsWith(':')) return templateSegment === concreteSegment;
    return /^:[A-Za-z_][A-Za-z0-9_]*$/.test(templateSegment) &&
      decodeRouteParameter(concreteSegment) !== null;
  });
};

const hasUnknownCharacterization = (value: unknown): boolean => {
  if (value === UNKNOWN_REQUIRES_CHARACTERIZATION) return true;
  if (Array.isArray(value)) return value.some(hasUnknownCharacterization);
  if (isRecord(value)) return Object.values(value).some(hasUnknownCharacterization);
  return false;
};

const cloneProfile = (profile: FederationActionDescriptorProfile): FederationActionDescriptorProfile => ({
  ...profile,
  request: { ...profile.request, media: [...profile.request.media] },
  response: { ...profile.response, media: [...profile.response.media] },
  execution: { ...profile.execution },
  idempotency: { ...profile.idempotency },
  cancellation: { ...profile.cancellation },
  deadline: { ...profile.deadline },
  legacy: { ...profile.legacy },
  verification: { ...profile.verification, metric: { ...profile.verification.metric } },
});

const resolveEntry = (
  entry: FederationActionMatrixEntry,
  profiles: Readonly<Record<string, FederationActionDescriptorProfile>>,
  issues: string[],
  index: number,
): FederationActionDescriptor | null => {
  const profileName = entry.profile;
  const profile = profileName === undefined ? undefined : profiles[profileName];
  if (profileName !== undefined && profile === undefined) {
    issues.push(`actions[${index}].profile ${JSON.stringify(profileName)} does not exist`);
    return null;
  }

  const resolved = {
    ...(profile === undefined ? {} : cloneProfile(profile)),
    ...entry,
  } as FederationActionDescriptor & { profile?: string };
  delete resolved.profile;
  return resolved;
};

const validatePayload = (
  value: unknown,
  label: string,
  issues: string[],
): value is ActionPayloadContract => {
  if (!isRecord(value)) {
    issues.push(`${label} must be an object`);
    return false;
  }
  appendUnknownFieldIssues(value, ['schema', 'media'], label, issues);
  if (!isNonEmptyString(value.schema)) issues.push(`${label}.schema must be a non-empty string`);
  if (!isStringArray(value.media) || value.media.length === 0) {
    issues.push(`${label}.media must be a non-empty string array`);
  }
  return true;
};

const validateVerification = (
  value: unknown,
  label: string,
  issues: string[],
): value is ActionVerification => {
  if (!isRecord(value)) {
    issues.push(`${label} must be an object`);
    return false;
  }
  appendUnknownFieldIssues(value, ['test', 'metric'], label, issues);
  if (!isNonEmptyString(value.test) || !isRecord(value.metric)) {
    issues.push(`${label} must contain test and metric`);
    return false;
  }
  const metric = value.metric;
  appendUnknownFieldIssues(metric, ['name', 'comparator', 'threshold', 'unit'], `${label}.metric`, issues);
  if (!isNonEmptyString(metric.name) ||
    !isOneOf(metric.comparator, ['EQ', 'LTE', 'GTE'] as const) ||
    typeof metric.threshold !== 'number' || !Number.isFinite(metric.threshold) || metric.threshold < 0 ||
    !isNonEmptyString(metric.unit)) {
    issues.push(`${label}.metric is invalid`);
  }
  return true;
};

const validateDescriptor = (
  value: unknown,
  label: string,
  issues: string[],
): value is FederationActionDescriptor => {
  if (!isRecord(value)) {
    issues.push(`${label} must be an object`);
    return false;
  }

  appendUnknownFieldIssues(value, [
    'actionId', 'transport', 'owner', 'authorization', 'request', 'response',
    'execution', 'idempotency', 'cancellation', 'deadline', 'capability', 'legacy',
    'codeOwner', 'sourceKey', 'sourceBindings', 'traceability', 'verification',
  ], label, issues);

  if (!isNonEmptyString(value.actionId) || !/^[a-z][a-z0-9.-]*$/.test(value.actionId)) {
    issues.push(`${label}.actionId must be a stable lower-case identifier`);
  }
  if (!isOneOf(value.owner, ACTION_OWNERS)) issues.push(`${label}.owner is invalid`);
  if (!isNonEmptyString(value.sourceKey)) issues.push(`${label}.sourceKey must be a non-empty string`);
  if (!isStringArray(value.sourceBindings) || value.sourceBindings.length === 0 ||
    new Set(value.sourceBindings).size !== value.sourceBindings.length) {
    issues.push(`${label}.sourceBindings must be a non-empty unique string array`);
  }
  if (!isNonEmptyString(value.capability)) issues.push(`${label}.capability must be a non-empty string`);

  if (!isRecord(value.transport)) {
    issues.push(`${label}.transport must be an object`);
  } else if (value.transport.kind === 'http') {
    appendUnknownFieldIssues(value.transport, ['kind', 'method', 'routeTemplate'], `${label}.transport`, issues);
    if (!isOneOf(value.transport.method, HTTP_METHODS)) issues.push(`${label}.transport.method is invalid`);
    if (!isNonEmptyString(value.transport.routeTemplate) || !isSafeRouteTemplate(value.transport.routeTemplate)) {
      issues.push(`${label}.transport.routeTemplate is not a canonical /api route template`);
    }
  } else if (value.transport.kind === 'socket.io') {
    appendUnknownFieldIssues(value.transport, ['kind', 'channel', 'event', 'direction'], `${label}.transport`, issues);
    if (!isOneOf(value.transport.channel, SOCKET_IO_CHANNELS) || value.transport.channel === 'proxy-relay') {
      issues.push(`${label}.transport.channel is invalid for an action descriptor`);
    }
    if (!isNonEmptyString(value.transport.event) || value.transport.event === '*' || /[\r\n\u0000]/.test(value.transport.event)) {
      issues.push(`${label}.transport.event must be a safe non-empty event name`);
    }
    if (!isOneOf(value.transport.direction, [
      'browser_to_api', 'api_to_browser', 'api_to_agent', 'agent_to_api', 'transport_lifecycle',
    ] as const)) {
      issues.push(`${label}.transport.direction is invalid`);
    }
  } else {
    issues.push(`${label}.transport.kind is invalid`);
  }

  if (!isRecord(value.authorization)) {
    issues.push(`${label}.authorization must be an object`);
  } else {
    appendUnknownFieldIssues(value.authorization, ['roles', 'permissions'], `${label}.authorization`, issues);
    if (!Array.isArray(value.authorization.roles) || value.authorization.roles.length === 0 ||
      !value.authorization.roles.every((role) => isOneOf(role, ACTION_ROLES))) {
      issues.push(`${label}.authorization.roles must be a non-empty valid role array`);
    }
    if (!isStringArray(value.authorization.permissions)) {
      issues.push(`${label}.authorization.permissions must be a string array`);
    }
  }

  validatePayload(value.request, `${label}.request`, issues);
  validatePayload(value.response, `${label}.response`, issues);

  if (!isRecord(value.execution) || !isOneOf(value.execution.mode, EXECUTION_MODES)) {
    issues.push(`${label}.execution.mode is invalid`);
  }

  if (!isRecord(value.idempotency) ||
    !isOneOf(value.idempotency.policy, IDEMPOTENCY_POLICIES) ||
    !isNonEmptyString(value.idempotency.currentBehavior)) {
    issues.push(`${label}.idempotency is invalid`);
  }

  if (!isRecord(value.cancellation) ||
    !isOneOf(value.cancellation.policy, CANCELLATION_POLICIES) ||
    !isNonEmptyString(value.cancellation.currentBehavior)) {
    issues.push(`${label}.cancellation is invalid`);
  }

  if (!isRecord(value.deadline)) {
    issues.push(`${label}.deadline must be an object`);
  } else {
    appendUnknownFieldIssues(value.deadline, [
      'connectMs', 'headersMs', 'idleMs', 'operationMs', 'currentTimeoutMs', 'currentTimeoutSource',
    ], `${label}.deadline`, issues);
    for (const field of ['connectMs', 'headersMs', 'idleMs', 'operationMs', 'currentTimeoutMs'] as const) {
      if (!isCharacterizationValue(value.deadline[field])) {
        issues.push(`${label}.deadline.${field} must be a non-negative number or ${UNKNOWN_REQUIRES_CHARACTERIZATION}`);
      }
    }
    if (!isNonEmptyString(value.deadline.currentTimeoutSource)) {
      issues.push(`${label}.deadline.currentTimeoutSource must be a non-empty string`);
    }
  }

  if (!isRecord(value.legacy) ||
    !isNonEmptyString(value.legacy.behavior) ||
    !isOneOf(value.legacy.remoteActivation, REMOTE_ACTIVATION_POLICIES)) {
    issues.push(`${label}.legacy is invalid`);
  }

  if (!isRecord(value.codeOwner) ||
    !isNonEmptyString(value.codeOwner.file) ||
    !isNonEmptyString(value.codeOwner.symbol)) {
    issues.push(`${label}.codeOwner must contain file and symbol`);
  }

  if (!isRecord(value.traceability)) {
    issues.push(`${label}.traceability must be an object`);
  } else {
    appendUnknownFieldIssues(value.traceability, ['cf', 'a', 'sp', 'im', 'bn'], `${label}.traceability`, issues);
    for (const field of ['cf', 'a', 'sp', 'im', 'bn'] as const) {
      if (!isStringArray(value.traceability[field])) issues.push(`${label}.traceability.${field} must be a string array`);
    }
  }

  validateVerification(value.verification, `${label}.verification`, issues);

  if (isRecord(value.legacy) && value.legacy.remoteActivation === 'ALLOW') {
    if (hasUnknownCharacterization(value)) {
      issues.push(`${label} has characterization gaps and must deny remote activation`);
    }
    if (value.owner !== 'target') {
      issues.push(`${label} only target-owned actions may allow remote activation`);
    }
    if (isRecord(value.authorization) && Array.isArray(value.authorization.roles)) {
      if (value.authorization.roles.some((role) =>
        role === 'PUBLIC' ||
        role === 'AUTHENTICATED_ANY' ||
        role === UNKNOWN_REQUIRES_CHARACTERIZATION)) {
        issues.push(`${label} remotely active actions require explicit operator or service roles`);
      }
      const service = value.authorization.roles.includes('SERVICE');
      if (service && value.authorization.roles.length !== 1) {
        issues.push(`${label} service actions cannot share an operator role descriptor`);
      }
    }
    if (isRecord(value.authorization) &&
      Array.isArray(value.authorization.permissions) &&
      value.authorization.permissions.length === 0) {
      issues.push(`${label} remotely active actions require explicit permissions`);
    }
    if (isRecord(value.transport) &&
      ((value.transport.kind === 'http' && value.transport.method === 'ALL') ||
        (value.transport.kind === 'socket.io' && value.transport.event === '*'))) {
      issues.push(`${label} wildcard actions must deny remote activation`);
    }
  }

  return true;
};

const validateLegacyUnsafeFinding = (
  value: unknown,
  label: string,
  issues: string[],
): value is LegacyUnsafeSocketFinding => {
  if (!isRecord(value)) {
    issues.push(`${label} must be an object`);
    return false;
  }
  appendUnknownFieldIssues(value, [
    'findingId', 'transport', 'codeOwner', 'sourceKey', 'behavior', 'remoteActivation', 'verification',
  ], label, issues);
  if (!isNonEmptyString(value.findingId) || !/^[a-z][a-z0-9.-]*$/.test(value.findingId)) {
    issues.push(`${label}.findingId must be a stable lower-case identifier`);
  }
  if (!isRecord(value.transport) ||
    value.transport.kind !== 'socket.io' ||
    value.transport.channel !== 'proxy-relay' ||
    value.transport.event !== '*' ||
    value.transport.direction !== 'relay_bidirectional') {
    issues.push(`${label}.transport must be the denied proxy-relay wildcard`);
  }
  if (!isRecord(value.codeOwner) || !isNonEmptyString(value.codeOwner.file) || !isNonEmptyString(value.codeOwner.symbol)) {
    issues.push(`${label}.codeOwner must contain file and symbol`);
  }
  if (!isNonEmptyString(value.sourceKey) || !isNonEmptyString(value.behavior)) {
    issues.push(`${label}.sourceKey and behavior must be non-empty strings`);
  }
  if (value.remoteActivation !== 'DENY') issues.push(`${label}.remoteActivation must be DENY`);
  validateVerification(value.verification, `${label}.verification`, issues);
  return true;
};

/**
 * Parses a raw JSON/YAML-decoded descriptor document and returns only fully
 * validated, profile-expanded descriptors.  It throws rather than returning a
 * partial result so callers cannot accidentally continue with an unsafe
 * catalogue.
 */
export const validateFederationActionMatrix = (
  input: unknown,
): ValidatedFederationActionMatrix => {
  const issues: string[] = [];
  if (!isRecord(input)) throw new FederationActionDescriptorError(['matrix must be an object']);
  appendUnknownFieldIssues(input, ['schemaVersion', 'profiles', 'actions', 'legacyUnsafeFindings'], 'matrix', issues);
  if (input.schemaVersion !== ACTION_MATRIX_SCHEMA_VERSION) {
    issues.push(`matrix.schemaVersion must equal ${ACTION_MATRIX_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(input.actions)) issues.push('matrix.actions must be an array');

  const profiles: Record<string, FederationActionDescriptorProfile> = {};
  if (input.profiles !== undefined) {
    if (!isRecord(input.profiles)) {
      issues.push('matrix.profiles must be an object');
    } else {
      for (const [name, profile] of Object.entries(input.profiles)) {
        if (!/^[a-z][a-z0-9-]*$/.test(name)) {
          issues.push(`matrix.profiles.${name} must have a stable lower-case name`);
          continue;
        }
        if (!isRecord(profile)) {
          issues.push(`matrix.profiles.${name} must be an object`);
          continue;
        }
        appendUnknownFieldIssues(profile, PROFILE_FIELDS, `matrix.profiles.${name}`, issues);
        const profileValue = profile as FederationActionDescriptorProfile;
        validateDescriptor({
          actionId: 'profile.validation',
          transport: { kind: 'http', method: 'GET', routeTemplate: '/api/profile-validation' },
          owner: 'target',
          authorization: { roles: ['ADMIN'], permissions: ['profile.validation'] },
          codeOwner: { file: 'shared/src/federation-actions.ts', symbol: `profile.${name}` },
          sourceKey: `profile|${name}`,
          sourceBindings: [`profile|${name}`],
          traceability: { cf: [], a: [], sp: [], im: [], bn: [] },
          ...profileValue,
        }, `matrix.profiles.${name}`, issues);
        profiles[name] = profileValue;
      }
    }
  }

  const actions: FederationActionDescriptor[] = [];
  if (Array.isArray(input.actions)) {
    input.actions.forEach((entry, index) => {
      if (!isRecord(entry)) {
        issues.push(`actions[${index}] must be an object`);
        return;
      }
      const rawEntry = entry as FederationActionMatrixEntry;
      const resolved = resolveEntry(rawEntry, profiles, issues, index);
      if (resolved !== null && validateDescriptor(resolved, `actions[${index}]`, issues)) {
        actions.push(resolved);
      }
    });
  }

  const legacyUnsafeFindings: LegacyUnsafeSocketFinding[] = [];
  if (input.legacyUnsafeFindings !== undefined && !Array.isArray(input.legacyUnsafeFindings)) {
    issues.push('matrix.legacyUnsafeFindings must be an array when present');
  }
  if (Array.isArray(input.legacyUnsafeFindings)) {
    input.legacyUnsafeFindings.forEach((finding, index) => {
      if (validateLegacyUnsafeFinding(finding, `legacyUnsafeFindings[${index}]`, issues)) {
        legacyUnsafeFindings.push(finding);
      }
    });
  }

  const actionIds = new Set<string>();
  const sourceKeys = new Set<string>();
  const sourceBindings = new Set<string>();
  for (const action of actions) {
    if (actionIds.has(action.actionId)) issues.push(`duplicate actionId ${action.actionId}`);
    actionIds.add(action.actionId);
    if (sourceKeys.has(action.sourceKey)) issues.push(`duplicate sourceKey ${action.sourceKey}`);
    sourceKeys.add(action.sourceKey);
    for (const sourceBinding of action.sourceBindings) {
      if (sourceBindings.has(sourceBinding)) issues.push(`duplicate source binding ${sourceBinding}`);
      sourceBindings.add(sourceBinding);
    }
  }
  const findingIds = new Set<string>();
  for (const finding of legacyUnsafeFindings) {
    if (findingIds.has(finding.findingId)) issues.push(`duplicate findingId ${finding.findingId}`);
    findingIds.add(finding.findingId);
    if (sourceKeys.has(finding.sourceKey)) issues.push(`duplicate sourceKey ${finding.sourceKey}`);
    sourceKeys.add(finding.sourceKey);
  }

  if (issues.length > 0) throw new FederationActionDescriptorError(issues);
  return {
    schemaVersion: ACTION_MATRIX_SCHEMA_VERSION,
    actions,
    legacyUnsafeFindings,
  };
};

/**
 * Performs an exact, fail-closed action lookup.  It intentionally does not
 * expand HTTP ALL or Socket.IO onAny (`*`) declarations: those legacy generic
 * relays are inventory records, never remote permissions.
 */
export const resolveFederationAction = (
  matrix: ValidatedFederationActionMatrix,
  lookup: FederationActionLookup,
): FederationActionDescriptor | undefined => {
  const action = matrix.actions.find((candidate) => candidate.actionId === lookup.actionId);
  if (action === undefined || action.legacy.remoteActivation !== 'ALLOW') return undefined;
  if (action.transport.kind !== lookup.kind) return undefined;

  if (lookup.kind === 'http' && action.transport.kind === 'http') {
    if (action.transport.method === 'ALL') return undefined;
    return action.transport.method === lookup.method && action.transport.routeTemplate === lookup.routeTemplate
      ? action
      : undefined;
  }
  if (lookup.kind === 'socket.io' && action.transport.kind === 'socket.io') {
    if (action.transport.event === '*') return undefined;
    return action.transport.channel === lookup.channel &&
      action.transport.event === lookup.event && action.transport.direction === lookup.direction
      ? action
      : undefined;
  }
  return undefined;
};

/** Resolve an active HTTP action against a concrete, already-sanitized path. */
export const resolveConcreteHttpFederationAction = (
  matrix: ValidatedFederationActionMatrix,
  lookup: ConcreteHttpActionLookup,
): FederationActionDescriptor | undefined => {
  const action = matrix.actions.find((candidate) => candidate.actionId === lookup.actionId);
  if (
    action === undefined ||
    action.legacy.remoteActivation !== 'ALLOW' ||
    action.transport.kind !== 'http' ||
    action.transport.method === 'ALL' ||
    action.transport.method !== lookup.method ||
    !matchesFederationRouteTemplate(action.transport.routeTemplate, lookup.concretePath)
  ) return undefined;
  return action;
};
