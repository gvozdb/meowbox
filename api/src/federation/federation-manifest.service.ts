import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  canonicalFederationJson,
  FEDERATION_MANIFEST_SCHEMA_VERSION,
  FEDERATION_PROTOCOL_MODES,
  FEDERATION_PROTOCOL_VERSION,
  FederationManifestEndpointSet,
  FederationProtocolMode,
  SignedFederationManifest,
  validateSignedFederationManifest,
} from '@meowbox/shared';
import {
  signFederationManifestPayload,
} from './federation-key-material';
import {
  LocalPanelIdentity,
  PanelIdentityService,
} from './panel-identity.service';
import { FederationActionCatalogueService } from './federation-action-catalogue.service';
import { FederationLocalEndpointService } from './federation-local-endpoint.service';
import { parseFederationOrigin } from './endpoint-normalizer';
import { federationManifestRevision } from './federation-manifest-verifier.service';

export { canonicalFederationJson } from '@meowbox/shared';

const MANIFEST_TTL_MS = 60_000;

export interface FederationHealth {
  status: 'ok';
  protocolMin: number;
  protocolMax: number;
  manifestSchemaVersion: number;
}

function boundedVersion(config: ConfigService): string {
  const version = String(config.get('MEOWBOX_VERSION', 'unknown')).trim();
  return /^[v0-9A-Za-z.+-]{1,64}$/.test(version) ? version : 'unknown';
}

function protocolMode(config: ConfigService): FederationProtocolMode {
  const mode = String(config.get('FEDERATION_PROTOCOL_MODE', 'disabled'));
  if (!(FEDERATION_PROTOCOL_MODES as readonly string[]).includes(mode)) {
    throw new Error('FEDERATION_PROTOCOL_MODE is invalid');
  }
  return mode as FederationProtocolMode;
}

function unsignedManifest(
  identity: LocalPanelIdentity,
  productVersion: string,
  mode: FederationProtocolMode,
  catalogueSha256: string,
  endpoint: ReturnType<FederationLocalEndpointService['getClaim']>,
  actions: SignedFederationManifest['actions'],
  now: Date,
) {
  const revisionBasis = {
    schemaVersion: FEDERATION_MANIFEST_SCHEMA_VERSION,
    catalogueSha256,
    installationId: identity.installationId,
    installationRole: identity.installationRole,
    protocolMode: mode,
    productVersion,
    protocol: { min: FEDERATION_PROTOCOL_VERSION, max: FEDERATION_PROTOCOL_VERSION },
    acceptedMasterProtocol: { min: FEDERATION_PROTOCOL_VERSION, max: FEDERATION_PROTOCOL_VERSION },
    endpointState: endpoint.state,
    endpoints: endpoint.endpoints,
    actions,
  };
  return {
    ...revisionBasis,
    revision: federationManifestRevision(revisionBasis),
    generatedAt: now.toISOString(),
    validUntil: new Date(now.getTime() + MANIFEST_TTL_MS).toISOString(),
  };
}

@Injectable()
export class FederationManifestService {
  private cached: Readonly<{
    expiresAt: number;
    value: SignedFederationManifest;
  }> | null = null;

  constructor(
    private readonly panelIdentity: PanelIdentityService,
    private readonly config: ConfigService,
    private readonly catalogue: FederationActionCatalogueService,
    private readonly localEndpoint: FederationLocalEndpointService,
  ) {}

  health(): FederationHealth {
    return {
      status: 'ok',
      protocolMin: FEDERATION_PROTOCOL_VERSION,
      protocolMax: FEDERATION_PROTOCOL_VERSION,
      manifestSchemaVersion: FEDERATION_MANIFEST_SCHEMA_VERSION,
    };
  }

  async manifest(now = new Date()): Promise<SignedFederationManifest> {
    if (this.cached && this.cached.expiresAt > now.getTime()) {
      return this.cached.value;
    }
    const identity = await this.panelIdentity.getLocalIdentity();
    const endpoint = identity.installationRole === 'TARGET'
      ? this.localEndpoint.getClaim()
      : { state: 'UNCONFIGURED' as const, endpoints: {} };
    const value = this.signManifest(identity, endpoint, now);
    this.cached = {
      expiresAt: now.getTime() + MANIFEST_TTL_MS,
      value,
    };
    return value;
  }

  async manifestForEndpoint(
    endpoints: FederationManifestEndpointSet,
    now = new Date(),
  ): Promise<SignedFederationManifest> {
    for (const origin of [
      endpoints.apiOrigin,
      endpoints.wsOrigin,
      endpoints.browserPublicOrigin,
      endpoints.directTransferOrigin,
    ]) parseFederationOrigin(origin);
    if (endpoints.apiPath !== '/api') {
      throw new Error('Candidate federation API path is invalid');
    }
    const identity = await this.panelIdentity.getLocalIdentity();
    if (identity.installationRole !== 'TARGET') {
      throw new Error('Candidate manifest can be issued only by a target installation');
    }
    return this.signManifest(identity, { state: 'READY', endpoints }, now);
  }

  invalidateCache(): void {
    this.cached = null;
  }

  private signManifest(
    identity: LocalPanelIdentity,
    endpoint: ReturnType<FederationLocalEndpointService['getClaim']>,
    now: Date,
  ): SignedFederationManifest {
    const mode = protocolMode(this.config);
    const actions = identity.installationRole === 'TARGET'
      ? this.catalogue.capabilities((action) => {
          if (endpoint.state !== 'READY') return false;
          if (mode === 'v1-enabled') return true;
          return mode === 'v1-read-only' &&
            action.transport.kind === 'http' &&
            ['GET', 'HEAD'].includes(action.transport.method) &&
            !action.authorization.roles.includes('SERVICE');
        })
      : {};
    const unsigned = unsignedManifest(
      identity,
      boundedVersion(this.config),
      mode,
      this.catalogue.matrixSha256,
      endpoint,
      actions,
      now,
    );
    const payload = Buffer.from(canonicalFederationJson(unsigned), 'utf8');
    const value = validateSignedFederationManifest({
      ...unsigned,
      signature: {
        algorithm: 'Ed25519',
        kid: identity.manifestKid,
        value: signFederationManifestPayload(payload, {
          installationId: identity.installationId,
          kid: identity.manifestKid,
          publicKeySpki: identity.manifestPublicKeySpki,
          encryptedPrivateKey: identity.manifestPrivateKeyEnc,
        }),
      },
    });
    return value;
  }
}
