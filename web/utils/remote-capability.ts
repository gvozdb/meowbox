import type {
  BrowserRemoteContext,
  FederationErrorCode,
  FederationReasonCode,
} from '@meowbox/shared';

export type RemoteCapabilityTransport = 'http' | 'ws' | 'public';

export interface RemoteCapabilityRequirement {
  actionId?: string;
  transport?: RemoteCapabilityTransport;
  browserReachability?: boolean;
  mutation?: boolean;
}

export interface RemoteCapabilityDecision {
  available: boolean;
  code: FederationErrorCode | null;
  reasonCode: FederationReasonCode | null;
  message: string;
}

const REASON_MESSAGES: Readonly<Record<FederationReasonCode, string>> = {
  READY: 'Target готов.',
  DISABLED: 'Федерация для target выключена.',
  OFFLINE: 'Target не отвечает.',
  AUTH_FAILED: 'Target отклонил федеративную авторизацию.',
  IP_BLOCKED: 'Target заблокировал сетевой канал.',
  TRUST_REQUIRED: 'Target ещё не enrolled.',
  TRUST_REVOKED: 'Доверие target отозвано.',
  MANIFEST_STALE: 'Manifest target устарел.',
  MANIFEST_INVALID: 'Manifest target не прошёл проверку.',
  PROTOCOL_INCOMPATIBLE: 'Версии federation protocol несовместимы.',
  CAPABILITY_UNAVAILABLE: 'Target не объявил эту capability.',
  PARTIAL_CAPABILITY: 'Target поддерживает только часть действий.',
  TARGET_BROWSER_UNREACHABLE: 'Браузер не может открыть target напрямую.',
  POLICY_BLOCKED: 'Действие запрещено topology policy.',
  ENDPOINT_CUTOVER: 'Endpoint target переключается.',
  REGISTRY_FROZEN: 'Изменения registry заморожены.',
  LEGACY_UPGRADE_REQUIRED: 'Target нужно обновить до federation protocol 1.',
  UNKNOWN: 'Состояние target ещё не определено.',
};

function unavailable(
  code: FederationErrorCode,
  reasonCode: FederationReasonCode,
  message = REASON_MESSAGES[reasonCode],
): RemoteCapabilityDecision {
  return { available: false, code, reasonCode, message };
}

function contextReason(
  context: BrowserRemoteContext,
  area: keyof BrowserRemoteContext['status'],
): FederationReasonCode {
  return context.status[area].reasonCode;
}

export function evaluateRemoteCapability(input: {
  isLocal: boolean;
  context: BrowserRemoteContext | null;
  role: string | null;
  requirement?: RemoteCapabilityRequirement;
  nowMs?: number;
}): RemoteCapabilityDecision {
  if (input.isLocal) {
    return { available: true, code: null, reasonCode: null, message: '' };
  }

  const context = input.context;
  if (!context) {
    return unavailable('REMOTE_NOT_READY', 'UNKNOWN', 'RemoteContext ещё не загружен.');
  }
  if (context.topologyMode !== 'PUBLIC') {
    return unavailable('REMOTE_POLICY_BLOCKED', 'POLICY_BLOCKED');
  }
  if (
    context.protocol.selected !== 1 ||
    !['v1-read-only', 'v1-enabled'].includes(context.protocol.mode)
  ) {
    const reason = context.protocol.mode === 'legacy-upgrade-only'
      ? 'LEGACY_UPGRADE_REQUIRED'
      : 'PROTOCOL_INCOMPATIBLE';
    return unavailable('REMOTE_POLICY_BLOCKED', reason);
  }
  if (context.status.transport.state !== 'ONLINE') {
    const reason = contextReason(context, 'transport');
    return unavailable(
      reason === 'AUTH_FAILED' ? 'REMOTE_AUTH_FAILED' : 'REMOTE_OFFLINE',
      reason,
    );
  }
  if (context.status.trust.state !== 'ACTIVE') {
    return unavailable('REMOTE_AUTH_FAILED', contextReason(context, 'trust'));
  }
  if (
    context.status.capability.state === 'UNKNOWN' ||
    context.status.capability.state === 'STALE' ||
    context.status.capability.state === 'INCOMPATIBLE'
  ) {
    return unavailable('REMOTE_NOT_READY', contextReason(context, 'capability'));
  }
  if (Date.parse(context.manifest.validUntil) <= (input.nowMs ?? Date.now())) {
    return unavailable('REMOTE_NOT_READY', 'MANIFEST_STALE');
  }

  const requirement = input.requirement ?? {};
  const transport = requirement.transport ?? 'http';
  if (
    (transport === 'http' && context.killSwitches.http) ||
    (transport === 'ws' && context.killSwitches.ws) ||
    (transport === 'public' && context.killSwitches.publicDelivery)
  ) {
    return unavailable('REMOTE_DISABLED', 'DISABLED', `${transport.toUpperCase()} capability выключена kill switch.`);
  }
  if (context.protocol.mode === 'v1-read-only' && requirement.mutation) {
    return unavailable('REMOTE_POLICY_BLOCKED', 'POLICY_BLOCKED', 'Target работает в read-only режиме.');
  }
  if (requirement.actionId) {
    const capability = context.capabilities[requirement.actionId];
    if (!capability?.enabled) {
      return unavailable('REMOTE_ACTION_UNSUPPORTED', 'CAPABILITY_UNAVAILABLE');
    }
    if (input.role && !capability.roles.includes(input.role as never)) {
      return unavailable('REMOTE_PERMISSION_DENIED', 'POLICY_BLOCKED', 'Роль оператора не разрешена для действия.');
    }
  }
  if (
    requirement.browserReachability &&
    context.status.browser.state !== 'REACHABLE'
  ) {
    return unavailable('REMOTE_BROWSER_UNREACHABLE', 'TARGET_BROWSER_UNREACHABLE');
  }
  return { available: true, code: null, reasonCode: 'READY', message: '' };
}

export function remoteContextNotice(
  context: BrowserRemoteContext | null,
): Readonly<{ code: FederationReasonCode; message: string }> | null {
  if (!context) return { code: 'UNKNOWN', message: 'RemoteContext ещё не загружен.' };
  const blocking = evaluateRemoteCapability({
    isLocal: false,
    context,
    role: null,
  });
  if (!blocking.available) {
    return {
      code: blocking.reasonCode ?? 'UNKNOWN',
      message: blocking.message,
    };
  }
  if (context.protocol.mode === 'v1-read-only') {
    return { code: 'POLICY_BLOCKED', message: 'Target доступен только для чтения.' };
  }
  if (context.status.capability.state === 'PARTIAL') {
    return { code: 'PARTIAL_CAPABILITY', message: REASON_MESSAGES.PARTIAL_CAPABILITY };
  }
  if (context.status.browser.state === 'UNREACHABLE') {
    return {
      code: 'TARGET_BROWSER_UNREACHABLE',
      message: REASON_MESSAGES.TARGET_BROWSER_UNREACHABLE,
    };
  }
  return null;
}
