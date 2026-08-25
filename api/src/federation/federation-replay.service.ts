import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';

const DEFAULT_MAX_ACTIVE_REPLAYS_PER_ISSUER = 10_000;
const MAX_PRUNE_BATCH = 1_000;

export interface ConsumeFederationReplayInput {
  issuerId: string;
  kid: string;
  requestId: string;
  actionId: string;
  nonce: string;
  expiresAt: Date;
  now?: Date;
}

export class FederationReplayError extends Error {
  constructor(
    readonly code:
      | 'REPLAY_DETECTED'
      | 'REPLAY_CAPACITY_EXCEEDED'
      | 'REPLAY_EXPIRY_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'FederationReplayError';
  }
}

function replayHash(input: ConsumeFederationReplayInput): string {
  return createHash('sha256')
    .update(input.issuerId)
    .update('\0')
    .update(input.kid)
    .update('\0')
    .update(input.requestId)
    .update('\0')
    .update(input.actionId)
    .update('\0')
    .update(input.nonce)
    .digest('hex');
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class FederationReplayService {
  private readonly maxActivePerIssuer: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const configured = Number(
      config.get(
        'FEDERATION_MAX_ACTIVE_REPLAYS_PER_ISSUER',
        DEFAULT_MAX_ACTIVE_REPLAYS_PER_ISSUER,
      ),
    );
    this.maxActivePerIssuer = Number.isInteger(configured) && configured > 0
      ? configured
      : DEFAULT_MAX_ACTIVE_REPLAYS_PER_ISSUER;
  }

  async consume(input: ConsumeFederationReplayInput): Promise<string> {
    const now = input.now ?? new Date();
    if (
      !(input.expiresAt instanceof Date) ||
      Number.isNaN(input.expiresAt.getTime()) ||
      input.expiresAt.getTime() <= now.getTime()
    ) {
      throw new FederationReplayError(
        'REPLAY_EXPIRY_INVALID',
        'Replay tombstone expiry must be in the future',
      );
    }
    const hash = replayHash(input);

    try {
      await this.prisma.$transaction(async (transaction) => {
        const active = await transaction.federationReplay.count({
          where: {
            issuerId: input.issuerId,
            expiresAt: { gt: now },
          },
        });
        if (active >= this.maxActivePerIssuer) {
          throw new FederationReplayError(
            'REPLAY_CAPACITY_EXCEEDED',
            'Federation replay capacity is exhausted',
          );
        }
        await transaction.federationReplay.create({
          data: {
            replayHash: hash,
            issuerId: input.issuerId,
            kid: input.kid,
            requestId: input.requestId,
            actionId: input.actionId,
            expiresAt: input.expiresAt,
          },
          select: { replayHash: true },
        });
      });
    } catch (error) {
      if (error instanceof FederationReplayError) throw error;
      if (isUniqueConflict(error)) {
        throw new FederationReplayError(
          'REPLAY_DETECTED',
          'Federation assertion was already consumed',
        );
      }
      throw error;
    }
    return hash;
  }

  async pruneExpired(now = new Date(), batchSize = MAX_PRUNE_BATCH): Promise<number> {
    const limit = Math.max(1, Math.min(MAX_PRUNE_BATCH, Math.trunc(batchSize)));
    const expired = await this.prisma.federationReplay.findMany({
      where: { expiresAt: { lte: now } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
      select: { replayHash: true },
    });
    if (expired.length === 0) return 0;
    const result = await this.prisma.federationReplay.deleteMany({
      where: { replayHash: { in: expired.map(({ replayHash }) => replayHash) } },
    });
    return result.count;
  }
}

