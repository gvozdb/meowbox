import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { federationKeyIdFromPublicKeySpki } from './federation-key-material';
import {
  FederationRequestState,
  isVerifiedFederationRequest,
  VerifiedFederationContext,
} from './federation-request-context';

interface RotateTargetKeyRequest {
  previousKid: string;
  newKid: string;
  newPublicKeySpki: string;
  graceSeconds: number;
}

function verifiedAdmin(request: FederationRequestState): VerifiedFederationContext {
  if (
    !isVerifiedFederationRequest(request) ||
    request.federationContext.actorKind !== 'OPERATOR' ||
    request.federationContext.role !== 'ADMIN'
  ) throw new ForbiddenException('Verified federated ADMIN is required');
  return request.federationContext;
}

function parseRotationRequest(value: unknown): RotateTargetKeyRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Key rotation request must be an object');
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== 'graceSeconds,newKid,newPublicKeySpki,previousKid') {
    throw new BadRequestException('Key rotation request fields are invalid');
  }
  if (
    typeof input.previousKid !== 'string' ||
    typeof input.newKid !== 'string' ||
    typeof input.newPublicKeySpki !== 'string' ||
    !Number.isSafeInteger(input.graceSeconds) ||
    Number(input.graceSeconds) < 60 ||
    Number(input.graceSeconds) > 86_400
  ) throw new BadRequestException('Key rotation request is invalid');
  try {
    if (federationKeyIdFromPublicKeySpki(input.newPublicKeySpki) !== input.newKid) {
      throw new Error('kid mismatch');
    }
  } catch (error) {
    throw new BadRequestException('New federation public key is invalid', { cause: error });
  }
  if (input.previousKid === input.newKid) {
    throw new BadRequestException('New federation key must differ from the current key');
  }
  return input as unknown as RotateTargetKeyRequest;
}

@Injectable()
export class FederationTrustTargetService {
  constructor(private readonly prisma: PrismaService) {}

  async rotate(
    request: FederationRequestState,
    body: unknown,
    now = new Date(),
  ) {
    const context = verifiedAdmin(request);
    const input = parseRotationRequest(body);
    if (context.keyId !== input.previousKid) {
      throw new ConflictException('Rotation must be signed by the declared previous key');
    }
    const graceUntil = new Date(now.getTime() + input.graceSeconds * 1_000);
    return this.prisma.$transaction(async (tx) => {
      const issuer = await tx.federationIssuer.findUnique({
        where: { id: context.issuerId },
        include: { keys: true },
      });
      if (!issuer || issuer.state !== 'ACTIVE' || issuer.revokedAt) {
        throw new ConflictException('Federation issuer is not active');
      }
      const previous = issuer.keys.find((key) => key.kid === context.keyId);
      if (!previous || previous.state !== 'ACTIVE' || previous.revokedAt) {
        throw new ConflictException('Previous federation key is not active');
      }
      const existing = issuer.keys.find((key) => key.kid === input.newKid);
      if (existing) {
        if (
          existing.publicKeySpki !== input.newPublicKeySpki ||
          existing.encryptedPrivateKey !== null ||
          existing.state !== 'ACTIVE' ||
          existing.revokedAt !== null
        ) throw new ConflictException('Federation key rotation conflicts with stored key state');
        return {
          newKid: existing.kid,
          graceUntil: previous.expiresAt?.toISOString() ?? graceUntil.toISOString(),
          reconciled: true,
        };
      }
      const usable = issuer.keys.filter((key) =>
        key.state === 'ACTIVE' &&
        key.revokedAt === null &&
        (key.expiresAt === null || key.expiresAt > now));
      if (usable.length >= 2) throw new ConflictException('Federation key grace set is full');

      await tx.federationKey.create({
        data: {
          issuerId: issuer.id,
          kid: input.newKid,
          publicKeySpki: input.newPublicKeySpki,
          encryptedPrivateKey: null,
          state: 'ACTIVE',
          validFrom: now,
        },
      });
      for (const key of usable) {
        if (key.kid === input.newKid) continue;
        const expiresAt = !key.expiresAt || key.expiresAt > graceUntil
          ? graceUntil
          : key.expiresAt;
        await tx.federationKey.update({ where: { id: key.id }, data: { expiresAt } });
      }
      return { newKid: input.newKid, graceUntil: graceUntil.toISOString(), reconciled: false };
    });
  }

  async list(request: FederationRequestState, now = new Date()) {
    const context = verifiedAdmin(request);
    const issuer = await this.prisma.federationIssuer.findUnique({
      where: { id: context.issuerId },
      include: { keys: { orderBy: { validFrom: 'desc' } } },
    });
    if (!issuer) throw new ConflictException('Federation issuer is unavailable');
    return {
      issuerState: issuer.state,
      keys: issuer.keys.map((key) => ({
        kid: key.kid,
        state: key.state,
        validFrom: key.validFrom.toISOString(),
        expiresAt: key.expiresAt?.toISOString() ?? null,
        revokedAt: key.revokedAt?.toISOString() ?? null,
        usable: key.state === 'ACTIVE' &&
          key.revokedAt === null &&
          key.validFrom <= now &&
          (key.expiresAt === null || key.expiresAt > now),
      })),
    };
  }

  async revoke(request: FederationRequestState, now = new Date()) {
    const context = verifiedAdmin(request);
    await this.prisma.$transaction([
      this.prisma.federationKey.updateMany({
        where: { issuerId: context.issuerId, revokedAt: null },
        data: { state: 'REVOKED', revokedAt: now, expiresAt: now },
      }),
      this.prisma.federationIssuer.updateMany({
        where: { id: context.issuerId, revokedAt: null },
        data: { state: 'REVOKED', revokedAt: now },
      }),
    ]);
    return { state: 'REVOKED', revokedAt: now.toISOString() };
  }
}
