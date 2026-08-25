export const SERVICE_OPERATION_ACTIONS = {
  SERVER_INSTALL: 'services.server.install',
  SERVER_UNINSTALL: 'services.server.uninstall',
  SERVER_RESTART: 'services.server.restart',
  SITE_ENABLE: 'services.site.enable',
  SITE_DISABLE: 'services.site.disable',
  SITE_START: 'services.site.start',
  SITE_STOP: 'services.site.stop',
  SITE_RECONFIGURE: 'services.site.reconfigure',
} as const;

export const SERVICE_AGENT_JOB_ACTIONS = {
  SERVER_INSTALL: 'agent.services.server.install',
  SERVER_UNINSTALL: 'agent.services.server.uninstall',
  SERVER_RESTART: 'agent.services.server.restart',
  SITE_ENABLE: 'agent.services.site.enable',
  SITE_DISABLE: 'agent.services.site.disable',
  SITE_START: 'agent.services.site.start',
  SITE_STOP: 'agent.services.site.stop',
  SITE_RECONFIGURE: 'agent.services.site.reconfigure',
} as const;

export type ServiceOperationAction =
  (typeof SERVICE_OPERATION_ACTIONS)[keyof typeof SERVICE_OPERATION_ACTIONS];
export type ServiceAgentJobAction =
  (typeof SERVICE_AGENT_JOB_ACTIONS)[keyof typeof SERVICE_AGENT_JOB_ACTIONS];

const OPERATION_TO_AGENT = new Map<ServiceOperationAction, ServiceAgentJobAction>([
  [SERVICE_OPERATION_ACTIONS.SERVER_INSTALL, SERVICE_AGENT_JOB_ACTIONS.SERVER_INSTALL],
  [SERVICE_OPERATION_ACTIONS.SERVER_UNINSTALL, SERVICE_AGENT_JOB_ACTIONS.SERVER_UNINSTALL],
  [SERVICE_OPERATION_ACTIONS.SERVER_RESTART, SERVICE_AGENT_JOB_ACTIONS.SERVER_RESTART],
  [SERVICE_OPERATION_ACTIONS.SITE_ENABLE, SERVICE_AGENT_JOB_ACTIONS.SITE_ENABLE],
  [SERVICE_OPERATION_ACTIONS.SITE_DISABLE, SERVICE_AGENT_JOB_ACTIONS.SITE_DISABLE],
  [SERVICE_OPERATION_ACTIONS.SITE_START, SERVICE_AGENT_JOB_ACTIONS.SITE_START],
  [SERVICE_OPERATION_ACTIONS.SITE_STOP, SERVICE_AGENT_JOB_ACTIONS.SITE_STOP],
  [SERVICE_OPERATION_ACTIONS.SITE_RECONFIGURE, SERVICE_AGENT_JOB_ACTIONS.SITE_RECONFIGURE],
]);

const SERVER_SERVICE_KEYS = new Set([
  'fail2ban',
  'manticore',
  'mariadb',
  'minio',
  'postfix',
  'postgresql',
  'redis',
  'ssh',
]);
const UNINSTALLABLE_SERVICE_KEYS = new Set(
  [...SERVER_SERVICE_KEYS].filter((key) => key !== 'ssh'),
);
const RESTARTABLE_SERVICE_KEYS = new Set([
  'fail2ban',
  'mariadb',
  'postfix',
  'postgresql',
  'ssh',
]);
const SITE_SERVICE_KEYS = new Set(['manticore', 'minio', 'redis']);
const SITE_LIFECYCLE_KEYS = new Set(['manticore', 'redis']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SITE_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;
const SYSTEM_USER = /^[a-z_][a-z0-9_-]{0,31}$/;

export interface ServiceJobSite {
  id: string;
  name: string;
  systemUser: string;
  rootPath: string;
}

export interface ServiceAgentJobPayload {
  serviceKey: string;
  site?: ServiceJobSite;
  config?: Record<string, unknown>;
}

export interface ServiceAgentCall {
  event: string;
  payload: unknown;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  label = 'value',
): void {
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new Error(`${label} has invalid fields`);
  }
}

function serviceKey(value: unknown, allowed: ReadonlySet<string>): string {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new Error('Service job key is not allowed for this action');
  }
  return value;
}

function site(value: unknown): ServiceJobSite {
  const raw = object(value, 'Service job site');
  exactKeys(raw, ['id', 'name', 'rootPath', 'systemUser'], [], 'Service job site');
  if (typeof raw.id !== 'string' || !UUID.test(raw.id)) {
    throw new Error('Service job site id is invalid');
  }
  if (typeof raw.name !== 'string' || !SITE_NAME.test(raw.name)) {
    throw new Error('Service job site name is invalid');
  }
  if (typeof raw.systemUser !== 'string' || !SYSTEM_USER.test(raw.systemUser)) {
    throw new Error('Service job system user is invalid');
  }
  if (
    typeof raw.rootPath !== 'string' ||
    !raw.rootPath.startsWith('/') ||
    raw.rootPath.length > 4096 ||
    /[\0\r\n]/.test(raw.rootPath) ||
    raw.rootPath.split('/').includes('..')
  ) {
    throw new Error('Service job root path is invalid');
  }
  return raw as unknown as ServiceJobSite;
}

