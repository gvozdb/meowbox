import { Injectable } from '@nestjs/common';
import {
  FederationActionDescriptor,
  HTTP_METHODS,
  HttpMethod,
  RemoteActionCapability,
  resolveConcreteHttpFederationAction,
  resolveFederationAction,
  SocketIoActionTransport,
  SocketIoChannel,
  validateFederationActionMatrix,
} from '@meowbox/shared';
import compiledCatalogue = require('./action-catalogue.generated.json');

interface CompiledActionCatalogue {
  schemaVersion: string;
  matrixSha256: string;
  actions: readonly unknown[];
}

const compiled = compiledCatalogue as CompiledActionCatalogue;
if (!/^[0-9a-f]{64}$/.test(compiled.matrixSha256)) {
  throw new Error('Compiled federation action catalogue hash is invalid');
}

const validatedCatalogue = validateFederationActionMatrix({
  schemaVersion: compiled.schemaVersion,
  actions: compiled.actions,
  legacyUnsafeFindings: [],
});

@Injectable()
export class FederationActionCatalogueService {
  readonly matrixSha256 = compiled.matrixSha256;

  activeActions(): readonly FederationActionDescriptor[] {
    return validatedCatalogue.actions;
  }

  findAction(actionId: string): FederationActionDescriptor | undefined {
    return validatedCatalogue.actions.find((action) => action.actionId === actionId);
  }

  resolveHttpByConcretePath(
    method: string,
    concretePath: string,
  ): FederationActionDescriptor | undefined {
    const matches = this.activeActions().filter((action) =>
      action.transport.kind === 'http' &&
      this.resolveHttp(action.actionId, method, concretePath) !== undefined);
    if (matches.length > 1) {
      throw new Error(`Ambiguous federation action catalogue match for ${method} ${concretePath}`);
    }
    return matches[0];
  }

  resolveHttp(
    actionId: string,
    method: string,
    concretePath: string,
  ): FederationActionDescriptor | undefined {
    const normalizedMethod = method.toUpperCase();
    if (!(HTTP_METHODS as readonly string[]).includes(normalizedMethod)) return undefined;
    return resolveConcreteHttpFederationAction(validatedCatalogue, {
      kind: 'http',
      actionId,
      method: normalizedMethod as HttpMethod,
      concretePath,
    });
  }

  resolveSocket(
    actionId: string,
    channel: SocketIoChannel,
    event: string,
    direction: SocketIoActionTransport['direction'],
  ): FederationActionDescriptor | undefined {
    return resolveFederationAction(validatedCatalogue, {
      kind: 'socket.io',
      actionId,
      channel,
      event,
      direction,
    });
  }

  capabilities(
    enabled: boolean | ((action: FederationActionDescriptor) => boolean),
  ): Readonly<Record<string, RemoteActionCapability>> {
    return Object.fromEntries(this.activeActions().map((action) => {
      const { deadline } = action;
      if (
        typeof deadline.connectMs !== 'number' ||
        typeof deadline.headersMs !== 'number' ||
        typeof deadline.idleMs !== 'number' ||
        typeof deadline.operationMs !== 'number'
      ) throw new Error(`Active federation action ${action.actionId} has incomplete deadlines`);
      return [action.actionId, {
        actionId: action.actionId,
        schemaVersion: 1,
        enabled: typeof enabled === 'function' ? enabled(action) : enabled,
        roles: action.authorization.roles,
        permissions: action.authorization.permissions,
        requestMedia: action.request.media,
        responseMedia: action.response.media,
        executionMode: action.execution.mode,
        idempotency: action.idempotency.policy,
        cancellation: action.cancellation.policy,
        connectMs: deadline.connectMs,
        headersMs: deadline.headersMs,
        idleMs: deadline.idleMs,
        operationMs: deadline.operationMs,
        legacySafe: false,
      } satisfies RemoteActionCapability];
    }));
  }
}
