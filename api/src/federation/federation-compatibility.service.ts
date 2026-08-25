import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  FEDERATION_PROTOCOL_VERSION,
  RemoteActionCapability,
  SignedFederationManifest,
  intersectFederationProtocol,
} from '@meowbox/shared';
import { PrismaService } from '../common/prisma.service';
import { federationCapabilityMatchesDescriptor } from './federation-action-policy';
import { FederationActionCatalogueService } from './federation-action-catalogue.service';
import {
  FederationManifestVerificationError,
  FederationManifestVerifierService,
} from './federation-manifest-verifier.service';
import { PanelIdentityService } from './panel-identity.service';

export type FederationActiveEndpoint = Readonly<{
  apiOrigin: string;
  wsOrigin: string;
  wsPath: string;
  browserPublicOrigin: string | null;
  directTransferOrigin: string | null;
}>;

function endpointMatches(
  manifest: SignedFederationManifest,
  endpoint: FederationActiveEndpoint | undefined,
): boolean {
  return manifest.endpointState === 'READY' &&
    !!endpoint &&
    endpoint.apiOrigin === manifest.endpoints.apiOrigin &&
    endpoint.wsOrigin === manifest.endpoints.wsOrigin &&
    endpoint.wsPath === manifest.endpoints.socketPath &&
    endpoint.browserPublicOrigin === manifest.endpoints.browserPublicOrigin &&
    endpoint.directTransferOrigin === manifest.endpoints.directTransferOrigin;
}

export interface FederationManifestEvaluation {
  selectedProtocol: number | null;
  compatible: boolean;
  capabilities: Readonly<Record<string, RemoteActionCapability>>;
  hasMatchingEndpoint: boolean;
  capabilityState: string;
  capabilityReasonCode: string;
  validationState: string;
}

export function evaluateFederationManifest(
  manifest: SignedFederationManifest,
  endpoint: FederationActiveEndpoint | undefined,
  catalogue: FederationActionCatalogueService,
): FederationManifestEvaluation {
  const compatibility = intersectFederationProtocol(
    { min: FEDERATION_PROTOCOL_VERSION, max: FEDERATION_PROTOCOL_VERSION },
    manifest.protocol,
    manifest.acceptedMasterProtocol,
  );
  const capabilities: Record<string, RemoteActionCapability> = {};
  let mismatchedLocalActions = 0;
  for (const descriptor of catalogue.activeActions()) {
    const advertised = manifest.actions[descriptor.actionId];
    if (federationCapabilityMatchesDescriptor(descriptor, advertised)) {
      capabilities[descriptor.actionId] = advertised;
    } else {
      mismatchedLocalActions += 1;
    }
  }
  const hasMatchingEndpoint = endpointMatches(manifest, endpoint);
  const capabilityState = !compatibility.compatible
    ? 'INCOMPATIBLE'
    : mismatchedLocalActions > 0
      ? 'PARTIAL'
      : 'FRESH';
  const capabilityReasonCode = !compatibility.compatible
    ? 'PROTOCOL_INCOMPATIBLE'
    : mismatchedLocalActions > 0
      ? 'PARTIAL_CAPABILITY'
      : Object.values(capabilities).some((capability) => capability.enabled)
        ? 'READY'
        : 'DISABLED';
  const validationState = !compatibility.compatible
    ? 'INCOMPATIBLE'
    : !hasMatchingEndpoint
      ? 'ENDPOINT_MISMATCH'
      : mismatchedLocalActions > 0
        ? 'PARTIAL'
        : 'VALID';
  return {
    selectedProtocol: compatibility.selectedProtocol,
    compatible: compatibility.compatible,
    capabilities,
    hasMatchingEndpoint,
    capabilityState,
    capabilityReasonCode,
    validationState,
  };
}

