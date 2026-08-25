import { Injectable } from '@nestjs/common';
import { FederationActionDescriptor } from '@meowbox/shared';
import policyDocument = require('./federated-socket-policy.json');
import { FederationActionCatalogueService } from './federation-action-catalogue.service';

export type FederatedSocketRole = 'ADMIN' | 'MANAGER';
export type FederatedSocketReadiness = 'REQUIRE_READY' | 'QUEUE_SUBSCRIPTION';
export type FederatedSocketDirection = 'browser_to_api' | 'api_to_browser';

export interface FederatedSocketPolicyAction {
  event: string;
  actionId: string;
  roles: readonly FederatedSocketRole[];
  direction: FederatedSocketDirection;
  readiness: FederatedSocketReadiness | null;
  descriptor: FederationActionDescriptor;
}

interface PolicyEntry {
  event: string;
  roles: readonly FederatedSocketRole[];
  readiness?: FederatedSocketReadiness;
}

interface PolicyDocument {
  schemaVersion: string;
  browserToApi: readonly PolicyEntry[];
  apiToBrowser: readonly PolicyEntry[];
}

const EVENT = /^[a-z][a-z0-9]*(?::[a-z0-9_-]+)+$/;
const ALLOWED_ROLES = new Set<FederatedSocketRole>(['ADMIN', 'MANAGER']);
const READINESS = new Set<FederatedSocketReadiness>(['REQUIRE_READY', 'QUEUE_SUBSCRIPTION']);

