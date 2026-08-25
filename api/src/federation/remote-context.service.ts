import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  FEDERATION_REASON_CODES,
  FederationProtocolMode,
  RemoteActionCapability,
  RemoteContext,
  toBrowserRemoteContext,
  validateRemoteContext,
} from '@meowbox/shared';
import { PrismaService } from '../common/prisma.service';

const MODE_MAP: Readonly<Record<string, FederationProtocolMode>> = {
  DISABLED: 'disabled',
  OBSERVE: 'observe',
  V1_READ_ONLY: 'v1-read-only',
  V1_ENABLED: 'v1-enabled',
  LEGACY_UPGRADE_ONLY: 'legacy-upgrade-only',
};

function parseJsonObject<T>(raw: string, label: string): T {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ServiceUnavailableException(`${label} is invalid`); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ServiceUnavailableException(`${label} is invalid`);
  }
  return value as T;
}

function reasonCode(value: string | null): RemoteContext['status']['transport']['reasonCode'] {
  return value && (FEDERATION_REASON_CODES as readonly string[]).includes(value)
    ? value as RemoteContext['status']['transport']['reasonCode']
    : 'UNKNOWN';
}

function observed(value: Date | null, fallback: Date): string {
  return (value ?? fallback).toISOString();
}

@Injectable()
export class RemoteContextService {
  constructor(private readonly prisma: PrismaService) {}

  async getRemoteContext(serverId: string): Promise<RemoteContext> {
    const server = await this.prisma.remoteServer.findUnique({
      where: { id: serverId },
      include: {
        endpoints: { orderBy: { generation: 'desc' } },
        manifests: { orderBy: { fetchedAt: 'desc' }, take: 1 },
      },
    });
    if (!server) throw new NotFoundException('Remote server not found');
    const endpoint = server.endpoints.find(
      ({ generation, state }) => generation === server.activeEndpointGeneration && state === 'ACTIVE',
    );
    if (
      !server.installationId ||
      !endpoint ||
      !endpoint.verifiedAt ||
      !endpoint.browserPublicOrigin ||
      !endpoint.directTransferOrigin
    ) {
      throw new ServiceUnavailableException('Remote server has no verified canonical endpoint');
    }
    const manifest = server.manifests[0];
    const acceptedMaster = manifest
      ? parseJsonObject<{ min: number; max: number }>(manifest.acceptedMasterRange, 'Accepted master range')
      : { min: 1, max: 1 };
    const capabilities = manifest
      ? parseJsonObject<Record<string, RemoteActionCapability>>(manifest.capabilitiesJson, 'Remote capabilities')
      : {};
    const statusObservedAt = observed(server.statusCheckedAt, server.updatedAt);
    const manifestValidUntil = manifest?.validUntil ?? server.updatedAt;
    const mode = MODE_MAP[server.activationMode] ?? 'disabled';
    const context: RemoteContext = {
      serverId: server.id,
      targetInstallationId: server.installationId,
      displayName: server.displayName,
      registryGeneration: server.registryGeneration,
      contextEpoch: server.registryGeneration,
      endpoints: {
        apiOrigin: endpoint.apiOrigin,
        apiPath: '/api',
        wsOrigin: endpoint.wsOrigin,
        socketPath: endpoint.wsPath,
        browserPublicOrigin: endpoint.browserPublicOrigin,
        directTransferOrigin: endpoint.directTransferOrigin,
        sshHost: endpoint.sshHost,
        sshPort: endpoint.sshPort,
      },
      productVersion: server.productVersion ?? 'unknown',
      protocol: {
        mode,
        selected: server.protocolVersion,
        target: manifest
          ? { min: manifest.protocolMin, max: manifest.protocolMax }
          : { min: 1, max: 1 },
        acceptedMaster,
      },
      manifest: {
        schemaVersion: manifest?.schemaVersion ?? 1,
        revision: manifest?.revision ?? 'unavailable',
        validUntil: manifestValidUntil.toISOString(),
      },
      capabilities,
      status: {
        transport: {
          state: server.transportState as RemoteContext['status']['transport']['state'],
          reasonCode: reasonCode(server.transportReasonCode ?? server.reasonCode),
          observedAt: statusObservedAt,
          freshUntil: server.transportFreshUntil?.toISOString() ?? null,
        },
        trust: {
          state: server.trustState as RemoteContext['status']['trust']['state'],
          reasonCode: reasonCode(server.trustReasonCode ?? server.reasonCode),
          observedAt: observed(server.trustCheckedAt, server.updatedAt),
          freshUntil: server.trustFreshUntil?.toISOString() ?? null,
        },
        capability: {
          state: server.capabilityState as RemoteContext['status']['capability']['state'],
          reasonCode: reasonCode(server.capabilityReasonCode ?? server.reasonCode),
          observedAt: observed(server.manifestFetchedAt, server.updatedAt),
          freshUntil: manifest?.validUntil.toISOString() ?? null,
        },
        browser: {
          state: server.browserState as RemoteContext['status']['browser']['state'],
          reasonCode: reasonCode(server.browserReasonCode ?? server.reasonCode),
          observedAt: observed(server.browserCheckedAt, server.updatedAt),
          freshUntil: server.browserFreshUntil?.toISOString() ?? null,
        },
      },
      topologyMode: server.topologyMode as RemoteContext['topologyMode'],
      killSwitches: {
        http: !server.httpEnabled,
        ws: !server.wsEnabled,
        publicDelivery: !server.publicEnabled,
        legacy: !server.legacyEnabled,
      },
    };
    try {
      return validateRemoteContext(context);
    } catch (error) {
      throw new ServiceUnavailableException('Remote context failed contract validation', {
        cause: error,
      });
    }
  }

  async getBrowserContext(serverId: string) {
    return toBrowserRemoteContext(await this.getRemoteContext(serverId));
  }
}