@Injectable()
export class FederationCompatibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly panelIdentity: PanelIdentityService,
    private readonly verifier: FederationManifestVerifierService,
    private readonly catalogue: FederationActionCatalogueService,
  ) {}

  async ingestManifest(
    remoteServerId: string,
    rawManifest: unknown,
    now = new Date(),
  ): Promise<Readonly<{
    selectedProtocol: number | null;
    validationState: string;
    capabilityState: string;
  }>> {
    const [server, localIdentity] = await Promise.all([
      this.prisma.remoteServer.findUnique({
        where: { id: remoteServerId },
        include: {
          endpoints: { orderBy: { generation: 'desc' } },
          issuers: { include: { keys: true } },
        },
      }),
      this.panelIdentity.getLocalIdentity(),
    ]);
    if (!server) throw new NotFoundException('Remote server not found');
    if (localIdentity.installationRole !== 'MASTER') {
      throw new ConflictException('Manifest ingestion is control-plane only');
    }
    if (
      !server.installationId ||
      !server.targetManifestKid ||
      !server.targetManifestPublicKeySpki ||
      !server.targetManifestPinnedAt
    ) {
      throw new ConflictException('Target manifest identity is not pinned');
    }
    const issuer = server.issuers.find((candidate) =>
      candidate.issuerInstallationId === localIdentity.installationId &&
      candidate.targetInstallationId === server.installationId &&
      candidate.state === 'ACTIVE' &&
      candidate.revokedAt === null &&
      candidate.keys.some((key) =>
        key.state === 'ACTIVE' &&
        key.revokedAt === null &&
        key.encryptedPrivateKey !== null),
    );
    if (!issuer) throw new ConflictException('Target delegation trust is not active');

    let manifest: SignedFederationManifest;
    try {
      manifest = this.verifier.verify({
        manifest: rawManifest,
        targetInstallationId: server.installationId,
        manifestKid: server.targetManifestKid,
        manifestPublicKeySpki: server.targetManifestPublicKeySpki,
        now,
      });
    } catch (error) {
      if (error instanceof FederationManifestVerificationError) {
        await this.prisma.remoteServer.update({
          where: { id: server.id },
          data: {
            capabilityState: 'UNKNOWN',
            capabilityReasonCode: 'MANIFEST_INVALID',
            trustState: error.code === 'NOT_CURRENT' ? server.trustState : 'FAILED',
            trustReasonCode: error.code === 'NOT_CURRENT' ? server.trustReasonCode : 'MANIFEST_INVALID',
            manifestFetchedAt: now,
          },
        });
        throw new ServiceUnavailableException('Target manifest verification failed', {
          cause: error,
        });
      }
      throw error;
    }

    const activeEndpoint = server.endpoints.find((candidate) =>
      candidate.generation === server.activeEndpointGeneration &&
      candidate.state === 'ACTIVE' &&
      candidate.verifiedAt !== null,
    );
    const evaluation = evaluateFederationManifest(manifest, activeEndpoint, this.catalogue);

    await this.prisma.$transaction([
      this.prisma.remoteManifestSnapshot.upsert({
        where: {
          remoteServerId_revision: {
            remoteServerId: server.id,
            revision: manifest.revision,
          },
        },
        create: {
          remoteServerId: server.id,
          schemaVersion: manifest.schemaVersion,
          revision: manifest.revision,
          catalogueSha256: manifest.catalogueSha256,
          protocolMode: manifest.protocolMode,
          protocolMin: manifest.protocol.min,
          protocolMax: manifest.protocol.max,
          acceptedMasterRange: JSON.stringify(manifest.acceptedMasterProtocol),
          capabilitiesJson: JSON.stringify(evaluation.capabilities),
          endpointState: manifest.endpointState,
          endpointsJson: JSON.stringify(manifest.endpoints),
          signingKid: manifest.signature.kid,
          signature: manifest.signature.value,
          validationState: evaluation.validationState,
          generatedAt: new Date(manifest.generatedAt),
          validUntil: new Date(manifest.validUntil),
          fetchedAt: now,
        },
        update: {
          catalogueSha256: manifest.catalogueSha256,
          protocolMode: manifest.protocolMode,
          acceptedMasterRange: JSON.stringify(manifest.acceptedMasterProtocol),
          capabilitiesJson: JSON.stringify(evaluation.capabilities),
          endpointState: manifest.endpointState,
          endpointsJson: JSON.stringify(manifest.endpoints),
          signature: manifest.signature.value,
          validationState: evaluation.validationState,
          generatedAt: new Date(manifest.generatedAt),
          validUntil: new Date(manifest.validUntil),
          fetchedAt: now,
        },
      }),
      this.prisma.remoteServer.update({
        where: { id: server.id },
        data: {
          manifestRevision: manifest.revision,
          productVersion: manifest.productVersion,
          protocolVersion: evaluation.selectedProtocol,
          transportState: evaluation.hasMatchingEndpoint ? 'ONLINE' : 'DEGRADED',
          transportReasonCode: evaluation.hasMatchingEndpoint
            ? 'READY'
            : manifest.endpointState === 'READY'
              ? 'ENDPOINT_CUTOVER'
              : 'CAPABILITY_UNAVAILABLE',
          statusCheckedAt: now,
          transportFreshUntil: new Date(manifest.validUntil),
          trustState: 'ACTIVE',
          trustReasonCode: 'READY',
          trustCheckedAt: now,
          trustFreshUntil: new Date(manifest.validUntil),
          capabilityState: evaluation.capabilityState,
          capabilityReasonCode: evaluation.capabilityReasonCode,
          manifestFetchedAt: now,
        },
      }),
    ]);
    return {
      selectedProtocol: evaluation.selectedProtocol,
      validationState: evaluation.validationState,
      capabilityState: evaluation.capabilityState,
    };
  }
}
