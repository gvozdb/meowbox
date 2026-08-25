import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { FederatedWsChannelAssertion } from '@meowbox/shared';
import { PrismaService } from '../common/prisma.service';
import { MasterFederationActor } from './federation-dispatcher.service';
import {
  federationCapabilityMatchesDescriptor,
} from './federation-action-policy';
import {
  FederationRelationshipKey,
} from './federation-key-material';
import {
  FederationWsChannelClaims,
  issueFederationWsChannelAssertion,
  newFederationWsChannelNonce,
} from './federation-ws-channel';
import { PanelIdentityService } from './panel-identity.service';
import { RemoteContextService } from './remote-context.service';
import {
  FederatedSocketPolicyAction,
  FederatedSocketPolicyService,
} from './federated-socket-policy';
import { intersectFederationPermissions, parseFederationPermissions } from './federation-principal-policy';

export interface IssueFederationWsChannelInput {
  targetInstallationId: string;
  actor: MasterFederationActor;
  browserIp: string;
  epoch: number;
  now?: Date;
}

export interface IssuedFederationWsChannel {
  assertion: FederatedWsChannelAssertion;
  actions: readonly FederatedSocketPolicyAction[];
  endpoint: {
    wsOrigin: string;
    wsPath: string;
    spkiSha256: string;
    caCertificatePem: string | null;
  };
  expiresAt: Date;
}

export class FederationWsIssueError extends Error {
  constructor(
    readonly code:
      | 'REMOTE_NOT_REGISTERED'
      | 'REMOTE_NOT_READY'
      | 'REMOTE_PERMISSION_DENIED'
      | 'REMOTE_AUTH_FAILED',
    message: string,
  ) {
    super(message);
    this.name = FederationWsIssueError.name;
  }
}

const ROLE_RANK: Readonly<Record<'VIEWER' | 'MANAGER' | 'ADMIN', number>> = {
  VIEWER: 1,
  MANAGER: 2,
  ADMIN: 3,
};