export function serviceMemoryMaxMb(service: string, value: unknown): number {
  const limits = service === 'manticore'
    ? { min: 32, max: 4096, fallback: 128 }
    : service === 'redis'
      ? { min: 16, max: 4096, fallback: 64 }
      : null;
  if (!limits) throw new Error('Service does not support a memory limit');
  if (value === undefined) return limits.fallback;
  if (!Number.isInteger(value) || (value as number) < limits.min || (value as number) > limits.max) {
    throw new Error('Service memory limit is invalid');
  }
  return value as number;
}

function config(value: unknown, key: string): Record<string, unknown> {
  const raw = value === undefined ? {} : object(value, 'Service job config');
  if (key === 'manticore' || key === 'redis') {
    exactKeys(raw, [], ['memoryMaxMb'], 'Service job config');
    serviceMemoryMaxMb(key, raw.memoryMaxMb);
    return raw;
  }
  exactKeys(raw, [], [], 'Service job config');
  return raw;
}

export function serviceAgentActionForOperation(
  actionId: string,
): ServiceAgentJobAction {
  const result = OPERATION_TO_AGENT.get(actionId as ServiceOperationAction);
  if (!result) throw new Error('Service operation action is not supported');
  return result;
}

export function resolveServiceAgentCall(
  actionId: string,
  input: unknown,
): ServiceAgentCall {
  const raw = object(input, 'Service agent job payload');

  if (
    actionId === SERVICE_AGENT_JOB_ACTIONS.SERVER_INSTALL ||
    actionId === SERVICE_AGENT_JOB_ACTIONS.SERVER_UNINSTALL ||
    actionId === SERVICE_AGENT_JOB_ACTIONS.SERVER_RESTART
  ) {
    exactKeys(raw, ['serviceKey'], [], 'Service agent job payload');
    const allowed = actionId === SERVICE_AGENT_JOB_ACTIONS.SERVER_UNINSTALL
      ? UNINSTALLABLE_SERVICE_KEYS
      : actionId === SERVICE_AGENT_JOB_ACTIONS.SERVER_RESTART
        ? RESTARTABLE_SERVICE_KEYS
        : SERVER_SERVICE_KEYS;
    const key = serviceKey(raw.serviceKey, allowed);
    if (actionId === SERVICE_AGENT_JOB_ACTIONS.SERVER_RESTART) {
      return { event: 'services:restart-server', payload: { serviceKey: key } };
    }
    const suffix = actionId === SERVICE_AGENT_JOB_ACTIONS.SERVER_INSTALL
      ? 'server-install'
      : 'server-uninstall';
    return { event: `${key}:${suffix}`, payload: {} };
  }

  const requiresConfig =
    actionId === SERVICE_AGENT_JOB_ACTIONS.SITE_ENABLE ||
    actionId === SERVICE_AGENT_JOB_ACTIONS.SITE_RECONFIGURE;
  exactKeys(
    raw,
    ['serviceKey', 'site', ...(requiresConfig ? ['config'] : [])],
    [],
    'Service agent job payload',
  );
  const allowed =
    actionId === SERVICE_AGENT_JOB_ACTIONS.SITE_START ||
    actionId === SERVICE_AGENT_JOB_ACTIONS.SITE_STOP ||
    actionId === SERVICE_AGENT_JOB_ACTIONS.SITE_RECONFIGURE
      ? SITE_LIFECYCLE_KEYS
      : SITE_SERVICE_KEYS;
  const key = serviceKey(raw.serviceKey, allowed);
  const target = site(raw.site);
  const cfg = requiresConfig ? config(raw.config, key) : {};

  if (actionId === SERVICE_AGENT_JOB_ACTIONS.SITE_ENABLE) {
    if (key === 'minio') {
      return {
        event: 'minio:site-enable',
        payload: {
          siteId: target.id,
          siteName: target.name,
          systemUser: target.systemUser,
          rootPath: target.rootPath,
        },
      };
    }
    return {
      event: `${key}:site-enable`,
      payload: {
        siteName: target.name,
        systemUser: target.systemUser,
        rootPath: target.rootPath,
        memoryMaxMb: serviceMemoryMaxMb(key, cfg.memoryMaxMb),
      },
    };
  }
  if (actionId === SERVICE_AGENT_JOB_ACTIONS.SITE_DISABLE) {
    return key === 'minio'
      ? {
          event: 'minio:site-disable',
          payload: { siteId: target.id, siteName: target.name, rootPath: target.rootPath },
        }
      : {
          event: `${key}:site-disable`,
          payload: {
            siteName: target.name,
            systemUser: target.systemUser,
            rootPath: target.rootPath,
          },
        };
  }
  if (actionId === SERVICE_AGENT_JOB_ACTIONS.SITE_START) {
    return { event: `${key}:site-start`, payload: { siteName: target.name } };
  }
  if (actionId === SERVICE_AGENT_JOB_ACTIONS.SITE_STOP) {
    return { event: `${key}:site-stop`, payload: { siteName: target.name } };
  }
  if (actionId === SERVICE_AGENT_JOB_ACTIONS.SITE_RECONFIGURE) {
    return {
      event: `${key}:site-reconfigure`,
      payload: {
        siteName: target.name,
        memoryMaxMb: serviceMemoryMaxMb(key, cfg.memoryMaxMb),
      },
    };
  }
  throw new Error('Service agent job action is not supported');
}
