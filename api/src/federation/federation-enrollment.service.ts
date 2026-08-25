import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { FederationActionCatalogueService } from './federation-action-catalogue.service';
import { enrollmentProofHash } from './federation-enrollment-bootstrap';
import { EstablishFederationTrustDto } from './federation-enrollment.dto';
import { federationKeyIdFromPublicKeySpki } from './federation-key-material';
import { PanelIdentityService } from './panel-identity.service';
import {
  FEDERATED_VPN_FRAGMENT_ACTION_ID,
  FEDERATED_VPN_SERVICE_PURPOSE,
  FEDERATED_VPN_SERVICE_SUBJECT,
} from '../vpn/federated-vpn.constants';
import {
  FEDERATED_WEBHOOK_DELIVERY_ACTION_ID,
  FEDERATED_WEBHOOK_SERVICE_PURPOSE,
  FEDERATED_WEBHOOK_SERVICE_SUBJECT,
} from '../webhooks/webhook.constants';

const MAX_BOOTSTRAP_TTL_MS = 10 * 60_000;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface PrepareTargetEnrollmentInput {
  enrollmentId?: string;
  requestedDisplayName: string;
  sshHost: string;
  sshPort: number;
  sshFingerprint: string;
  proof: Buffer;
  expiresAt: Date;
}

function cleanDisplayName(value: string): string {
  const normalized = value.trim();
  if (!/^[\p{L}\p{N} _.-]{2,64}$/u.test(normalized)) {
    throw new Error('Enrollment display name is invalid');
  }
  return normalized;
}

function cleanSshHost(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 253 ||
    !/^[A-Za-z0-9.:-]+$/.test(normalized)
  ) throw new Error('Enrollment SSH host is invalid');
  return normalized;
}

function cleanSshFingerprint(value: string): string {
  if (!/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(value)) {
    throw new Error('Enrollment SSH fingerprint is invalid');
  }
  return value;
}

