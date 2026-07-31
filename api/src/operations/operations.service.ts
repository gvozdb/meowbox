import {
  ConflictException,
  ForbiddenException,
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
import { safeErrorMessage } from '@meowbox/shared';

const ACTIVE_STATUSES = ['PENDING', 'RUNNING'] as const;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const GLOBAL_LOCK_KEY = /^[a-z][a-z0-9:-]{0,63}$/;
const RESTART_FAILURE =
  'Interrupted by API restart; retry with a new idempotency key';
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

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
}

function parseResult(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function assertSafeResult(value: unknown, path = 'result'): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeResult(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/(password|secret|token|credential|private.?key|envvars)/i.test(key)) {
      throw new Error(`Operation result contains forbidden secret field: ${path}.${key}`);
    }
    assertSafeResult(nested, `${path}.${key}`);
  }
}

@Injectable()
export class OperationsService implements OnModuleInit {
  private readonly logger = new Logger(OperationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    const interrupted = await this.prisma.operation.findMany({
      where: { status: { in: [...ACTIVE_STATUSES] } },
      select: { id: true, siteId: true, siteDomainId: true },
    });
    if (interrupted.length === 0) return;

    const completedAt = new Date();
    const operationIds = interrupted.map(({ id }) => id);
    const siteDomainIds = [
      ...new Set(
        interrupted
          .map(({ siteDomainId }) => siteDomainId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const siteIds = [
      ...new Set(
        interrupted
          .map(({ siteId }) => siteId)
          .filter((id): id is string => id !== null),
      ),
    ];

    await this.prisma.$transaction([
      this.prisma.operation.updateMany({
        where: {
          id: { in: operationIds },
          status: { in: [...ACTIVE_STATUSES] },
        },
        data: {
          status: 'FAILED',
          currentStep: null,
          errorMessage: RESTART_FAILURE,
          completedAt,
        },
      }),
      this.prisma.siteDomain.updateMany({
        where: {
          id: { in: siteDomainIds },
          appStatus: { in: [...TRANSITIONAL_APP_STATUSES] },
        },
        data: {
          appStatus: 'ERROR',
          appErrorMessage: RESTART_FAILURE,
        },
      }),
      this.prisma.site.updateMany({
        where: {
          id: { in: siteIds },
          status: 'DEPLOYING',
        },
        data: {
          status: 'ERROR',
          errorMessage: RESTART_FAILURE,
        },
      }),
      this.prisma.deployLog.updateMany({
        where: {
          operationId: { in: operationIds },
          status: { in: ['PENDING', 'IN_PROGRESS'] },
        },
        data: {
          status: 'FAILED',
          completedAt,
        },
      }),
      this.prisma.operationLock.deleteMany({
        where: { operationId: { in: operationIds } },
      }),
    ]);

    this.logger.warn(
      `Marked ${interrupted.length} interrupted operation(s) as failed`,
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

    try {
      const created = await this.prisma.$transaction(async (tx) => {
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
            !ACTIVE_STATUSES.includes(
              parent.status as (typeof ACTIVE_STATUSES)[number],
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
            idempotencyKey,
            requestHash,
            type: input.type,
            siteId: input.siteId || null,
            siteDomainId: input.siteDomainId || null,
            databaseId: input.databaseId || null,
            globalLockKey,
            parentOperationId: input.parentOperationId || null,
            createdByUserId: input.userId,
            status: 'PENDING',
            progress: 0,
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
              status: { in: [...ACTIVE_STATUSES] },
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
        status: { in: [...ACTIVE_STATUSES] },
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
      where: { id: operationId, status: { in: [...ACTIVE_STATUSES] } },
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
          status: { in: [...ACTIVE_STATUSES] },
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
    assertSafeResult(result);
    await this.prisma.$transaction(async (tx) => {
      const activeChild = await tx.operation.findFirst({
        where: {
          parentOperationId: operationId,
          status: { in: [...ACTIVE_STATUSES] },
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
          status: { in: [...ACTIVE_STATUSES] },
        },
        select: { id: true },
      });
      const childIds = activeChildren.map((child) => child.id);
      if (childIds.length > 0) {
        await tx.operation.updateMany({
          where: {
            id: { in: childIds },
            status: { in: [...ACTIVE_STATUSES] },
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
        where: { id: operationId, status: { in: [...ACTIVE_STATUSES] } },
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
        operation: { status: { in: [...ACTIVE_STATUSES] } },
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
