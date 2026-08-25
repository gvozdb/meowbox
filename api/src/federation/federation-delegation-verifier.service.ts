import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import {
  decodeDelegationClaims,
  DelegationRequestBinding,
  EncodedDelegationAssertion,
  verifyDelegationAssertion,
} from './delegation-envelope';
import { FederationActionCatalogueService } from './federation-action-catalogue.service';
import { assertDelegatedActionPolicy } from './federation-action-policy';
import { FederatedPrincipalService } from './federated-principal.service';
import { FederationReplayService } from './federation-replay.service';
import { PanelIdentityService } from './panel-identity.service';
import { ServicePrincipalService } from './service-principal.service';
import { VerifiedFederationContext } from './federation-request-context';
import {
  federationRequestHash,
  FederationIdempotencyService,
} from './federation-idempotency.service';

const ASSERTION_CLOCK_SKEW_SECONDS = 30;
const MINIMUM_REPLAY_RETENTION_MS = 120_000;

export interface VerifyFederationDelegationInput {
  encoded: EncodedDelegationAssertion;
  binding: DelegationRequestBinding;
  concretePath: string;
  idempotencyKey: string | null;
  now?: Date;
}

export class FederationDelegationVerificationError extends Error {
  constructor(
    readonly code:
      | 'TARGET_ROLE_INVALID'
      | 'ISSUER_NOT_FOUND'
      | 'KEY_NOT_ACTIVE'
      | 'TARGET_PRIVATE_KEY_PRESENT'
      | 'ACTION_DENIED'
      | 'SERVICE_PERMISSION_DENIED',
    message: string,
  ) {
    super(message);
    this.name = 'FederationDelegationVerificationError';
  }
}

@Injectable()
export class FederationDelegationVerifierService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly panelIdentity: PanelIdentityService,
    private readonly catalogue: FederationActionCatalogueService,
    private readonly replay: FederationReplayService,
    private readonly idempotency: FederationIdempotencyService,
    private readonly operators: FederatedPrincipalService,
    private readonly services: ServicePrincipalService,
  ) {}

  async verify(input: VerifyFederationDelegationInput): Promise<VerifiedFederationContext> {
    const now = input.now ?? new Date();
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    const untrustedClaims = decodeDelegationClaims(input.encoded.assertion);
    const identity = await this.panelIdentity.getLocalIdentity();
    if (identity.installationRole !== 'TARGET') {
      throw new FederationDelegationVerificationError(
        'TARGET_ROLE_INVALID',
        'Federated data actions are accepted only by target installations',
      );
    }

    const key = await this.prisma.federationKey.findUnique({
      where: { kid: untrustedClaims.keyId },
      include: { issuer: true },
    });
    if (
      !key ||
      key.issuer.issuerInstallationId !== untrustedClaims.issuerInstallationId ||
      key.issuer.targetInstallationId !== identity.installationId
    ) {
      throw new FederationDelegationVerificationError('ISSUER_NOT_FOUND', 'Federation issuer is not enrolled');
    }
    if (
      key.state !== 'ACTIVE' ||
      key.revokedAt !== null ||
      key.validFrom.getTime() > now.getTime() ||
      (key.expiresAt !== null && key.expiresAt.getTime() <= now.getTime())
    ) {
      throw new FederationDelegationVerificationError('KEY_NOT_ACTIVE', 'Federation key is not active');
    }
    if (key.encryptedPrivateKey !== null) {
      throw new FederationDelegationVerificationError(
        'TARGET_PRIVATE_KEY_PRESENT',
        'Target federation verifier cannot retain a delegation private key',
      );
    }

    const claims = verifyDelegationAssertion(input.encoded, input.binding, {
      expectedIssuerInstallationId: key.issuer.issuerInstallationId,
      expectedTargetInstallationId: identity.installationId,
      expectedKeyId: key.kid,
      publicKeySpki: key.publicKeySpki,
      nowSeconds,
      clockSkewSeconds: ASSERTION_CLOCK_SKEW_SECONDS,
    });
    const descriptor = this.catalogue.resolveHttp(
      claims.actionId,
      input.binding.method,
      input.concretePath,
    );
    if (!descriptor) {
      throw new FederationDelegationVerificationError('ACTION_DENIED', 'Federation action is not active');
    }
    let effectivePermissions = assertDelegatedActionPolicy({
      descriptor,
      claims,
      issuerMaxRole: key.issuer.maxRole,
      issuerPermissionPolicyJson: key.issuer.permissionPolicyJson,
      idempotencyKey: input.idempotencyKey,
    });

    const replayExpiresAt = new Date(Math.max(
      (claims.expiresAt + ASSERTION_CLOCK_SKEW_SECONDS) * 1_000,
      now.getTime() + MINIMUM_REPLAY_RETENTION_MS,
    ));
    const replayHash = await this.replay.consume({
      issuerId: key.issuer.id,
      kid: key.kid,
      requestId: claims.requestId,
      actionId: claims.actionId,
      nonce: claims.nonce,
      expiresAt: replayExpiresAt,
      now,
    });

    let userId: string | null = null;
    let principalId: string;
    if (claims.actorKind === 'OPERATOR') {
      const principal = await this.operators.resolveVerifiedOperator({
        issuerInstallationId: claims.issuerInstallationId,
        targetInstallationId: claims.targetInstallationId,
        subject: claims.subject,
        principalVersion: claims.principalVersion,
      });
      userId = principal.userId;
      principalId = principal.principalId;
    } else {
      const principal = await this.services.resolveVerifiedService({
        issuerInstallationId: claims.issuerInstallationId,
        targetInstallationId: claims.targetInstallationId,
        subject: claims.subject,
        principalVersion: claims.principalVersion,
        actionId: claims.actionId,
        permissions: claims.permissions,
      });
      effectivePermissions = principal.effectivePermissions;
      if (descriptor.authorization.permissions.some(
        (permission) => !effectivePermissions.includes(permission),
      )) {
        throw new FederationDelegationVerificationError(
          'SERVICE_PERMISSION_DENIED',
          'Service principal policy does not satisfy the action',
        );
      }
      principalId = principal.servicePrincipalId;
    }

    const idempotencyReceiptId = input.idempotencyKey === null
      ? null
      : await this.idempotency.claim({
          issuerId: key.issuer.id,
          actorKind: claims.actorKind,
          subject: claims.subject,
          actionId: claims.actionId,
          idempotencyKey: input.idempotencyKey,
          requestId: claims.requestId,
          requestHash: federationRequestHash(input.binding),
          now,
        });

    return {
      verified: true,
      requestId: claims.requestId,
      actionId: claims.actionId,
      targetInstallationId: claims.targetInstallationId,
      issuerInstallationId: claims.issuerInstallationId,
      issuerId: key.issuer.id,
      keyId: key.kid,
      actorKind: claims.actorKind,
      subject: claims.subject,
      browserIp: claims.browserIp,
      role: claims.role,
      principalVersion: claims.principalVersion,
      effectivePermissions,
      descriptor,
      userId,
      principalId,
      operationId: claims.operationId,
      idempotencyKey: input.idempotencyKey,
      idempotencyReceiptId,
      replayHash,
    };
  }
}
