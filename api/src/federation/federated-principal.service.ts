import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { hashPassword } from '../common/crypto/argon2.helper';
import { PrismaService } from '../common/prisma.service';
import {
  assertActiveIssuer,
  assertFederationIdentityBinding,
  FederationIdentityBinding,
  FederationPrincipalError,
} from './federation-principal-policy';

const FEDERATED_IDENTITY_KIND = 'FEDERATED';
const FEDERATED_STORED_ROLE = 'MANAGER';
const MAX_CREATE_ATTEMPTS = 3;

export interface ResolveFederatedOperatorInput extends FederationIdentityBinding {
  displayLabel?: string | null;
}

export interface ResolvedFederatedOperator {
  userId: string;
  principalId: string;
  issuerId: string;
  subject: string;
  principalVersion: number;
}

function isRetryableCreateConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2002' || error.code === 'P2034');
}

function normalizeDisplayLabel(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim() === '') return null;
  const normalized = value.trim();
  if (normalized.length > 128 || /[\x00-\x1f\x7f]/.test(normalized)) {
    throw new FederationPrincipalError(
      'INVALID_IDENTITY',
      'Federation principal label is invalid',
    );
  }
  return normalized;
}

function reservedIdentity(input: ResolveFederatedOperatorInput): {
  username: string;
  email: string;
} {
  const digest = createHash('sha256')
    .update(input.issuerInstallationId)
    .update('\0')
    .update(input.subject)
    .update('\0')
    .update(randomBytes(16))
    .digest('base64url');
  return {
    username: `__meowbox_federated_${digest}`,
    email: `federated+${digest}@federation.invalid`,
  };
}

@Injectable()
export class FederatedPrincipalService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveVerifiedOperator(
    input: ResolveFederatedOperatorInput,
  ): Promise<ResolvedFederatedOperator> {
    assertFederationIdentityBinding(input);
    const displayLabel = normalizeDisplayLabel(input.displayLabel);
    const passwordHash = await hashPassword(randomBytes(32).toString('base64url'));

    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      const identity = reservedIdentity(input);
      try {
        return await this.prisma.$transaction(async (transaction) => {
          const issuer = await transaction.federationIssuer.findUnique({
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
            },
          });
          if (!issuer) {
            throw new FederationPrincipalError(
              'ISSUER_NOT_ACTIVE',
              'Federation issuer is not enrolled',
            );
          }
          assertActiveIssuer(issuer, input.principalVersion);

          const existing = await transaction.federatedPrincipal.findUnique({
            where: {
              issuerId_subject: { issuerId: issuer.id, subject: input.subject },
            },
            include: { user: true },
          });
          if (existing) {
            if (existing.tombstonedAt) {
              throw new FederationPrincipalError(
                'PRINCIPAL_TOMBSTONED',
                'Federation principal is tombstoned',
              );
            }
            if (
              existing.user.identityKind !== FEDERATED_IDENTITY_KIND ||
              existing.principalVersion !== input.principalVersion
            ) {
              throw new FederationPrincipalError(
                'PRINCIPAL_STATE_INVALID',
                'Federation principal state is invalid',
              );
            }
            const updated = await transaction.federatedPrincipal.update({
              where: { id: existing.id },
              data: { lastSeenAt: new Date(), displayLabel },
              select: {
                id: true,
                userId: true,
                issuerId: true,
                subject: true,
                principalVersion: true,
              },
            });
            return {
              userId: updated.userId,
              principalId: updated.id,
              issuerId: updated.issuerId,
              subject: updated.subject,
              principalVersion: updated.principalVersion,
            };
          }

          const created = await transaction.user.create({
            data: {
              ...identity,
              passwordHash,
              identityKind: FEDERATED_IDENTITY_KIND,
              role: FEDERATED_STORED_ROLE,
              federatedPrincipal: {
                create: {
                  issuerId: issuer.id,
                  subject: input.subject,
                  principalVersion: input.principalVersion,
                  displayLabel,
                },
              },
            },
            select: {
              id: true,
              federatedPrincipal: {
                select: {
                  id: true,
                  issuerId: true,
                  subject: true,
                  principalVersion: true,
                },
              },
            },
          });
          if (!created.federatedPrincipal) {
            throw new FederationPrincipalError(
              'PRINCIPAL_STATE_INVALID',
              'Federation principal was not created',
            );
          }
          return {
            userId: created.id,
            principalId: created.federatedPrincipal.id,
            issuerId: created.federatedPrincipal.issuerId,
            subject: created.federatedPrincipal.subject,
            principalVersion: created.federatedPrincipal.principalVersion,
          };
        });
      } catch (error) {
        if (!(isRetryableCreateConflict(error) && attempt + 1 < MAX_CREATE_ATTEMPTS)) {
          throw error;
        }
      }
    }
    throw new FederationPrincipalError(
      'PRINCIPAL_STATE_INVALID',
      'Federation principal could not be created',
    );
  }

  async tombstone(issuerId: string, subject: string, now = new Date()): Promise<void> {
    const result = await this.prisma.federatedPrincipal.updateMany({
      where: { issuerId, subject, tombstonedAt: null },
      data: { tombstonedAt: now },
    });
    if (result.count !== 1) {
      throw new FederationPrincipalError(
        'PRINCIPAL_STATE_INVALID',
        'Federation principal is not active',
      );
    }
  }
}
