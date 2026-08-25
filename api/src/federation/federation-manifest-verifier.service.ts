import { Injectable } from '@nestjs/common';
import {
  canonicalFederationJson,
  SignedFederationManifest,
  validateSignedFederationManifest,
} from '@meowbox/shared';
import { createHash } from 'node:crypto';
import { parseFederationOrigin } from './endpoint-normalizer';
import { verifyFederationPayload } from './federation-key-material';

const CLOCK_SKEW_MS = 30_000;

export class FederationManifestVerificationError extends Error {
  constructor(
    readonly code:
      | 'CONTRACT_INVALID'
      | 'IDENTITY_MISMATCH'
      | 'KEY_MISMATCH'
      | 'SIGNATURE_INVALID'
      | 'REVISION_INVALID'
      | 'NOT_CURRENT',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'FederationManifestVerificationError';
  }
}

export interface FederationManifestVerificationInput {
  manifest: unknown;
  targetInstallationId: string;
  manifestKid: string;
  manifestPublicKeySpki: string;
  now?: Date;
}

export function federationManifestRevision(
  manifest: Pick<
    SignedFederationManifest,
    | 'schemaVersion'
    | 'catalogueSha256'
    | 'installationId'
    | 'installationRole'
    | 'protocolMode'
    | 'productVersion'
    | 'protocol'
    | 'acceptedMasterProtocol'
    | 'endpointState'
    | 'endpoints'
    | 'actions'
  >,
): string {
  return createHash('sha256')
    .update(canonicalFederationJson({
      schemaVersion: manifest.schemaVersion,
      catalogueSha256: manifest.catalogueSha256,
      installationId: manifest.installationId,
      installationRole: manifest.installationRole,
      protocolMode: manifest.protocolMode,
      productVersion: manifest.productVersion,
      protocol: manifest.protocol,
      acceptedMasterProtocol: manifest.acceptedMasterProtocol,
      endpointState: manifest.endpointState,
      endpoints: manifest.endpoints,
      actions: manifest.actions,
    }))
    .digest('hex');
}

@Injectable()
export class FederationManifestVerifierService {
  verify(input: FederationManifestVerificationInput): SignedFederationManifest {
    let manifest: SignedFederationManifest;
    try {
      manifest = validateSignedFederationManifest(input.manifest);
    } catch (error) {
      throw new FederationManifestVerificationError(
        'CONTRACT_INVALID',
        'Federation manifest contract is invalid',
        { cause: error },
      );
    }
    if (
      manifest.installationRole !== 'TARGET' ||
      manifest.installationId !== input.targetInstallationId
    ) {
      throw new FederationManifestVerificationError(
        'IDENTITY_MISMATCH',
        'Federation manifest installation identity does not match the enrolled target',
      );
    }
    if (
      manifest.signature.kid !== input.manifestKid ||
      federationManifestRevision(manifest) !== manifest.revision
    ) {
      throw new FederationManifestVerificationError(
        manifest.signature.kid !== input.manifestKid ? 'KEY_MISMATCH' : 'REVISION_INVALID',
        'Federation manifest key or revision does not match the enrolled target',
      );
    }
    const now = (input.now ?? new Date()).getTime();
    if (
      Date.parse(manifest.generatedAt) > now + CLOCK_SKEW_MS ||
      Date.parse(manifest.validUntil) <= now - CLOCK_SKEW_MS
    ) {
      throw new FederationManifestVerificationError(
        'NOT_CURRENT',
        'Federation manifest is outside the accepted time window',
      );
    }
    const { signature, ...unsigned } = manifest;
    if (!verifyFederationPayload(
      Buffer.from(canonicalFederationJson(unsigned), 'utf8'),
      signature.value,
      input.manifestPublicKeySpki,
    )) {
      throw new FederationManifestVerificationError(
        'SIGNATURE_INVALID',
        'Federation manifest signature is invalid',
      );
    }
    if (manifest.endpointState === 'READY') {
      parseFederationOrigin(manifest.endpoints.apiOrigin);
      parseFederationOrigin(manifest.endpoints.wsOrigin);
      parseFederationOrigin(manifest.endpoints.browserPublicOrigin);
      parseFederationOrigin(manifest.endpoints.directTransferOrigin);
    }
    return manifest;
  }
}