@Injectable()
export class FederationWsChannelIssuerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly panelIdentity: PanelIdentityService,
    private readonly contexts: RemoteContextService,
    private readonly policy: FederatedSocketPolicyService,
  ) {}

  async issue(input: IssueFederationWsChannelInput): Promise<IssuedFederationWsChannel> {
    const now = input.now ?? new Date();
    if (!Number.isSafeInteger(input.epoch) || input.epoch < 1) {
      throw new FederationWsIssueError('REMOTE_NOT_READY', 'Federation WS epoch is invalid');
    }
    const server = await this.prisma.remoteServer.findUnique({
      where: { installationId: input.targetInstallationId },
      include: {
        endpoints: { orderBy: { generation: 'desc' } },
        issuers: { include: { keys: { orderBy: { validFrom: 'desc' } } } },
      },
    });
    if (!server) {
      throw new FederationWsIssueError('REMOTE_NOT_REGISTERED', 'Remote target is not registered');
    }
    const context = await this.contexts.getRemoteContext(server.id);
    if (
      context.topologyMode !== 'PUBLIC' ||
      context.killSwitches.ws ||
      context.protocol.selected !== 1 ||
      !['v1-read-only', 'v1-enabled'].includes(context.protocol.mode) ||
      context.status.transport.state !== 'ONLINE' ||
      context.status.trust.state !== 'ACTIVE' ||
      context.status.capability.state !== 'FRESH' ||
      Date.parse(context.manifest.validUntil) <= now.getTime()
    ) {
      throw new FederationWsIssueError('REMOTE_NOT_READY', 'Remote target is not ready for delegated WebSocket');
    }
    const identity = await this.panelIdentity.getLocalIdentity();
    if (identity.installationRole !== 'MASTER') {
      throw new FederationWsIssueError('REMOTE_AUTH_FAILED', 'Federation WS issuer requires a master installation');
    }
    const issuer = server.issuers.find((candidate) =>
      candidate.issuerInstallationId === identity.installationId &&
      candidate.targetInstallationId === input.targetInstallationId &&
      candidate.state === 'ACTIVE' &&
      candidate.revokedAt === null);
    const key = issuer?.keys.find((candidate) =>
      candidate.state === 'ACTIVE' &&
      candidate.revokedAt === null &&
      candidate.validFrom <= now &&
      (candidate.expiresAt === null || candidate.expiresAt > now) &&
      candidate.encryptedPrivateKey !== null);
    if (!issuer || !key?.encryptedPrivateKey) {
      throw new FederationWsIssueError('REMOTE_AUTH_FAILED', 'Remote federation trust is unavailable');
    }
    if (
      !(issuer.maxRole in ROLE_RANK) ||
      !(input.actor.role in ROLE_RANK) ||
      ROLE_RANK[input.actor.role] > ROLE_RANK[issuer.maxRole as keyof typeof ROLE_RANK]
    ) {
      throw new FederationWsIssueError('REMOTE_PERMISSION_DENIED', 'Operator exceeds federation role ceiling');
    }

    const issuerPermissions = parseFederationPermissions(
      issuer.permissionPolicyJson,
      'Federation issuer permission policy',
    );
    const actions = this.policy.actionsForRole(input.actor.role).filter((action) => {
      const capability = context.capabilities[action.actionId];
      if (!capability?.enabled || !federationCapabilityMatchesDescriptor(action.descriptor, capability)) {
        return false;
      }
      return action.descriptor.authorization.permissions.every((permission) =>
        issuerPermissions.has(permission));
    });
    if (actions.length === 0) {
      throw new FederationWsIssueError('REMOTE_PERMISSION_DENIED', 'No delegated WebSocket action is available');
    }
    const assertedPermissions = [...new Set(actions.flatMap((action) =>
      [...action.descriptor.authorization.permissions]))].sort();
    const effectivePermissions = intersectFederationPermissions(
      assertedPermissions,
      issuerPermissions,
      new Set(assertedPermissions),
    );
    if (effectivePermissions.length !== assertedPermissions.length) {
      throw new FederationWsIssueError('REMOTE_PERMISSION_DENIED', 'Federation WS permission policy is incomplete');
    }

    const endpoint = server.endpoints.find((candidate) =>
      candidate.generation === server.activeEndpointGeneration &&
      candidate.state === 'ACTIVE' &&
      candidate.verifiedAt !== null);
    if (!endpoint) {
      throw new FederationWsIssueError('REMOTE_NOT_READY', 'Remote WebSocket endpoint is unavailable');
    }
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    const claims: FederationWsChannelClaims = {
      keyId: key.kid,
      channelId: randomUUID(),
      targetInstallationId: input.targetInstallationId,
      issuerInstallationId: identity.installationId,
      actorKind: 'OPERATOR',
      subject: input.actor.id,
      browserIp: input.browserIp,
      role: input.actor.role,
      permissions: effectivePermissions,
      principalVersion: issuer.principalVersion,
      epoch: input.epoch,
      nonce: newFederationWsChannelNonce(),
      actionIds: actions.map((action) => action.actionId).sort(),
      issuedAt: nowSeconds,
      expiresAt: nowSeconds + 60,
    };
    const relationship: FederationRelationshipKey = {
      issuerInstallationId: identity.installationId,
      targetInstallationId: input.targetInstallationId,
      kid: key.kid,
      publicKeySpki: key.publicKeySpki,
      encryptedPrivateKey: key.encryptedPrivateKey,
    };
    return {
      assertion: issueFederationWsChannelAssertion(claims, relationship),
      actions,
      endpoint: {
        wsOrigin: endpoint.wsOrigin,
        wsPath: endpoint.wsPath,
        spkiSha256: endpoint.spkiSha256,
        caCertificatePem: endpoint.caCertificatePem,
      },
      expiresAt: new Date(claims.expiresAt * 1_000),
    };
  }
}
