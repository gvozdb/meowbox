import { Injectable } from '@nestjs/common';
import { FederatedWsChannelAssertion } from '@meowbox/shared';
import { PrismaService } from '../common/prisma.service';
import { FederatedPrincipalService } from './federated-principal.service';
import { FederationReplayService } from './federation-replay.service';
import {
  decodeFederationWsChannelClaims,
  FederationWsChannelClaims,
  verifyFederationWsChannelAssertion,
} from './federation-ws-channel';
import { PanelIdentityService } from './panel-identity.service';
import {
  FederatedSocketPolicyAction,
  FederatedSocketPolicyService,
} from './federated-socket-policy';
import { intersectFederationPermissions, parseFederationPermissions } from './federation-principal-policy';
import { FederationManifestService } from './federation-manifest.service';
import { federationCapabilityMatchesDescriptor } from './federation-action-policy';

const CLOCK_SKEW_SECONDS = 30;
const MINIMUM_REPLAY_RETENTION_MS = 120_000;
const ROLE_RANK: Readonly<Record<'VIEWER' | 'MANAGER' | 'ADMIN', number>> = {
  VIEWER: 1,
  MANAGER: 2,
  ADMIN: 3,
};

export interface VerifiedFederationWsChannel {
  claims: FederationWsChannelClaims;
  issuerId: string;
  keyId: string;
  userId: string;
  principalId: string;
  actions: readonly FederatedSocketPolicyAction[];
  effectivePermissions: readonly string[];
  replayHash: string;
}

export class FederationWsVerificationError extends Error {
  constructor(
    readonly code:
      | 'TARGET_ROLE_INVALID'
      | 'ISSUER_NOT_FOUND'
      | 'KEY_NOT_ACTIVE'
      | 'TARGET_PRIVATE_KEY_PRESENT'
      | 'ACTION_DENIED'
      | 'ROLE_DENIED'
      | 'PERMISSION_DENIED',
    message: string,
  ) {
    super(message);
    this.name = FederationWsVerificationError.name;
  }
}

@Injectable()
export class FederationWsChannelVerifierService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly panelIdentity: PanelIdentityService,
    private readonly policy: FederatedSocketPolicyService,
    private readonly replay: FederationReplayService,
    private readonly operators: FederatedPrincipalService,
    private readonly manifestService: FederationManifestService,
  ) {}

  async verify(
    assertion: FederatedWsChannelAssertion,
    now = new Date(),
  ): Promise<VerifiedFederationWsChannel> {
    const untrusted = decodeFederationWsChannelClaims(assertion.assertion);
    const identity = await this.panelIdentity.getLocalIdentity();
    if (identity.installationRole !== 'TARGET') {
      throw new FederationWsVerificationError(
        'TARGET_ROLE_INVALID',
        'Federated WebSocket channels are accepted only by target installations',
      );
    }
    const key = await this.prisma.federationKey.findUnique({
      where: { kid: untrusted.keyId },
      include: { issuer: true },
    });
    if (
      !key ||
      key.issuer.issuerInstallationId !== untrusted.issuerInstallationId ||
      key.issuer.targetInstallationId !== identity.installationId ||
      key.issuer.state !== 'ACTIVE' ||
      key.issuer.revokedAt !== null
    ) throw new FederationWsVerificationError('ISSUER_NOT_FOUND', 'Federation issuer is not enrolled');
    if (
      key.state !== 'ACTIVE' ||
      key.revokedAt !== null ||
      key.validFrom > now ||
      (key.expiresAt !== null && key.expiresAt <= now)
    ) throw new FederationWsVerificationError('KEY_NOT_ACTIVE', 'Federation key is not active');
    if (key.encryptedPrivateKey !== null) {
      throw new FederationWsVerificationError(
        'TARGET_PRIVATE_KEY_PRESENT',
        'Target federation verifier cannot retain a delegation private key',
      );
    }
    const claims = verifyFederationWsChannelAssertion(assertion, {
      expectedIssuerInstallationId: key.issuer.issuerInstallationId,
      expectedTargetInstallationId: identity.installationId,
      expectedKeyId: key.kid,
      publicKeySpki: key.publicKeySpki,
      nowSeconds: Math.floor(now.getTime() / 1_000),
      clockSkewSeconds: CLOCK_SKEW_SECONDS,
    });
    if (claims.actorKind !== 'OPERATOR' || !(claims.role in ROLE_RANK) || claims.role === 'VIEWER') {
      throw new FederationWsVerificationError('ROLE_DENIED', 'Federation WS requires an operator role');
    }
    const operatorRole = claims.role as 'ADMIN' | 'MANAGER';
    if (
      !(key.issuer.maxRole in ROLE_RANK) ||
      ROLE_RANK[operatorRole] > ROLE_RANK[key.issuer.maxRole as keyof typeof ROLE_RANK]
    ) throw new FederationWsVerificationError('ROLE_DENIED', 'Delegated role exceeds issuer ceiling');

    const manifest = await this.manifestService.manifest(now);
    if (manifest.protocolMode !== 'v1-enabled' || manifest.endpointState !== 'READY') {
      throw new FederationWsVerificationError('ACTION_DENIED', 'Federation WS is disabled on target');
    }
    const actions = claims.actionIds.map((actionId) => {
      const action = this.policy.actionById(actionId);
      const capability = manifest.actions[actionId];
      if (
        !action ||
        !action.roles.includes(claims.role as 'ADMIN' | 'MANAGER') ||
        !capability?.enabled ||
        !federationCapabilityMatchesDescriptor(action.descriptor, capability)
      ) {
        throw new FederationWsVerificationError('ACTION_DENIED', 'Federation WS action is denied');
      }
      return action;
    });
    const requiredPermissions = [...new Set(actions.flatMap((action) =>
      [...action.descriptor.authorization.permissions]))].sort();
    if (
      claims.permissions.length !== requiredPermissions.length ||
      claims.permissions.some((permission, index) => permission !== requiredPermissions[index])
    ) throw new FederationWsVerificationError('PERMISSION_DENIED', 'Federation WS permission set is not least privilege');
    const effectivePermissions = intersectFederationPermissions(
      claims.permissions,
      parseFederationPermissions(key.issuer.permissionPolicyJson, 'Federation issuer permission policy'),
      new Set(requiredPermissions),
    );
    if (effectivePermissions.length !== requiredPermissions.length) {
      throw new FederationWsVerificationError('PERMISSION_DENIED', 'Federation WS permission policy is incomplete');
    }

    const replayHash = await this.replay.consume({
      issuerId: key.issuer.id,
      kid: key.kid,
      requestId: claims.channelId,
      actionId: 'federation.ws-channel',
      nonce: claims.nonce,
      expiresAt: new Date(Math.max(
        (claims.expiresAt + CLOCK_SKEW_SECONDS) * 1_000,
        now.getTime() + MINIMUM_REPLAY_RETENTION_MS,
      )),
      now,
    });
    const principal = await this.operators.resolveVerifiedOperator({
      issuerInstallationId: claims.issuerInstallationId,
      targetInstallationId: claims.targetInstallationId,
      subject: claims.subject,
      principalVersion: claims.principalVersion,
    });
    return {
      claims,
      issuerId: key.issuer.id,
      keyId: key.kid,
      userId: principal.userId,
      principalId: principal.principalId,
      actions,
      effectivePermissions,
      replayHash,
    };
  }
}
