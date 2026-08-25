import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { isReleaseMaintenanceActive } from '../common/release-maintenance';
import {
  safeErrorMessage,
  type OperationPolicySnapshot,
  type OperationRecoveryPolicy,
} from '@meowbox/shared';
import {
  decryptWithDomain,
  encryptWithDomain,
} from '../common/crypto/master-key';
import { stableJson } from '../common/stable-json';
import { assertNoSecretFields } from '../common/safe-persisted-json';

const EXECUTING_STATUSES = [
  'PENDING',
  'QUEUED',
  'CLAIMED',
  'RUNNING',
  'RECOVERING',
  'CANCEL_REQUESTED',
] as const;
const LOCK_HOLDING_STATUSES = [
  ...EXECUTING_STATUSES,
  'UNKNOWN_RECOVERY_REQUIRED',
  'NEEDS_ATTENTION',
] as const;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const GLOBAL_LOCK_KEY = /^[a-z][a-z0-9:-]{0,63}$/;
const ACTION_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9_-]+)+$/;
const RESTART_ATTENTION =
  'Interrupted by API restart; operator reconciliation is required';
const MAX_QUEUED_PER_TARGET = 128;
const MAX_QUEUED_PER_ACTOR = 32;
const MAX_OPERATION_PAYLOAD_BYTES = 1024 * 1024;
const TRANSITIONAL_APP_STATUSES = [
  'PROVISIONING',
  'DEPLOYING',
  'UPDATING',
] as const;

export interface BeginOperationInput {
  idempotencyKey?: string;
  type: string;
  siteId?: string | null;
  siteDomainId?: string | null;
  databaseId?: string | null;
  globalLockKey?: string | null;
  lockSite?: boolean;
  parentOperationId?: string | null;
  userId: string;
  request: unknown;
  queued?: {
    actionId: string;
    policySnapshot: OperationPolicySnapshot;
    recoveryPolicy: OperationRecoveryPolicy;
    retryable: boolean;
    deadlineAt: Date;
    maxAttempts?: number;
  };
}

export interface OperationTicket {
  id: string;
  siteId: string | null;
  siteDomainId: string | null;
  replayed: boolean;
  status: string;
  result: unknown;
}

interface OperationLockSpec {
  resourceKey: string;
  kind: 'GLOBAL' | 'SITE' | 'DOMAIN' | 'DATABASE';
}

export interface ClaimedOperation {
  id: string;
  actionId: string;
  recovering: boolean;
  attempt: number;
  maxAttempts: number;
  retryable: boolean;
  recoveryPolicy: OperationRecoveryPolicy;
  deadlineAt: Date;
  request: unknown;
  policySnapshot: OperationPolicySnapshot;
  cancelRequestedAt: Date | null;
}

function operationLockSpecs(
  input: Pick<
    BeginOperationInput,
    | 'globalLockKey'
    | 'siteId'
    | 'siteDomainId'
    | 'databaseId'
    | 'lockSite'
    | 'parentOperationId'
  >,
): OperationLockSpec[] {
  const locks: OperationLockSpec[] = [];
  const globalLockKey = input.globalLockKey?.trim();
  if (globalLockKey && !input.parentOperationId) {
    locks.push({
      resourceKey: `global:${globalLockKey}`,
      kind: 'GLOBAL',
    });
  }
  if (input.siteId && input.lockSite !== false && !input.parentOperationId) {
    locks.push({ resourceKey: `site:${input.siteId}`, kind: 'SITE' });
  }
  if (input.siteDomainId) {
    locks.push({
      resourceKey: `domain:${input.siteDomainId}`,
      kind: 'DOMAIN',
    });
  }
  if (input.databaseId) {
    locks.push({
      resourceKey: `database:${input.databaseId}`,
      kind: 'DATABASE',
    });
  }
  return locks;
}

function isTransactionContention(error: unknown): boolean {
  return ['P1008', 'P2028', 'P2034'].includes(
    String((error as { code?: unknown }).code || ''),
  );
}

function parseResult(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parsePolicySnapshot(raw: string | null): OperationPolicySnapshot | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OperationPolicySnapshot;
  } catch {
    return null;
  }
}

function payloadBytes(value: unknown): number {
  return Buffer.byteLength(stableJson(value), 'utf8');
}

function assertQueuedConfiguration(
  queued: NonNullable<BeginOperationInput['queued']>,
  idempotencyKey: string,
): void {
  if (!ACTION_ID.test(queued.actionId) || queued.policySnapshot.actionId !== queued.actionId) {
    throw new ConflictException('Queued operation action is invalid');
  }
  if (queued.policySnapshot.idempotencyId !== idempotencyKey) {
    throw new ConflictException('Operation policy idempotency binding is invalid');
  }
  if (
    queued.policySnapshot.recoveryPolicy !== queued.recoveryPolicy ||
    queued.policySnapshot.retryable !== queued.retryable
  ) {
    throw new ConflictException('Operation policy recovery binding is invalid');
  }
  if (queued.retryable !== (queued.recoveryPolicy === 'RETRY_SAFE')) {
    throw new ConflictException('Only RETRY_SAFE operations may be retried');
  }
  if (
    !(queued.deadlineAt instanceof Date) ||
    !Number.isFinite(queued.deadlineAt.getTime()) ||
    queued.deadlineAt.getTime() <= Date.now() ||
    queued.deadlineAt.getTime() > Date.now() + 30 * 24 * 60 * 60 * 1000
  ) {
    throw new ConflictException('Queued operation deadline is invalid');
  }
  const maxAttempts = queued.maxAttempts ?? (queued.retryable ? 3 : 1);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new ConflictException('Queued operation maxAttempts must be 1-3');
  }
  assertNoSecretFields(queued.policySnapshot, 'policySnapshot');
}

