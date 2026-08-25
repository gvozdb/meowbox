import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  compareReleaseSemver,
  isReleaseSemver,
  safeErrorMessage,
  type RemoteContext,
} from '@meowbox/shared';
import {
  FederationCompatibilityService,
} from '../federation/federation-compatibility.service';
import {
  FederationDispatcherService,
  type FederationDispatchResponse,
  type MasterFederationActor,
} from '../federation/federation-dispatcher.service';
import { RemoteContextService } from '../federation/remote-context.service';
import { RemoteRegistryService } from '../federation/remote-registry.service';
import {
  FEDERATED_TARGET_UPDATE_ACTIONS,
  hasFederatedTargetUpdateCapabilities,
} from '../federation/federation-update-actions';
import {
  federationResponseData,
  readBoundedFederationJson,
} from '../federation/federation-json-response';
import { ProxyAuditService } from './proxy-audit.service';
import { ProxyService, type ServerConfig } from './proxy.service';

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,128}$/;

export interface FleetUpdateActor extends MasterFederationActor {
  browserIp: string;
  peerIp: string;
  userAgent: string | null;
}

export interface FleetUpdateResult {
  id: string;
  name: string;
  success: boolean;
  federation: boolean;
  trackingPath?: string;
  error?: string;
}

interface FederatedTarget {
  kind: 'FEDERATED';
  id: string;
  name: string;
  version: string | null;
  installationId: string;
  context: RemoteContext;
}

interface LegacyTarget {
  kind: 'LEGACY';
  id: string;
  name: string;
  version: string | null;
  server: ServerConfig;
}

type FleetTarget = FederatedTarget | LegacyTarget;

function targetIdempotencyKey(
  requestKey: string,
  serverId: string,
  version: string,
): string {
  const digest = createHash('sha256')
    .update('MEOWBOX-FLEET-UPDATE-V1\0')
    .update(requestKey)
    .update('\0')
    .update(serverId)
    .update('\0')
    .update(version)
    .digest('hex');
  return `fleet-update-${digest}`;
}

function assertFederatedUpdateReady(context: RemoteContext): void {
  if (
    context.protocol.selected !== 1 ||
    context.protocol.mode !== 'v1-enabled' ||
    context.status.transport.state !== 'ONLINE' ||
    context.status.trust.state !== 'ACTIVE' ||
    !['FRESH', 'PARTIAL'].includes(context.status.capability.state) ||
    context.killSwitches.http ||
    context.topologyMode !== 'PUBLIC'
  ) {
    throw new ServiceUnavailableException('Federated target is not update-ready');
  }
  if (!hasFederatedTargetUpdateCapabilities(context.capabilities)) {
    throw new ServiceUnavailableException(
      `Federated target lacks required update capabilities: ${FEDERATED_TARGET_UPDATE_ACTIONS.join(', ')}`,
    );
  }
}

@Injectable()
export class FederatedFleetUpdateService {
  constructor(
    private readonly proxy: ProxyService,
    private readonly registry: RemoteRegistryService,
    private readonly contexts: RemoteContextService,
    private readonly dispatcher: FederationDispatcherService,
    private readonly compatibility: FederationCompatibilityService,
    private readonly audit: ProxyAuditService,
  ) {}

