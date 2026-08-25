import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  OperationRecoveryPolicy,
} from '@meowbox/shared';
import { PanelIdentityService } from '../federation/panel-identity.service';
import {
  OperationsService,
  type OperationTicket,
} from './operations.service';

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,128}$/;
const ACTION_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9_-]+)+$/;
const ROLES = new Set(['ADMIN', 'MANAGER', 'VIEWER']);

function deterministicRequestId(
  installationId: string,
  userId: string,
  idempotencyKey: string,
): string {
  const bytes = createHash('sha256')
    .update('MEOWBOX-OPERATION-REQUEST-V1\0')
    .update(installationId)
    .update('\0')
    .update(userId)
    .update('\0')
    .update(idempotencyKey)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface OperationActor {
  userId: string;
  role: string;
}

export interface AdmitOperationInput {
  actionId: string;
  type: string;
  idempotencyKey: string | undefined;
  actor: OperationActor;
  request: unknown;
  deadlineMs: number;
  recoveryPolicy: OperationRecoveryPolicy;
  retryable: boolean;
  maxAttempts?: number;
  globalLockKey?: string;
  siteId?: string;
  siteDomainId?: string;
  databaseId?: string;
  lockSite?: boolean;
}

export interface AcceptedOperation {
  operationId: string;
  requestId: string;
  state: string;
  replayed: boolean;
  statusPath: string;
  retryAfterSeconds: number;
}

@Injectable()
export class OperationAdmissionService {
  constructor(
    private readonly operations: OperationsService,
    private readonly panelIdentity: PanelIdentityService,
  ) {}

  async admit(input: AdmitOperationInput): Promise<AcceptedOperation> {
    const idempotencyKey = input.idempotencyKey?.trim();
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new BadRequestException('Idempotency-Key must be 8-128 printable ASCII characters');
    }
    if (!ACTION_ID.test(input.actionId)) {
      throw new BadRequestException('Operation action is invalid');
    }
    if (!ROLES.has(input.actor.role)) {
      throw new BadRequestException('Operation actor role is invalid');
    }
    if (
      !Number.isInteger(input.deadlineMs) ||
      input.deadlineMs < 30_000 ||
      input.deadlineMs > 30 * 24 * 60 * 60 * 1000
    ) {
      throw new BadRequestException('Operation deadline budget is invalid');
    }
    if (input.retryable !== (input.recoveryPolicy === 'RETRY_SAFE')) {
      throw new BadRequestException('Only RETRY_SAFE operations may be retried');
    }
    const identity = await this.panelIdentity.getLocalIdentity();
    const requestId = deterministicRequestId(
      identity.installationId,
      input.actor.userId,
      idempotencyKey,
    );
    const ticket: OperationTicket = await this.operations.begin({
      idempotencyKey,
      type: input.type,
      userId: input.actor.userId,
      request: input.request,
      globalLockKey: input.globalLockKey,
      siteId: input.siteId,
      siteDomainId: input.siteDomainId,
      databaseId: input.databaseId,
      lockSite: input.lockSite,
      queued: {
        actionId: input.actionId,
        policySnapshot: {
          actionId: input.actionId,
          schemaVersion: 1,
          actorKind: 'OPERATOR',
          issuerId: identity.installationId,
          subject: input.actor.userId,
          role: input.actor.role as 'ADMIN' | 'MANAGER' | 'VIEWER',
          permissions: [input.actionId],
          idempotencyId: idempotencyKey,
          requestId,
          recoveryPolicy: input.recoveryPolicy,
          retryable: input.retryable,
        },
        recoveryPolicy: input.recoveryPolicy,
        retryable: input.retryable,
        deadlineAt: new Date(Date.now() + input.deadlineMs),
        maxAttempts: input.maxAttempts,
      },
    });
    return {
      operationId: ticket.id,
      requestId,
      state: ticket.status,
      replayed: ticket.replayed,
      statusPath: `/api/operations/${ticket.id}`,
      retryAfterSeconds: 1,
    };
  }
}