@Injectable()
export class OperationsService implements OnModuleInit {
  private readonly logger = new Logger(OperationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    const interrupted = await this.prisma.operation.findMany({
      where: {
        OR: [
          { executionMode: 'INLINE', status: { in: ['PENDING', 'RUNNING'] } },
          {
            executionMode: 'QUEUED',
            status: { in: ['CLAIMED', 'RUNNING', 'RECOVERING', 'CANCEL_REQUESTED'] },
          },
        ],
      },
      select: {
        id: true,
        siteId: true,
        siteDomainId: true,
        executionMode: true,
        recoveryPolicy: true,
        retryable: true,
      },
    });
    if (interrupted.length === 0) return;

    const completedAt = new Date();
    const recoveringIds = interrupted
      .filter(
        (operation) =>
          operation.executionMode === 'QUEUED' &&
          (operation.recoveryPolicy === 'RECONCILE_ONLY' ||
            (operation.recoveryPolicy === 'RETRY_SAFE' && operation.retryable)),
      )
      .map(({ id }) => id);
    const attention = interrupted.filter(
      ({ id }) => !recoveringIds.includes(id),
    );
    const attentionIds = attention.map(({ id }) => id);
    const siteDomainIds = [
      ...new Set(
        attention
          .map(({ siteDomainId }) => siteDomainId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const siteIds = [
      ...new Set(
        attention
          .map(({ siteId }) => siteId)
          .filter((id): id is string => id !== null),
      ),
    ];

    const queries: Prisma.PrismaPromise<unknown>[] = [];
    if (recoveringIds.length > 0) {
      queries.push(this.prisma.operation.updateMany({
        where: { id: { in: recoveringIds } },
        data: {
          status: 'RECOVERING',
          currentStep: 'reconcile',
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          completedAt: null,
        },
      }));
    }
    if (attentionIds.length > 0) {
      queries.push(this.prisma.operation.updateMany({
        where: { id: { in: attentionIds } },
        data: {
          status: 'NEEDS_ATTENTION',
          currentStep: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          errorMessage: RESTART_ATTENTION,
          completedAt,
        },
      }));
      queries.push(this.prisma.siteDomain.updateMany({
        where: {
          id: { in: siteDomainIds },
          appStatus: { in: [...TRANSITIONAL_APP_STATUSES] },
        },
        data: {
          appStatus: 'ERROR',
          appErrorMessage: RESTART_ATTENTION,
        },
      }));
      queries.push(this.prisma.site.updateMany({
        where: {
          id: { in: siteIds },
          status: 'DEPLOYING',
        },
        data: {
          status: 'ERROR',
          errorMessage: RESTART_ATTENTION,
        },
      }));
      queries.push(this.prisma.deployLog.updateMany({
        where: {
          operationId: { in: attentionIds },
          status: { in: ['PENDING', 'IN_PROGRESS'] },
        },
        data: {
          status: 'FAILED',
          completedAt,
        },
      }));
    }

    await this.prisma.$transaction(queries);

    this.logger.warn(
      `Recovered ${recoveringIds.length} queued operation(s); ` +
      `${attentionIds.length} operation(s) require attention`,
    );
  }

  async begin(input: BeginOperationInput): Promise<OperationTicket> {
    if (isReleaseMaintenanceActive()) {
      throw new ServiceUnavailableException(
        'Panel writes are temporarily paused for a release migration',
      );
    }
    const idempotencyKey = input.idempotencyKey?.trim() || randomUUID();
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new ConflictException(
        'Idempotency-Key must be 8-128 safe ASCII characters',
      );
    }
    if (input.queued) {
      assertQueuedConfiguration(input.queued, idempotencyKey);
      if (payloadBytes(input.request) > MAX_OPERATION_PAYLOAD_BYTES) {
        throw new ConflictException('Queued operation payload exceeds 1 MiB');
      }
    }
    const globalLockKey = input.globalLockKey?.trim() || null;
    if (globalLockKey && !GLOBAL_LOCK_KEY.test(globalLockKey)) {
      throw new ConflictException(
        'Global operation lock key must be 1-64 safe lowercase characters',
      );
    }
    if (globalLockKey && input.parentOperationId) {
      throw new ConflictException(
        'Only top-level operations can acquire a global lock',
      );
    }
    const lockSpecs = operationLockSpecs({
      ...input,
      globalLockKey,
    });
    const requestHash = createHash('sha256')
      .update(
        stableJson({
          request: input.request,
          scope: {
            siteId: input.siteId || null,
            siteDomainId: input.siteDomainId || null,
            databaseId: input.databaseId || null,
            globalLockKey,
            lockSite: input.lockSite !== false,
            parentOperationId: input.parentOperationId || null,
          },
          execution: input.queued
            ? {
                actionId: input.queued.actionId,
                policy: {
                  ...input.queued.policySnapshot,
                  requestId: undefined,
                },
                recoveryPolicy: input.queued.recoveryPolicy,
                retryable: input.queued.retryable,
                maxAttempts:
                  input.queued.maxAttempts ?? (input.queued.retryable ? 3 : 1),
              }
            : null,
        }),
      )
      .digest('hex');

    const existing = await this.prisma.operation.findUnique({
      where: { idempotencyKey },
    });
    if (existing) {
      this.assertReplay(existing, input, requestHash);
      return {
        id: existing.id,
        siteId: existing.siteId,
        siteDomainId: existing.siteDomainId,
        replayed: true,
        status: existing.status,
        result: parseResult(existing.result),
      };
    }

    if ((input.siteDomainId || input.databaseId) && !input.siteId) {
      throw new ConflictException(
        'Domain and database operations require a Site scope',
      );
    }

    const operationId = randomUUID();
    const requestPayloadEnc = input.queued
      ? encryptWithDomain('operations', {
          operationId,
          request: input.request,
        })
      : null;

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        if (input.queued) {
          const [targetQueued, actorQueued] = await Promise.all([
            tx.operation.count({
              where: {
                executionMode: 'QUEUED',
                status: {
                  in: ['QUEUED', 'CLAIMED', 'RUNNING', 'RECOVERING', 'CANCEL_REQUESTED'],
                },
              },
            }),
            tx.operation.count({
              where: {
                executionMode: 'QUEUED',
                createdByUserId: input.userId,
                status: {
                  in: ['QUEUED', 'CLAIMED', 'RUNNING', 'RECOVERING', 'CANCEL_REQUESTED'],
                },
              },
            }),
          ]);
          if (
            targetQueued >= MAX_QUEUED_PER_TARGET ||
            actorQueued >= MAX_QUEUED_PER_ACTOR
          ) {
            throw new HttpException(
              'Operation queue admission limit reached',
              HttpStatus.TOO_MANY_REQUESTS,
            );
          }
        }
        if (input.parentOperationId) {
          const parent = await tx.operation.findUnique({
            where: { id: input.parentOperationId },
            select: {
              id: true,
              status: true,
              siteId: true,
              createdByUserId: true,
            },
          });
          if (
            !parent ||
            !EXECUTING_STATUSES.includes(
              parent.status as (typeof EXECUTING_STATUSES)[number],
            ) ||
            parent.createdByUserId !== input.userId ||
            (input.siteId != null && parent.siteId !== input.siteId)
          ) {
            throw new ConflictException(
              'Parent operation is not active or compatible',
            );
          }
        }

        if (input.siteId) {
          const activeBackup = await tx.backup.findFirst({
            where: {
              siteId: input.siteId,
              status: { in: ['PENDING', 'IN_PROGRESS'] },
            },
            select: { id: true, status: true },
          });
          if (activeBackup) {
            throw new ConflictException({
              message: 'Site backup is active',
              backup: activeBackup,
            });
          }
        }

        await this.assertScopeHierarchyAvailable(tx, input);
        return tx.operation.create({
          data: {
            id: operationId,
            idempotencyKey,
            requestHash,
            type: input.type,
            siteId: input.siteId || null,
            siteDomainId: input.siteDomainId || null,
            databaseId: input.databaseId || null,
            globalLockKey,
            parentOperationId: input.parentOperationId || null,
            createdByUserId: input.userId,
            status: input.queued ? 'QUEUED' : 'PENDING',
            progress: 0,
            actionId: input.queued?.actionId || null,
            executionMode: input.queued ? 'QUEUED' : 'INLINE',
            policySnapshot: input.queued
              ? stableJson(input.queued.policySnapshot)
              : null,
            requestPayloadEnc,
            maxAttempts:
              input.queued?.maxAttempts ?? (input.queued?.retryable ? 3 : 1),
            retryable: input.queued?.retryable ?? false,
            recoveryPolicy: input.queued?.recoveryPolicy ?? 'MANUAL',
            deadlineAt: input.queued?.deadlineAt ?? null,
            cancelOutcome: input.queued ? 'NOT_REQUESTED' : null,
            locks:
              lockSpecs.length > 0
                ? {
                    create: lockSpecs,
                  }
                : undefined,
          },
        });
      });
      return {
        id: created.id,
        siteId: created.siteId,
        siteDomainId: created.siteDomainId,
        replayed: false,
        status: created.status,
        result: null,
      };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const replay = await this.prisma.operation.findUnique({
          where: { idempotencyKey },
        });
        if (replay) {
          this.assertReplay(replay, input, requestHash);
          return {
            id: replay.id,
            siteId: replay.siteId,
            siteDomainId: replay.siteDomainId,
            replayed: true,
            status: replay.status,
            result: parseResult(replay.result),
          };
        }
        const active =
          (await this.findResourceLock(lockSpecs.map((lock) => lock.resourceKey))) ||
          (await this.prisma.operation.findFirst({
            where: {
              status: { in: [...LOCK_HOLDING_STATUSES] },
              OR: [
                ...(input.siteId ? [{ siteId: input.siteId }] : []),
                ...(input.siteDomainId
                  ? [{ siteDomainId: input.siteDomainId }]
                  : []),
                ...(input.databaseId ? [{ databaseId: input.databaseId }] : []),
                ...(globalLockKey ? [{ globalLockKey }] : []),
              ],
            },
            select: { id: true, type: true, status: true, currentStep: true },
          }));
        throw new ConflictException({
          message: 'Operation scope is locked',
          operation: active,
        });
      }
      if (isTransactionContention(error)) {
        throw new ConflictException('Operation scope is busy');
      }
      throw error;
    }
  }

  async start(operationId: string, step: string): Promise<void> {
    const updated = await this.prisma.operation.updateMany({
      where: { id: operationId, status: 'PENDING' },
      data: {
        status: 'RUNNING',
        currentStep: step,
        startedAt: new Date(),
        progress: 0,
      },
    });
    if (updated.count !== 1) {
      throw new ConflictException('Operation is not pending');
    }
  }

  async claimNext(leaseOwner: string, now = new Date()): Promise<ClaimedOperation | null> {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(leaseOwner)) {
      throw new Error('Invalid operation lease owner');
    }
    const leaseExpiresAt = new Date(now.getTime() + 30_000);
    const claimedId = await this.prisma.$transaction(async (tx) => {
      const lostLeases = await tx.operation.findMany({
        where: {
          executionMode: 'QUEUED',
          status: { in: ['CLAIMED', 'RUNNING', 'CANCEL_REQUESTED'] },
          leaseExpiresAt: { lte: now },
        },
        select: {
          id: true,
          status: true,
          recoveryPolicy: true,
          retryable: true,
        },
        take: 16,
      });
      const recoverableLeaseIds = lostLeases
        .filter(
          (operation) =>
            operation.status !== 'CANCEL_REQUESTED' &&
            (operation.recoveryPolicy === 'RECONCILE_ONLY' ||
              (operation.recoveryPolicy === 'RETRY_SAFE' && operation.retryable)),
        )
        .map(({ id }) => id);
      const attentionLeaseIds = lostLeases
        .filter(({ id }) => !recoverableLeaseIds.includes(id))
        .map(({ id }) => id);
      if (recoverableLeaseIds.length > 0) {
        await tx.operation.updateMany({
          where: {
            id: { in: recoverableLeaseIds },
            leaseExpiresAt: { lte: now },
          },
          data: {
            status: 'RECOVERING',
            currentStep: 'reconcile',
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
          },
        });
      }
      if (attentionLeaseIds.length > 0) {
        await tx.operation.updateMany({
          where: {
            id: { in: attentionLeaseIds },
            leaseExpiresAt: { lte: now },
          },
          data: {
            status: 'NEEDS_ATTENTION',
            currentStep: null,
            errorMessage: 'Operation lease expired; reconciliation is required',
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            completedAt: now,
          },
        });
      }

      const active = await tx.operation.count({
        where: {
          executionMode: 'QUEUED',
          status: { in: ['CLAIMED', 'RUNNING', 'CANCEL_REQUESTED'] },
          leaseExpiresAt: { gt: now },
        },
      });
      if (active >= 2) return null;

      const expired = await tx.operation.findMany({
        where: {
          executionMode: 'QUEUED',
          status: { in: ['QUEUED', 'RECOVERING'] },
          deadlineAt: { lte: now },
        },
        select: { id: true },
        take: 16,
      });
      if (expired.length > 0) {
        const ids = expired.map(({ id }) => id);
        await tx.operation.updateMany({
          where: { id: { in: ids }, status: { in: ['QUEUED', 'RECOVERING'] } },
          data: {
            status: 'FAILED',
            errorMessage: 'Operation deadline expired before execution',
            completedAt: now,
            currentStep: null,
          },
        });
        await tx.operationLock.deleteMany({ where: { operationId: { in: ids } } });
      }

      const candidates = await tx.operation.findMany({
        where: {
          executionMode: 'QUEUED',
          status: { in: ['QUEUED', 'RECOVERING'] },
          cancelRequestedAt: null,
          deadlineAt: { gt: now },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          status: true,
          attempt: true,
          maxAttempts: true,
        },
        take: 8,
      });

      for (const candidate of candidates) {
        if (candidate.status === 'QUEUED' && candidate.attempt >= candidate.maxAttempts) {
          await tx.operation.updateMany({
            where: { id: candidate.id, status: candidate.status },
            data: {
              status: 'NEEDS_ATTENTION',
              errorMessage: 'Operation attempt budget exhausted',
              completedAt: now,
            },
          });
          continue;
        }
        const claimed = await tx.operation.updateMany({
          where: {
            id: candidate.id,
            status: candidate.status,
            leaseOwner: null,
            cancelRequestedAt: null,
          },
          data: {
            status: 'CLAIMED',
            leaseOwner,
            leaseExpiresAt,
            heartbeatAt: now,
            claimedAt: now,
            ...(candidate.status === 'QUEUED'
              ? { attempt: { increment: 1 } }
              : {}),
            completedAt: null,
          },
        });
        if (claimed.count === 1) {
          return {
            id: candidate.id,
            recovering: candidate.status === 'RECOVERING',
          };
        }
      }
      return null;
    });
    if (!claimedId) return null;

    const operation = await this.prisma.operation.findUnique({
      where: { id: claimedId.id },
      select: {
        id: true,
        actionId: true,
        attempt: true,
        maxAttempts: true,
        retryable: true,
        recoveryPolicy: true,
        deadlineAt: true,
        requestPayloadEnc: true,
        policySnapshot: true,
        cancelRequestedAt: true,
      },
    });
    if (
      !operation?.actionId ||
      !operation.deadlineAt ||
      !operation.requestPayloadEnc ||
      !operation.policySnapshot
    ) {
      await this.requireAttention(claimedId.id, leaseOwner, 'Queued operation state is incomplete');
      return null;
    }
    try {
      const payload = decryptWithDomain<{
        operationId: string;
        request: unknown;
      }>('operations', operation.requestPayloadEnc);
      const policySnapshot = parsePolicySnapshot(operation.policySnapshot);
      if (payload.operationId !== operation.id || !policySnapshot) {
        throw new Error('Operation payload binding is invalid');
      }
      return {
        id: operation.id,
        actionId: operation.actionId,
        recovering: claimedId.recovering,
        attempt: operation.attempt,
        maxAttempts: operation.maxAttempts,
        retryable: operation.retryable,
        recoveryPolicy: operation.recoveryPolicy as OperationRecoveryPolicy,
        deadlineAt: operation.deadlineAt,
        request: payload.request,
        policySnapshot,
        cancelRequestedAt: operation.cancelRequestedAt,
      };
    } catch {
      await this.requireAttention(claimedId.id, leaseOwner, 'Queued operation payload cannot be decrypted');
      return null;
    }
  }

  async startClaimed(operationId: string, leaseOwner: string, step: string): Promise<void> {
    const now = new Date();
    const updated = await this.prisma.operation.updateMany({
      where: {
        id: operationId,
        status: 'CLAIMED',
        leaseOwner,
        leaseExpiresAt: { gt: now },
      },
      data: {
        status: 'RUNNING',
        currentStep: step,
        startedAt: now,
        heartbeatAt: now,
      },
    });
    if (updated.count !== 1) throw new ConflictException('Operation claim is stale');
  }

  async heartbeatClaim(
    operationId: string,
    leaseOwner: string,
    step?: string,
    progress?: number,
  ): Promise<boolean> {
    const now = new Date();
    const updated = await this.prisma.operation.updateMany({
      where: {
        id: operationId,
        leaseOwner,
        status: { in: ['CLAIMED', 'RUNNING', 'CANCEL_REQUESTED'] },
        leaseExpiresAt: { gt: now },
        deadlineAt: { gt: now },
      },
      data: {
        heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + 30_000),
        ...(step === undefined ? {} : { currentStep: step }),
        ...(progress === undefined
          ? {}
          : { progress: Math.max(0, Math.min(99, Math.trunc(progress))) }),
      },
    });
    return updated.count === 1;
  }

  async isCancellationRequested(operationId: string, leaseOwner: string): Promise<boolean> {
    const operation = await this.prisma.operation.findFirst({
      where: { id: operationId, leaseOwner },
      select: { status: true, cancelRequestedAt: true },
    });
    return operation?.status === 'CANCEL_REQUESTED' || operation?.cancelRequestedAt != null;
  }

  async succeedClaimed(
    operationId: string,
    leaseOwner: string,
    result: unknown = null,
    cancelTooLate = false,
  ): Promise<void> {
    assertNoSecretFields(result);
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.operation.findFirst({
        where: {
          id: operationId,
          status: { in: ['RUNNING', 'CANCEL_REQUESTED'] },
          leaseOwner,
        },
        select: { status: true, cancelRequestedAt: true },
      });
      if (!current) throw new ConflictException('Operation claim is stale');
      const cancellationWasTooLate =
        cancelTooLate ||
        current.status === 'CANCEL_REQUESTED' ||
        current.cancelRequestedAt != null;
      const updated = await tx.operation.updateMany({
        where: {
          id: operationId,
          status: current.status,
          leaseOwner,
        },
        data: {
          status: 'SUCCEEDED',
          currentStep: null,
          progress: 100,
          result: result === undefined ? null : JSON.stringify(result),
          errorMessage: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          completedAt: new Date(),
          cancelOutcome: cancellationWasTooLate ? 'TOO_LATE' : 'NOT_REQUESTED',
        },
      });
      if (updated.count !== 1) throw new ConflictException('Operation claim is stale');
      await tx.operationLock.deleteMany({ where: { operationId } });
    });
  }

  async failClaimed(
    operationId: string,
    leaseOwner: string,
    error: unknown,
  ): Promise<void> {
    const message = safeErrorMessage(error);
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.operation.updateMany({
        where: {
          id: operationId,
          status: { in: ['CLAIMED', 'RUNNING', 'CANCEL_REQUESTED'] },
          leaseOwner,
        },
        data: {
          status: 'FAILED',
          currentStep: null,
          errorMessage: message,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          completedAt: new Date(),
          cancelOutcome: 'NOT_REQUESTED',
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException('Operation claim is stale');
      }
      await tx.operationLock.deleteMany({ where: { operationId } });
    });
  }

  async retryOrRequireAttention(
    operation: ClaimedOperation,
    leaseOwner: string,
    error: unknown,
  ): Promise<void> {
    const now = new Date();
    const message = safeErrorMessage(error);
    const canRetry =
      operation.retryable &&
      operation.recoveryPolicy === 'RETRY_SAFE' &&
      operation.attempt < operation.maxAttempts &&
      operation.deadlineAt > now;
    const updated = await this.prisma.operation.updateMany({
      where: {
        id: operation.id,
        leaseOwner,
        status: { in: ['CLAIMED', 'RUNNING', 'CANCEL_REQUESTED'] },
      },
      data: canRetry
        ? {
            status: 'QUEUED',
            currentStep: null,
            errorMessage: message,
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            claimedAt: null,
          }
        : {
            status: 'NEEDS_ATTENTION',
            currentStep: null,
            errorMessage: message,
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            completedAt: now,
          },
    });
    if (updated.count !== 1) throw new ConflictException('Operation claim is stale');
  }

  async cancelClaimed(operationId: string, leaseOwner: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.operation.updateMany({
        where: {
          id: operationId,
          leaseOwner,
          status: { in: ['CLAIMED', 'RUNNING', 'CANCEL_REQUESTED'] },
        },
        data: {
          status: 'CANCELLED',
          currentStep: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          cancelOutcome: 'CANCELLED',
          completedAt: new Date(),
        },
      });
      if (updated.count !== 1) throw new ConflictException('Operation claim is stale');
      await tx.operationLock.deleteMany({ where: { operationId } });
    });
  }

  async requireAttention(
    operationId: string,
    leaseOwner: string,
    message: string,
  ): Promise<void> {
    const updated = await this.prisma.operation.updateMany({
      where: { id: operationId, leaseOwner },
      data: {
        status: 'NEEDS_ATTENTION',
        currentStep: null,
        errorMessage: message,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        completedAt: new Date(),
      },
    });
    if (updated.count !== 1) throw new ConflictException('Operation claim is stale');
  }

  async requestCancellation(
    operationId: string,
    userId: string,
    role: string,
  ): Promise<unknown> {
    const operation = await this.prisma.operation.findUnique({
      where: { id: operationId },
      include: { site: { select: { userId: true } } },
    });
    if (!operation) throw new NotFoundException('Operation not found');
    if (
      role !== 'ADMIN' &&
      operation.createdByUserId !== userId &&
      operation.site?.userId !== userId
    ) {
      throw new ForbiddenException('Access denied');
    }
    if (['CANCELLED', 'SUCCEEDED', 'FAILED'].includes(operation.status)) {
      return this.getById(operationId, userId, role);
    }
    if (['UNKNOWN_RECOVERY_REQUIRED', 'NEEDS_ATTENTION'].includes(operation.status)) {
      throw new ConflictException('Operation requires manual reconciliation');
    }

    await this.prisma.$transaction(async (tx) => {
      if (['PENDING', 'QUEUED', 'RECOVERING'].includes(operation.status)) {
        const cancelled = await tx.operation.updateMany({
          where: {
            id: operationId,
            status: operation.status,
            cancelRequestedAt: null,
          },
          data: {
            status: 'CANCELLED',
            cancelRequestedAt: new Date(),
            cancelOutcome: 'CANCELLED',
            completedAt: new Date(),
            currentStep: null,
          },
        });
        if (cancelled.count !== 1) throw new ConflictException('Operation state changed');
        await tx.operationLock.deleteMany({ where: { operationId } });
        return;
      }
      const requested = await tx.operation.updateMany({
        where: {
          id: operationId,
          status: { in: ['CLAIMED', 'RUNNING'] },
          cancelRequestedAt: null,
        },
        data: {
          status: 'CANCEL_REQUESTED',
          cancelRequestedAt: new Date(),
          cancelOutcome: 'PENDING',
        },
      });
      if (requested.count !== 1) throw new ConflictException('Operation state changed');
    });
    return this.getById(operationId, userId, role);
  }

  async list(
    userId: string,
    role: string,
    options: { limit?: number; cursor?: string; status?: string } = {},
  ): Promise<{ items: unknown[]; nextCursor: string | null }> {
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit || 25)));
    const rows = await this.prisma.operation.findMany({
      where: {
        ...(options.status ? { status: options.status } : {}),
        ...(role === 'ADMIN'
          ? {}
          : {
              OR: [
                { createdByUserId: userId },
                { site: { userId } },
              ],
            }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      take: limit + 1,
      select: { id: true },
    });
    const page = rows.slice(0, limit);
    const items = await Promise.all(
      page.map(({ id }) => this.getById(id, userId, role)),
    );
    return {
      items,
      nextCursor: rows.length > limit ? page[page.length - 1]?.id ?? null : null,
    };
  }

  async attachScope(
    operationId: string,
    scope: { siteId: string; siteDomainId?: string | null },
  ): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.attachScopeWithClient(tx, operationId, scope);
      });
    } catch (error) {
      const lockSpecs = operationLockSpecs({
        siteId: scope.siteId,
        siteDomainId: scope.siteDomainId,
        parentOperationId: null,
      });
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException({
          message: 'Operation scope is locked',
          operation: await this.findResourceLock(
            lockSpecs.map((lock) => lock.resourceKey),
          ),
        });
      }
      if (isTransactionContention(error)) {
        throw new ConflictException('Operation scope is busy');
      }
      throw error;
    }
  }

  /**
   * Attach the operation before the transaction that creates a Site commits.
   * This prevents backup/scheduler code from observing an unlocked new Site.
   */
  async attachCreatedSiteScope(
    tx: Prisma.TransactionClient,
    operationId: string,
    scope: { siteId: string; siteDomainId?: string | null },
  ): Promise<void> {
    await this.attachScopeWithClient(tx, operationId, scope);
  }

  private async attachScopeWithClient(
    tx: Prisma.TransactionClient,
    operationId: string,
    scope: { siteId: string; siteDomainId?: string | null },
  ): Promise<void> {
    const lockSpecs = operationLockSpecs({
      siteId: scope.siteId,
      siteDomainId: scope.siteDomainId,
      parentOperationId: null,
    });
    const operation = await tx.operation.findFirst({
      where: {
        id: operationId,
        status: { in: [...EXECUTING_STATUSES] },
      },
      select: {
        id: true,
        locks: {
          where: {
            resourceKey: {
              in: lockSpecs.map((lock) => lock.resourceKey),
            },
          },
          select: { resourceKey: true },
        },
      },
    });
    if (!operation) {
      throw new ConflictException('Operation is not active');
    }
    const activeBackup = await tx.backup.findFirst({
      where: {
        siteId: scope.siteId,
        status: { in: ['PENDING', 'IN_PROGRESS'] },
      },
      select: { id: true, status: true },
    });
    if (activeBackup) {
      throw new ConflictException({
        message: 'Site backup is active',
        backup: activeBackup,
      });
    }
    await this.assertScopeHierarchyAvailable(
      tx,
      {
        siteId: scope.siteId,
        siteDomainId: scope.siteDomainId,
        lockSite: true,
      },
      operationId,
    );
    const owned = new Set(
      operation.locks.map((lock) => lock.resourceKey),
    );
    const missing = lockSpecs.filter(
      (lock) => !owned.has(lock.resourceKey),
    );
    if (missing.length > 0) {
      await tx.operationLock.createMany({
        data: missing.map((lock) => ({
          ...lock,
          operationId,
        })),
      });
    }
    const updated = await tx.operation.updateMany({
      where: { id: operationId, status: { in: [...EXECUTING_STATUSES] } },
      data: {
        siteId: scope.siteId,
        siteDomainId: scope.siteDomainId || null,
      },
    });
    if (updated.count !== 1) {
      throw new ConflictException('Operation is not active');
    }
  }

  private async assertScopeHierarchyAvailable(
    tx: Prisma.TransactionClient,
    input: Pick<
      BeginOperationInput,
      'siteId' | 'siteDomainId' | 'databaseId' | 'lockSite' | 'parentOperationId'
    >,
    excludeOperationId?: string,
  ): Promise<void> {
    const siteId = input.siteId;
    if (!siteId) return;

    const siteLock = await tx.operationLock.findUnique({
      where: { resourceKey: `site:${siteId}` },
      select: {
        operationId: true,
        operation: {
          select: {
            id: true,
            type: true,
            status: true,
            currentStep: true,
          },
        },
      },
    });

    if (input.parentOperationId) {
      if (
        siteLock &&
        siteLock.operationId !== input.parentOperationId &&
        siteLock.operationId !== excludeOperationId
      ) {
        throw new ConflictException({
          message: 'Operation scope is locked',
          operation: siteLock.operation,
        });
      }
      return;
    }

    if (input.lockSite === false) {
      if (siteLock && siteLock.operationId !== excludeOperationId) {
        throw new ConflictException({
          message: 'Operation scope is locked',
          operation: siteLock.operation,
        });
      }
      return;
    }

    const nestedLock = await tx.operationLock.findFirst({
      where: {
        kind: { in: ['DOMAIN', 'DATABASE'] },
        ...(excludeOperationId
          ? { operationId: { not: excludeOperationId } }
          : {}),
        operation: {
          siteId,
          status: { in: [...LOCK_HOLDING_STATUSES] },
        },
      },
      select: {
        operation: {
          select: {
            id: true,
            type: true,
            status: true,
            currentStep: true,
          },
        },
      },
    });
    if (nestedLock) {
      throw new ConflictException({
        message: 'Operation scope is locked',
        operation: nestedLock.operation,
      });
    }
  }

  async step(operationId: string, step: string, progress: number): Promise<void> {
    const updated = await this.prisma.operation.updateMany({
      where: { id: operationId, status: 'RUNNING' },
      data: {
        currentStep: step,
        progress: Math.max(0, Math.min(99, Math.trunc(progress))),
      },
    });
    if (updated.count !== 1) {
      throw new ConflictException('Operation is not running');
    }
  }

  async succeed(operationId: string, result: unknown = null): Promise<void> {
    assertNoSecretFields(result);
    await this.prisma.$transaction(async (tx) => {
      const activeChild = await tx.operation.findFirst({
        where: {
          parentOperationId: operationId,
          status: { in: [...LOCK_HOLDING_STATUSES] },
        },
        select: { id: true, type: true, status: true, currentStep: true },
      });
      if (activeChild) {
        throw new ConflictException({
          message: 'Child operation is still active',
          operation: activeChild,
        });
      }
      const updated = await tx.operation.updateMany({
        where: { id: operationId, status: 'RUNNING' },
        data: {
          status: 'SUCCEEDED',
          currentStep: null,
          progress: 100,
          result: result === undefined ? null : JSON.stringify(result),
          errorMessage: null,
          completedAt: new Date(),
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException('Operation is not running');
      }
      await tx.operationLock.deleteMany({ where: { operationId } });
    });
  }

  async fail(operationId: string, error: unknown): Promise<void> {
    const message = safeErrorMessage(error);
    await this.prisma.$transaction(async (tx) => {
      const activeChildren = await tx.operation.findMany({
        where: {
          parentOperationId: operationId,
          status: { in: [...LOCK_HOLDING_STATUSES] },
        },
        select: { id: true },
      });
      const childIds = activeChildren.map((child) => child.id);
      if (childIds.length > 0) {
        await tx.operation.updateMany({
          where: {
            id: { in: childIds },
            status: { in: [...LOCK_HOLDING_STATUSES] },
          },
          data: {
            status: 'FAILED',
            currentStep: null,
            errorMessage: message,
            completedAt: new Date(),
          },
        });
        await tx.operationLock.deleteMany({
          where: { operationId: { in: childIds } },
        });
      }
      await tx.operation.updateMany({
        where: { id: operationId, status: { in: [...LOCK_HOLDING_STATUSES] } },
        data: {
          status: 'FAILED',
          currentStep: null,
          errorMessage: message,
          completedAt: new Date(),
        },
      });
      await tx.operationLock.deleteMany({ where: { operationId } });
    });
  }

  async getById(
    operationId: string,
    userId: string,
    role: string,
  ): Promise<unknown> {
    const operation = await this.prisma.operation.findUnique({
      where: { id: operationId },
      include: {
        site: { select: { userId: true } },
        locks: { orderBy: { resourceKey: 'asc' } },
        childOperations: {
          orderBy: { createdAt: 'asc' },
          include: { locks: { orderBy: { resourceKey: 'asc' } } },
        },
      },
    });
    if (!operation) throw new NotFoundException('Operation not found');
    if (
      role !== 'ADMIN' &&
      operation.createdByUserId !== userId &&
      operation.site?.userId !== userId
    ) {
      throw new ForbiddenException('Access denied');
    }
    return {
      id: operation.id,
      type: operation.type,
      status: operation.status,
      siteId: operation.siteId,
      siteDomainId: operation.siteDomainId,
      databaseId: operation.databaseId,
      parentOperationId: operation.parentOperationId,
      locks: operation.locks.map((lock) => ({
        kind: lock.kind,
        resourceKey: lock.resourceKey,
      })),
      currentStep: operation.currentStep,
      progress: operation.progress,
      actionId: operation.actionId,
      executionMode: operation.executionMode,
      policySnapshot: parsePolicySnapshot(operation.policySnapshot),
      attempt: operation.attempt,
      maxAttempts: operation.maxAttempts,
      retryable: operation.retryable,
      recoveryPolicy: operation.recoveryPolicy,
      leaseOwner: operation.leaseOwner,
      leaseExpiresAt: operation.leaseExpiresAt,
      heartbeatAt: operation.heartbeatAt,
      claimedAt: operation.claimedAt,
      deadlineAt: operation.deadlineAt,
      cancelRequestedAt: operation.cancelRequestedAt,
      cancelOutcome: operation.cancelOutcome,
      result: parseResult(operation.result),
      errorMessage: operation.errorMessage,
      startedAt: operation.startedAt,
      completedAt: operation.completedAt,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
      childOperations: operation.childOperations.map((child) => ({
        id: child.id,
        type: child.type,
        status: child.status,
        siteId: child.siteId,
        siteDomainId: child.siteDomainId,
        databaseId: child.databaseId,
        locks: child.locks.map((lock) => ({
          kind: lock.kind,
          resourceKey: lock.resourceKey,
        })),
        currentStep: child.currentStep,
        progress: child.progress,
        actionId: child.actionId,
        executionMode: child.executionMode,
        policySnapshot: parsePolicySnapshot(child.policySnapshot),
        attempt: child.attempt,
        maxAttempts: child.maxAttempts,
        retryable: child.retryable,
        recoveryPolicy: child.recoveryPolicy,
        leaseOwner: child.leaseOwner,
        leaseExpiresAt: child.leaseExpiresAt,
        heartbeatAt: child.heartbeatAt,
        claimedAt: child.claimedAt,
        deadlineAt: child.deadlineAt,
        cancelRequestedAt: child.cancelRequestedAt,
        cancelOutcome: child.cancelOutcome,
        result: parseResult(child.result),
        errorMessage: child.errorMessage,
        startedAt: child.startedAt,
        completedAt: child.completedAt,
        createdAt: child.createdAt,
        updatedAt: child.updatedAt,
      })),
    };
  }

  private async findResourceLock(resourceKeys: string[]): Promise<{
    id: string;
    type: string;
    status: string;
    currentStep: string | null;
  } | null> {
    if (resourceKeys.length === 0) return null;
    const lock = await this.prisma.operationLock.findFirst({
      where: {
        resourceKey: { in: resourceKeys },
        operation: { status: { in: [...LOCK_HOLDING_STATUSES] } },
      },
      select: {
        operation: {
          select: {
            id: true,
            type: true,
            status: true,
            currentStep: true,
          },
        },
      },
    });
    return lock?.operation || null;
  }

  private assertReplay(
    existing: {
      type: string;
      siteId: string | null;
      siteDomainId: string | null;
      databaseId: string | null;
      globalLockKey: string | null;
      parentOperationId: string | null;
      createdByUserId: string;
      requestHash: string;
    },
    input: BeginOperationInput,
    requestHash: string,
  ): void {
    if (
      existing.type !== input.type ||
      existing.createdByUserId !== input.userId ||
      existing.requestHash !== requestHash
    ) {
      throw new ConflictException(
        'Idempotency-Key was already used for a different request',
      );
    }
  }
}