function actionId(channel: 'browser-command' | 'browser-notification', event: string): string {
  return `ws.${channel}.${event.replace(/:/g, '-').replace(/_/g, '-')}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} payload must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(
  value: Record<string, unknown>,
  key: string,
  max = 4_096,
  optional = false,
): void {
  const field = value[key];
  if (optional && field === undefined) return;
  if (typeof field !== 'string' || field.length === 0 || field.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(field)) {
    throw new Error(`Socket payload field ${key} is invalid`);
  }
}

function numberField(
  value: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): void {
  const field = value[key];
  if (typeof field !== 'number' || !Number.isFinite(field) || field < min || field > max) {
    throw new Error(`Socket payload field ${key} is invalid`);
  }
}

function validateCommandPayload(event: string, payload: unknown): void {
  const value = record(payload, event);
  switch (event) {
    case 'ai:start':
      stringField(value, 'prompt', 50_000);
      stringField(value, 'cwd', 4_096, true);
      stringField(value, 'sessionId', 128, true);
      return;
    case 'ai:message':
      stringField(value, 'sessionId', 128);
      stringField(value, 'message', 50_000);
      return;
    case 'ai:stop':
      if (Object.keys(value).length !== 0) throw new Error('ai:stop payload must be empty');
      return;
    case 'logs:tail:start':
      stringField(value, 'source', 4_096);
      stringField(value, 'type', 64);
      return;
    case 'logs:tail:stop':
      stringField(value, 'tailId', 128);
      return;
    case 'php:install:subscribe':
    case 'php:install:unsubscribe':
      if (typeof value.version !== 'string' || !/^\d+\.\d+$/.test(value.version)) {
        throw new Error('PHP version is invalid');
      }
      return;
    case 'php:ext-install:subscribe':
    case 'php:ext-install:unsubscribe':
      if (typeof value.version !== 'string' || !/^\d+\.\d+$/.test(value.version) ||
        typeof value.name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value.name)) {
        throw new Error('PHP extension subscription is invalid');
      }
      return;
    case 'terminal:open':
      stringField(value, 'user', 64, true);
      return;
    case 'terminal:input':
      stringField(value, 'sessionId', 128);
      stringField(value, 'data', 64 * 1_024);
      return;
    case 'terminal:resize':
      stringField(value, 'sessionId', 128);
      numberField(value, 'cols', 1, 1_000);
      numberField(value, 'rows', 1, 1_000);
      return;
    case 'terminal:close':
      stringField(value, 'sessionId', 128);
      return;
    default:
      throw new Error(`Unknown federated Socket.IO command: ${event}`);
  }
}

function validateNotificationPayload(event: string, payload: unknown): void {
  const value = record(payload, event);
  if (event.startsWith('ai:')) {
    if (value.type !== event.slice(3)) throw new Error('AI event discriminant mismatch');
    return;
  }
  switch (event) {
    case 'backup:progress':
      stringField(value, 'backupId', 128);
      numberField(value, 'progress', 0, 100);
      return;
    case 'backup:restore:progress':
      stringField(value, 'backupId', 128);
      stringField(value, 'restoreId', 128);
      numberField(value, 'progress', 0, 100);
      return;
    case 'logs:tail:data':
      stringField(value, 'tailId', 128);
      stringField(value, 'line', 256 * 1_024);
      return;
    case 'php:install:log':
      stringField(value, 'version', 16);
      stringField(value, 'line', 256 * 1_024);
      return;
    case 'php:ext-install:log':
      stringField(value, 'version', 16);
      stringField(value, 'name', 64);
      stringField(value, 'line', 256 * 1_024);
      return;
    case 'site:deploy:log':
      stringField(value, 'deployLogId', 128);
      stringField(value, 'line', 256 * 1_024);
      return;
    case 'site:provision:done':
      stringField(value, 'siteId', 128);
      stringField(value, 'status', 64);
      return;
    case 'site:provision:log':
      stringField(value, 'siteId', 128);
      stringField(value, 'level', 16);
      stringField(value, 'line', 256 * 1_024);
      return;
    case 'site:status':
      stringField(value, 'siteId', 128);
      stringField(value, 'status', 64);
      stringField(value, 'previousStatus', 64);
      return;
    case 'system:metrics':
      return;
    case 'terminal:data':
      stringField(value, 'sessionId', 128);
      stringField(value, 'data', 256 * 1_024);
      return;
    default:
      throw new Error(`Unknown federated Socket.IO notification: ${event}`);
  }
}

function assertEntry(
  entry: PolicyEntry,
  direction: FederatedSocketDirection,
): void {
  if (
    !entry ||
    typeof entry !== 'object' ||
    typeof entry.event !== 'string' ||
    !EVENT.test(entry.event) ||
    !Array.isArray(entry.roles) ||
    entry.roles.length === 0 ||
    new Set(entry.roles).size !== entry.roles.length ||
    entry.roles.some((role) => !ALLOWED_ROLES.has(role)) ||
    (direction === 'browser_to_api'
      ? !entry.readiness || !READINESS.has(entry.readiness)
      : entry.readiness !== undefined)
  ) throw new Error(`Invalid federated Socket.IO policy entry: ${String(entry?.event)}`);
}

@Injectable()
export class FederatedSocketPolicyService {
  private readonly commands: readonly FederatedSocketPolicyAction[];
  private readonly notifications: readonly FederatedSocketPolicyAction[];
  private readonly byActionId: ReadonlyMap<string, FederatedSocketPolicyAction>;

  constructor(catalogue: FederationActionCatalogueService) {
    const document = policyDocument as PolicyDocument;
    if (
      document.schemaVersion !== 'meowbox.federated-socket-policy/v1' ||
      !Array.isArray(document.browserToApi) ||
      !Array.isArray(document.apiToBrowser)
    ) throw new Error('Federated Socket.IO policy document is invalid');

    const seenEvents = new Set<string>();
    const compile = (
      entries: readonly PolicyEntry[],
      channel: 'browser-command' | 'browser-notification',
      direction: FederatedSocketDirection,
    ): FederatedSocketPolicyAction[] => entries.map((entry) => {
      assertEntry(entry, direction);
      const eventKey = `${direction}\0${entry.event}`;
      if (seenEvents.has(eventKey)) throw new Error(`Duplicate federated Socket.IO event: ${entry.event}`);
      seenEvents.add(eventKey);
      const id = actionId(channel, entry.event);
      const descriptor = catalogue.resolveSocket(id, channel, entry.event, direction);
      if (!descriptor) throw new Error(`Federated Socket.IO action is absent from catalogue: ${id}`);
      if (
        descriptor.authorization.roles.length !== entry.roles.length ||
        descriptor.authorization.roles.some((role, index) => role !== entry.roles[index])
      ) throw new Error(`Federated Socket.IO role policy drift: ${id}`);
      return {
        event: entry.event,
        actionId: id,
        roles: Object.freeze([...entry.roles]),
        direction,
        readiness: entry.readiness ?? null,
        descriptor,
      };
    });

    this.commands = Object.freeze(compile(
      document.browserToApi,
      'browser-command',
      'browser_to_api',
    ));
    this.notifications = Object.freeze(compile(
      document.apiToBrowser,
      'browser-notification',
      'api_to_browser',
    ));
    this.byActionId = new Map(
      [...this.commands, ...this.notifications].map((entry) => [entry.actionId, entry]),
    );
  }

  actionsForRole(role: string): readonly FederatedSocketPolicyAction[] {
    if (!ALLOWED_ROLES.has(role as FederatedSocketRole)) return [];
    return [...this.commands, ...this.notifications].filter((action) =>
      action.roles.includes(role as FederatedSocketRole));
  }

  commandForEvent(event: string, role: string): FederatedSocketPolicyAction | undefined {
    return this.commands.find((action) => action.event === event &&
      action.roles.includes(role as FederatedSocketRole));
  }

  notificationForEvent(event: string, role: string): FederatedSocketPolicyAction | undefined {
    return this.notifications.find((action) => action.event === event &&
      action.roles.includes(role as FederatedSocketRole));
  }

  actionById(actionIdValue: string): FederatedSocketPolicyAction | undefined {
    return this.byActionId.get(actionIdValue);
  }

  allCommands(): readonly FederatedSocketPolicyAction[] {
    return this.commands;
  }

  allNotifications(): readonly FederatedSocketPolicyAction[] {
    return this.notifications;
  }

  validatePayload(action: FederatedSocketPolicyAction, payload: unknown): void {
    if (action.direction === 'browser_to_api') validateCommandPayload(action.event, payload);
    else validateNotificationPayload(action.event, payload);
  }
}