  async triggerBulk(
    serverIds: readonly string[],
    version: string,
    actor: FleetUpdateActor,
    idempotencyKey?: string,
  ): Promise<{ version: string; results: FleetUpdateResult[] }> {
    const requestKey = idempotencyKey?.trim() ?? '';
    if (!IDEMPOTENCY_KEY.test(requestKey)) {
      throw new BadRequestException(
        'Idempotency-Key must be 8-128 printable ASCII characters',
      );
    }
    if (new Set(serverIds).size !== serverIds.length) {
      throw new BadRequestException('Duplicate server IDs are not allowed');
    }

    const federatedById = new Map(
      (await this.registry.listFederatedServerSummaries()).map((server) => [server.id, server]),
    );
    const federatedIds = new Set(federatedById.keys());
    const resolved = await Promise.all(
      serverIds.map(async (id) => {
        try {
          return { id, target: await this.resolveTarget(id, federatedIds) } as const;
        } catch (error) {
          const federated = federatedById.get(id);
          return {
            id,
            name: federated?.name ?? this.proxy.getServer(id)?.name ?? id,
            federation: !!federated,
            error,
          } as const;
        }
      }),
    );
    const targets: FleetTarget[] = [];
    for (const entry of resolved) {
      if ('target' in entry && entry.target) targets.push(entry.target);
    }
    const knownVersions = targets
      .map((target) => target.version)
      .filter((value): value is string => !!value && isReleaseSemver(value));
    if (knownVersions.length > 0) {
      const maximum = knownVersions.reduce((left, right) =>
        compareReleaseSemver(left, right) >= 0 ? left : right);
      if (compareReleaseSemver(version, maximum) <= 0) {
        throw new BadRequestException(
          `Target version ${version} must be newer than ${maximum}`,
        );
      }
    }

    const resultsById = new Map<string, FleetUpdateResult>();
    for (const entry of resolved) {
      if ('target' in entry) continue;
      resultsById.set(entry.id, {
        id: entry.id,
        name: entry.name,
        success: false,
        federation: entry.federation,
        error: safeErrorMessage(entry.error, 'Update target is unavailable', 512),
      });
    }
    for (const target of targets) {
      try {
        if (target.kind === 'FEDERATED') {
          await this.triggerFederated(
            target,
            version,
            actor,
            targetIdempotencyKey(requestKey, target.id, version),
          );
          resultsById.set(target.id, {
            id: target.id,
            name: target.name,
            success: true,
            federation: true,
            trackingPath: `/api/servers/${target.id}/update-status`,
          });
        } else {
          await this.triggerLegacy(target, version, actor);
          resultsById.set(target.id, {
            id: target.id,
            name: target.name,
            success: true,
            federation: false,
          });
        }
      } catch (error) {
        resultsById.set(target.id, {
          id: target.id,
          name: target.name,
          success: false,
          federation: target.kind === 'FEDERATED',
          error: safeErrorMessage(error, 'Update trigger failed', 512),
        });
      }
    }
    return {
      version,
      results: serverIds.map((id) => resultsById.get(id)!),
    };
  }

  async federatedStatus(
    serverId: string,
    actor: FleetUpdateActor,
  ): Promise<unknown> {
    const target = await this.resolveFederatedTarget(serverId);
    const status = await this.dispatchJson(
      target,
      '/federation/v1/target-update/status',
      'GET',
      undefined,
      actor,
    );
    let manifestVerified = false;
    let manifestReason: string | null = null;
    try {
      const manifest = await this.dispatchJson(
        target,
        '/federation/v1/target-update/manifest',
        'GET',
        undefined,
        actor,
      );
      await this.compatibility.ingestManifest(target.id, manifest);
      manifestVerified = true;
    } catch (error) {
      manifestReason = safeErrorMessage(
        error,
        'Post-update manifest is not verified yet',
        256,
      );
    }
    return { status, manifestVerified, manifestReason };
  }

  private async resolveTarget(
    serverId: string,
    federatedIds: ReadonlySet<string>,
  ): Promise<FleetTarget> {
    if (federatedIds.has(serverId)) return this.resolveFederatedTarget(serverId);

    const legacy = this.proxy.getServer(serverId);
    if (!legacy) throw new NotFoundException(`Server ${serverId} not found`);
    const ping = await this.proxy.pingServer(legacy);
    if (!ping.online) {
      throw new ServiceUnavailableException(`Server ${legacy.name} is offline`);
    }
    return {
      kind: 'LEGACY',
      id: legacy.id,
      name: legacy.name,
      version: ping.version ?? null,
      server: legacy,
    };
  }

