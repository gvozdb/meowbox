import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { DelegatedActorKind, DelegationRequestBinding } from './delegation-envelope';

const DEFAULT_RECEIPT_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export interface ClaimFederationIdempotencyInput {
  issuerId: string;
  actorKind: DelegatedActorKind;
  subject: string;
  actionId: string;
  idempotencyKey: string;
  requestId: string;
  requestHash: string;
  now?: Date;
}

export class FederationIdempotencyError extends Error {
  constructor(
    readonly code: 'IDEMPOTENCY_CONFLICT' | 'IDEMPOTENCY_REPLAY',
    message: string,
  ) {
    super(message);
    this.name = 'FederationIdempotencyError';
  }
}

function digest(...parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest('hex');
}

export function federationRequestHash(binding: DelegationRequestBinding): string {
  return digest(
    binding.method,
    binding.targetPathAndQuery,
    JSON.stringify(binding.headers),
    binding.bodySha256,
  );
}

@Injectable()
export class FederationIdempotencyService {
  private readonly receiptTtlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const configured = Number(config.get('FEDERATION_IDEMPOTENCY_TTL_MS', DEFAULT_RECEIPT_TTL_MS));
    this.receiptTtlMs = Number.isSafeInteger(configured) && configured > 0
      ? Math.min(configured, MAX_RECEIPT_TTL_MS)
      : DEFAULT_RECEIPT_TTL_MS;
  }

  async claim(input: ClaimFederationIdempotencyInput): Promise<string> {
    const now = input.now ?? new Date();
    const subjectHash = digest(input.actorKind, input.subject);
    const idempotencyKeyHash = digest(input.idempotencyKey);
    const selector = {
      issuerId: input.issuerId,
      actorKind: input.actorKind,
      subjectHash,
      actionId: input.actionId,
      idempotencyKeyHash,
    } as const;

    try {
      return await this.prisma.$transaction(async (transaction) => {
        await transaction.federationIdempotencyReceipt.deleteMany({
          where: { ...selector, expiresAt: { lte: now } },
        });
        const existing = await transaction.federationIdempotencyReceipt.findFirst({
          where: selector,
        });
        if (existing) this.throwExisting(existing.requestHash, input.requestHash);
        const created = await transaction.federationIdempotencyReceipt.create({
          data: {
            ...selector,
            requestHash: input.requestHash,
            requestId: input.requestId,
            expiresAt: new Date(now.getTime() + this.receiptTtlMs),
          },
          select: { id: true },
        });
        return created.id;
      });
    } catch (error) {
      if (error instanceof FederationIdempotencyError) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.prisma.federationIdempotencyReceipt.findFirst({ where: selector });
        if (existing) this.throwExisting(existing.requestHash, input.requestHash);
      }
      throw error;
    }
  }

  async pruneExpired(now = new Date(), limit = 1_000): Promise<number> {
    const rows = await this.prisma.federationIdempotencyReceipt.findMany({
      where: { expiresAt: { lte: now } },
      orderBy: { expiresAt: 'asc' },
      take: Math.max(1, Math.min(1_000, Math.trunc(limit))),
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    return (await this.prisma.federationIdempotencyReceipt.deleteMany({
      where: { id: { in: rows.map(({ id }) => id) } },
    })).count;
  }

  private throwExisting(existingHash: string, requestHash: string): never {
    if (existingHash !== requestHash) {
      throw new FederationIdempotencyError(
        'IDEMPOTENCY_CONFLICT',
        'Idempotency key is already bound to a different request',
      );
    }
    throw new FederationIdempotencyError(
      'IDEMPOTENCY_REPLAY',
      'Mutation was already admitted and requires result reconciliation',
    );
  }
}