@Injectable()
export class FederationEnrollmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly panelIdentity: PanelIdentityService,
    private readonly catalogue: FederationActionCatalogueService,
  ) {}

  async prepareTargetBootstrap(
    input: PrepareTargetEnrollmentInput,
    now = new Date(),
  ): Promise<Readonly<{ id: string; state: string; expiresAt: string }>> {
    const identity = await this.panelIdentity.getLocalIdentity();
    if (identity.installationRole !== 'TARGET') {
      throw new ConflictException('Enrollment bootstrap can be prepared only on a target');
    }
    if (
      (input.enrollmentId !== undefined && !CANONICAL_UUID.test(input.enrollmentId)) ||
      !Number.isInteger(input.sshPort) ||
      input.sshPort < 1 ||
      input.sshPort > 65535 ||
      input.expiresAt.getTime() <= now.getTime() ||
      input.expiresAt.getTime() - now.getTime() > MAX_BOOTSTRAP_TTL_MS
    ) throw new ConflictException('Enrollment bootstrap bounds are invalid');
    const bootstrapHash = enrollmentProofHash(input.proof);
    if (input.enrollmentId) {
      const byId = await this.prisma.federationEnrollment.findUnique({
        where: { id: input.enrollmentId },
      });
      if (byId) {
        if (
          byId.enrollmentRole !== 'TARGET_BOOTSTRAP' ||
          !['SSH_VERIFIED', 'MANIFEST_PENDING'].includes(byId.state) ||
          byId.targetInstallationId !== identity.installationId ||
          byId.sshFingerprint !== cleanSshFingerprint(input.sshFingerprint)
        ) throw new ConflictException('Enrollment bootstrap cannot be reused');
        const collision = await this.prisma.federationEnrollment.findUnique({
          where: { bootstrapHash },
          select: { id: true },
        });
        if (collision && collision.id !== byId.id) {
          throw new ConflictException('Enrollment bootstrap cannot be reused');
        }
        const rotated = await this.prisma.federationEnrollment.update({
          where: { id: byId.id },
          data: { bootstrapHash, expiresAt: input.expiresAt },
        });
        return {
          id: rotated.id,
          state: rotated.state,
          expiresAt: rotated.expiresAt.toISOString(),
        };
      }
    }
    const existing = await this.prisma.federationEnrollment.findUnique({
      where: { bootstrapHash },
    });
    if (existing) {
      if (
        existing.enrollmentRole !== 'TARGET_BOOTSTRAP' ||
        existing.state !== 'SSH_VERIFIED' ||
        existing.expiresAt.getTime() <= now.getTime()
      ) throw new ConflictException('Enrollment bootstrap cannot be reused');
      return {
        id: existing.id,
        state: existing.state,
        expiresAt: existing.expiresAt.toISOString(),
      };
    }
    const active = await this.prisma.federationEnrollment.count({
      where: {
        enrollmentRole: 'TARGET_BOOTSTRAP',
        state: { in: ['SSH_VERIFIED', 'TRUST_ESTABLISHED', 'MANIFEST_PENDING'] },
        expiresAt: { gt: now },
      },
    });
    if (active >= 4) throw new ConflictException('Too many active enrollment bootstraps');
    const created = await this.prisma.federationEnrollment.create({
      data: {
        id: input.enrollmentId,
        enrollmentRole: 'TARGET_BOOTSTRAP',
        requestedDisplayName: cleanDisplayName(input.requestedDisplayName),
        state: 'SSH_VERIFIED',
        sshHost: cleanSshHost(input.sshHost),
        sshPort: input.sshPort,
        sshFingerprint: cleanSshFingerprint(input.sshFingerprint),
        bootstrapHash,
        targetInstallationId: identity.installationId,
        expiresAt: input.expiresAt,
      },
    });
    return {
      id: created.id,
      state: created.state,
      expiresAt: created.expiresAt.toISOString(),
    };
  }

  async establishTrust(
    enrollmentId: string | undefined,
    proof: Buffer,
    input: EstablishFederationTrustDto,
    now = new Date(),
  ) {
    if (!enrollmentId) throw new UnauthorizedException('Federation enrollment denied');
    const identity = await this.panelIdentity.getLocalIdentity();
    if (identity.installationRole !== 'TARGET') {
      throw new UnauthorizedException('Federation enrollment denied');
    }
    try {
      if (
        input.issuerInstallationId === identity.installationId ||
        federationKeyIdFromPublicKeySpki(input.publicKeySpki) !== input.keyId
      ) throw new Error('key mismatch');
    } catch {
      throw new UnauthorizedException('Federation enrollment denied');
    }

    const allowedPermissions = new Set(
      this.catalogue.activeActions().flatMap((action) => action.authorization.permissions),
    );
    const permissions = [...new Set(input.permissions)].sort();
    if (
      permissions.length !== input.permissions.length ||
      permissions.some((permission) => !allowedPermissions.has(permission))
    ) throw new UnauthorizedException('Federation enrollment denied');

    try {
      await this.prisma.$transaction(async (tx) => {
        const enrollment = await tx.federationEnrollment.findUnique({
          where: { id: enrollmentId },
        });
        if (
          !enrollment ||
          enrollment.enrollmentRole !== 'TARGET_BOOTSTRAP' ||
          enrollment.bootstrapHash !== enrollmentProofHash(proof) ||
          !['SSH_VERIFIED', 'MANIFEST_PENDING'].includes(enrollment.state) ||
          enrollment.expiresAt.getTime() <= now.getTime() ||
          enrollment.targetInstallationId !== identity.installationId ||
          enrollment.sshFingerprint !== input.sshFingerprint
        ) throw new UnauthorizedException('Federation enrollment denied');
        const existingIssuer = await tx.federationIssuer.findUnique({
          where: {
            issuerInstallationId_targetInstallationId: {
              issuerInstallationId: input.issuerInstallationId,
              targetInstallationId: identity.installationId,
            },
          },
        });

        if (enrollment.state === 'MANIFEST_PENDING') {
          const existingKey = existingIssuer && await tx.federationKey.findUnique({
            where: { kid: input.keyId },
          });
          if (
            !existingIssuer ||
            existingIssuer.state !== 'ACTIVE' ||
            existingIssuer.maxRole !== input.maxRole ||
            existingIssuer.principalVersion !== input.principalVersion ||
            existingIssuer.permissionPolicyJson !== JSON.stringify(permissions) ||
            !existingKey ||
            existingKey.issuerId !== existingIssuer.id ||
            existingKey.publicKeySpki !== input.publicKeySpki ||
            existingKey.encryptedPrivateKey !== null ||
            existingKey.state !== 'ACTIVE'
          ) throw new UnauthorizedException('Federation enrollment denied');
          await this.ensureServicePrincipals(
            tx,
            existingIssuer.id,
            input.principalVersion,
            permissions,
          );
          return;
        }

        const consumed = await tx.federationEnrollment.updateMany({
          where: {
            id: enrollment.id,
            enrollmentRole: 'TARGET_BOOTSTRAP',
            state: 'SSH_VERIFIED',
            expiresAt: { gt: now },
          },
          data: { state: 'TRUST_ESTABLISHED' },
        });
        if (consumed.count !== 1 || existingIssuer) {
          throw new UnauthorizedException('Federation enrollment denied');
        }
        const createdIssuer = await tx.federationIssuer.create({
          data: {
            issuerInstallationId: input.issuerInstallationId,
            targetInstallationId: identity.installationId,
            state: 'ACTIVE',
            maxRole: input.maxRole,
            permissionPolicyJson: JSON.stringify(permissions),
            principalVersion: input.principalVersion,
            keys: {
              create: {
                kid: input.keyId,
                publicKeySpki: input.publicKeySpki,
                encryptedPrivateKey: null,
                state: 'ACTIVE',
                validFrom: now,
              },
            },
          },
        });
        await this.ensureServicePrincipals(
          tx,
          createdIssuer.id,
          input.principalVersion,
          permissions,
        );
        await tx.federationEnrollment.update({
          where: { id: enrollment.id },
          data: {
            state: 'MANIFEST_PENDING',
            delegationIssuerId: createdIssuer.id,
          },
        });
      });
    } catch (error) {
      if (
        error instanceof UnauthorizedException ||
        error instanceof ConflictException
      ) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Federation trust already exists');
      }
      throw error;
    }
    return {
      enrollmentId,
      state: 'MANIFEST_PENDING',
      target: {
        installationId: identity.installationId,
        manifestKid: identity.manifestKid,
        manifestPublicKeySpki: identity.manifestPublicKeySpki,
      },
      healthPath: '/api/federation/v1/health',
      manifestPath: '/api/federation/v1/manifest',
    } as const;
  }

  private async ensureServicePrincipals(
    tx: Prisma.TransactionClient,
    issuerId: string,
    principalVersion: number,
    issuerPermissions: readonly string[],
  ): Promise<void> {
    const services = [
      {
        actionId: FEDERATED_VPN_FRAGMENT_ACTION_ID,
        subject: FEDERATED_VPN_SERVICE_SUBJECT,
        purpose: FEDERATED_VPN_SERVICE_PURPOSE,
      },
      {
        actionId: FEDERATED_WEBHOOK_DELIVERY_ACTION_ID,
        subject: FEDERATED_WEBHOOK_SERVICE_SUBJECT,
        purpose: FEDERATED_WEBHOOK_SERVICE_PURPOSE,
      },
    ] as const;
    for (const service of services) {
      if (!issuerPermissions.includes(service.actionId)) continue;
      await this.ensureServicePrincipal(tx, issuerId, principalVersion, service);
    }
  }

  private async ensureServicePrincipal(
    tx: Prisma.TransactionClient,
    issuerId: string,
    principalVersion: number,
    service: Readonly<{ actionId: string; subject: string; purpose: string }>,
  ): Promise<void> {
    const permissionsJson = JSON.stringify([service.actionId]);
    const existing = await tx.servicePrincipal.findUnique({
      where: {
        issuerId_subject: {
          issuerId,
          subject: service.subject,
        },
      },
    });
    if (existing) {
      if (
        existing.state !== 'ACTIVE' ||
        existing.deactivatedAt !== null ||
        existing.principalVersion !== principalVersion ||
        existing.purposeNamespace !== service.purpose ||
        existing.permissionsJson !== permissionsJson
      ) throw new UnauthorizedException('Federation enrollment denied');
      return;
    }
    await tx.servicePrincipal.create({
      data: {
        issuerId,
        subject: service.subject,
        purposeNamespace: service.purpose,
        principalVersion,
        permissionsJson,
        state: 'ACTIVE',
      },
    });
  }

  async completeTargetBootstrap(
    enrollmentId: string | undefined,
    proof: Buffer,
    requestedEnrollmentId: string,
    now = new Date(),
  ): Promise<Readonly<{ state: 'COMPLETED' }>> {
    if (!enrollmentId || enrollmentId !== requestedEnrollmentId) {
      throw new UnauthorizedException('Federation enrollment denied');
    }
    const updated = await this.prisma.federationEnrollment.updateMany({
      where: {
        id: enrollmentId,
        enrollmentRole: 'TARGET_BOOTSTRAP',
        bootstrapHash: enrollmentProofHash(proof),
        state: 'MANIFEST_PENDING',
        expiresAt: { gt: now },
      },
      data: {
        state: 'COMPLETED',
        completedAt: now,
      },
    });
    if (updated.count !== 1) {
      throw new UnauthorizedException('Federation enrollment denied');
    }
    return { state: 'COMPLETED' };
  }

  async cancelTargetBootstrap(
    enrollmentId: string | undefined,
    proof: Buffer,
    requestedEnrollmentId: string,
    now = new Date(),
  ): Promise<Readonly<{ state: 'CANCELLED' }>> {
    if (!enrollmentId || enrollmentId !== requestedEnrollmentId) {
      throw new UnauthorizedException('Federation enrollment denied');
    }
    const enrollment = await this.prisma.federationEnrollment.findFirst({
      where: {
        id: enrollmentId,
        enrollmentRole: 'TARGET_BOOTSTRAP',
        bootstrapHash: enrollmentProofHash(proof),
        state: { in: ['SSH_VERIFIED', 'MANIFEST_PENDING'] },
        expiresAt: { gt: now },
      },
    });
    if (!enrollment) throw new UnauthorizedException('Federation enrollment denied');

    await this.prisma.$transaction(async (tx) => {
      if (enrollment.delegationIssuerId) {
        await tx.federationKey.updateMany({
          where: { issuerId: enrollment.delegationIssuerId, revokedAt: null },
          data: { state: 'REVOKED', revokedAt: now },
        });
        await tx.federationIssuer.updateMany({
          where: { id: enrollment.delegationIssuerId, revokedAt: null },
          data: { state: 'REVOKED', revokedAt: now },
        });
      }
      const cancelled = await tx.federationEnrollment.updateMany({
        where: {
          id: enrollment.id,
          state: { in: ['SSH_VERIFIED', 'MANIFEST_PENDING'] },
        },
        data: { state: 'CANCELLED', expiresAt: now, completedAt: now },
      });
      if (cancelled.count !== 1) {
        throw new UnauthorizedException('Federation enrollment denied');
      }
    });
    return { state: 'CANCELLED' };
  }
}