  private async resolveFederatedTarget(serverId: string): Promise<FederatedTarget> {
    const route = await this.dispatcher.resolveRouteTarget(serverId);
    if (route.kind !== 'V1') {
      throw new NotFoundException(`Federated server ${serverId} not found`);
    }
    const context = await this.contexts.getRemoteContext(route.serverId);
    assertFederatedUpdateReady(context);
    return {
      kind: 'FEDERATED',
      id: route.serverId,
      name: route.displayName,
      version: context.productVersion || null,
      installationId: route.targetInstallationId,
      context,
    };
  }

  private async triggerFederated(
    target: FederatedTarget,
    version: string,
    actor: FleetUpdateActor,
    idempotencyKey: string,
  ): Promise<void> {
    await this.dispatchJson(
      target,
      '/federation/v1/target-update',
      'POST',
      { version },
      actor,
      idempotencyKey,
    );
  }

  private async triggerLegacy(
    target: LegacyTarget,
    version: string,
    actor: FleetUpdateActor,
  ): Promise<void> {
    const startedAt = Date.now();
    let statusCode: number | null = null;
    let errorMessage: string | null = null;
    try {
      const response = await this.proxy.proxyRequest(
        target.server,
        'POST',
        '/admin/update',
        { version },
      );
      statusCode = response.status;
      if (statusCode < 200 || statusCode >= 300) {
        throw new ServiceUnavailableException(`Legacy update returned HTTP ${statusCode}`);
      }
    } catch (error) {
      errorMessage = safeErrorMessage(error, 'Legacy update failed', 512);
      throw error;
    } finally {
      await this.audit.logOut({
        userId: actor.id,
        serverId: target.id,
        serverName: target.name,
        method: 'POST',
        path: '/admin/update',
        statusCode,
        durationMs: Date.now() - startedAt,
        ipAddress: actor.browserIp,
        peerIp: actor.peerIp,
        browserIp: actor.browserIp,
        userAgent: actor.userAgent,
        errorMsg: errorMessage,
        actorKind: 'OPERATOR',
      });
    }
  }

  private async dispatchJson(
    target: FederatedTarget,
    path: string,
    method: 'GET' | 'POST',
    payload: unknown,
    actor: FleetUpdateActor,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const body = payload === undefined
      ? Buffer.alloc(0)
      : Buffer.from(JSON.stringify(payload), 'utf8');
    const rawHeaders = [
      'accept',
      'application/json',
      ...(payload === undefined ? [] : ['content-type', 'application/json']),
      ...(idempotencyKey ? ['idempotency-key', idempotencyKey] : []),
    ];
    const startedAt = Date.now();
    let response: FederationDispatchResponse | null = null;
    let errorMessage: string | null = null;
    try {
      response = await this.dispatcher.dispatch({
        targetInstallationId: target.installationId,
        inboundTarget: `/api/proxy/${target.installationId}${path}`,
        method,
        rawHeaders,
        body,
        actor: { id: actor.id, role: actor.role },
        browserIp: actor.browserIp,
      });
      const value = await readBoundedFederationJson(
        response.body as unknown as AsyncIterable<Buffer | Uint8Array>,
      );
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new ServiceUnavailableException(
          `Federated target returned HTTP ${response.statusCode}`,
        );
      }
      return federationResponseData(value);
    } catch (error) {
      errorMessage = safeErrorMessage(error, 'Federated update request failed', 512);
      throw error;
    } finally {
      await this.audit.logOut({
        userId: actor.id,
        serverId: target.id,
        serverName: target.name,
        method,
        path: `/api${path}`,
        statusCode: response?.statusCode ?? null,
        durationMs: Date.now() - startedAt,
        ipAddress: actor.browserIp,
        peerIp: actor.peerIp,
        browserIp: actor.browserIp,
        userAgent: actor.userAgent,
        errorMsg: errorMessage,
        requestId: response?.requestId ?? null,
        actionId: response?.actionId ?? null,
        issuerInstallationId: response?.issuerInstallationId ?? null,
        targetInstallationId: response?.targetInstallationId ?? target.installationId,
        keyId: response?.keyId ?? null,
        actorKind: 'OPERATOR',
      });
    }
  }
}
