import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import {
  assertActiveIssuer,
  assertFederationIdentityBinding,
  FederationIdentityBinding,
  FederationPrincipalError,
  intersectFederationPermissions,
  parseFederationPermissions,
} from './federation-principal-policy';

const ACTION_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9_-]+)+$/;

export interface ResolveServicePrincipalInput extends FederationIdentityBinding {
  actionId: string;
  permissions: readonly string[];
}

export interface ResolvedServicePrincipal {
  servicePrincipalId: string;
  issuerId: string;
  subject: string;
  purposeNamespace: string;
  effectivePermissions: readonly string[];
  principalVersion: number;
}

@Injectable()
export class ServicePrincipalService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveVerifiedService(
    input: ResolveServicePrincipalInput,
  ): Promise<ResolvedServicePrincipal> {
    assertFederationIdentityBinding(input);
    if (!ACTION_ID.test(input.actionId)) {
      throw new FederationPrincipalError(
        'INVALID_IDENTITY',
        'Federation service action is invalid',
      );
    }
    const issuer = await this.prisma.federationIssuer.findUnique({
      where: {
        issuerInstallationId_targetInstallationId: {
          issuerInstallationId: input.issuerInstallationId,
          targetInstallationId: input.targetInstallationId,
        },
      },
      select: {
        id: true,
        state: true,
        revokedAt: true,
        principalVersion: true,
        permissionPolicyJson: true,
      },
    });
    if (!issuer) {
      throw new FederationPrincipalError(
        'ISSUER_NOT_ACTIVE',
        'Federation issuer is not enrolled',
      );
    }
    assertActiveIssuer(issuer, input.principalVersion);

    const principal = await this.prisma.servicePrincipal.findUnique({
      where: { issuerId_subject: { issuerId: issuer.id, subject: input.subject } },
    });
    if (!principal) {
      throw new FederationPrincipalError(
        'SERVICE_NOT_ENROLLED',
        'Federation service principal is not enrolled',
      );
    }
    if (
      principal.state !== 'ACTIVE' ||
      principal.deactivatedAt !== null ||
      principal.principalVersion !== input.principalVersion
    ) {
      throw new FederationPrincipalError(
        'PRINCIPAL_STATE_INVALID',
        'Federation service principal is not active',
      );
    }
    if (
      input.actionId !== principal.purposeNamespace &&
      !input.actionId.startsWith(`${principal.purposeNamespace}.`)
    ) {
      throw new FederationPrincipalError(
        'SERVICE_SCOPE_DENIED',
        'Federation service action is outside its purpose',
      );
    }

    const issuerPermissions = parseFederationPermissions(
      issuer.permissionPolicyJson,
      'Federation issuer permission policy',
    );
    const principalPermissions = parseFederationPermissions(
      principal.permissionsJson,
      'Federation service permission policy',
    );
    const effectivePermissions = intersectFederationPermissions(
      input.permissions,
      issuerPermissions,
      principalPermissions,
    );
    await this.prisma.servicePrincipal.update({
      where: { id: principal.id },
      data: { lastSeenAt: new Date() },
      select: { id: true },
    });
    return {
      servicePrincipalId: principal.id,
      issuerId: issuer.id,
      subject: principal.subject,
      purposeNamespace: principal.purposeNamespace,
      effectivePermissions,
      principalVersion: principal.principalVersion,
    };
  }
}
