import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTION_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9_-]+)+$/;

export interface CreateRemoteOperationLinkInput {
  remoteServerId: string;
  targetOperationId: string;
  masterUserId: string;
  actionId: string;
  requestId: string;
  correlationId: string;
}

@Injectable()
export class RemoteOperationLinkService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: CreateRemoteOperationLinkInput) {
    if (
      !UUID.test(input.targetOperationId) ||
      !UUID.test(input.requestId) ||
      !UUID.test(input.correlationId) ||
      !ACTION_ID.test(input.actionId)
    ) {
      throw new ConflictException('Remote operation link binding is invalid');
    }
    const existing = await this.prisma.remoteOperationLink.findUnique({
      where: {
        remoteServerId_targetOperationId: {
          remoteServerId: input.remoteServerId,
          targetOperationId: input.targetOperationId,
        },
      },
    });
    if (existing) return this.assertExact(existing, input);

    try {
      return await this.prisma.remoteOperationLink.create({ data: input });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const raced = await this.prisma.remoteOperationLink.findUnique({
          where: {
            remoteServerId_targetOperationId: {
              remoteServerId: input.remoteServerId,
              targetOperationId: input.targetOperationId,
            },
          },
        });
        if (raced) return this.assertExact(raced, input);
      }
      throw error;
    }
  }

  async touch(remoteServerId: string, targetOperationId: string): Promise<void> {
    const updated = await this.prisma.remoteOperationLink.updateMany({
      where: { remoteServerId, targetOperationId },
      data: { lastPolledAt: new Date() },
    });
    if (updated.count !== 1) throw new NotFoundException('Remote operation link not found');
  }

  private assertExact<T extends {
    remoteServerId: string;
    targetOperationId: string;
    masterUserId: string;
    actionId: string;
    requestId: string;
    correlationId: string;
  }>(existing: T, input: CreateRemoteOperationLinkInput): T {
    for (const key of [
      'remoteServerId',
      'targetOperationId',
      'masterUserId',
      'actionId',
      'requestId',
      'correlationId',
    ] as const) {
      if (existing[key] !== input[key]) {
        throw new ConflictException('Remote operation link identity conflict');
      }
    }
    return existing;
  }
}
