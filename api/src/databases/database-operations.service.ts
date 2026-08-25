import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { safeErrorMessage, type TransferSessionDelivery } from '@meowbox/shared';
import { createReadStream } from 'node:fs';
import { lstat, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { createHmac } from 'node:crypto';
import { hashPassword } from '../common/crypto/argon2.helper';
import { encryptDbPassword } from '../common/crypto/database-cipher';
import { deriveKey } from '../common/crypto/master-key';
import { DatabaseType } from '../common/enums';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { OperationAdmissionService } from '../operations/operation-admission.service';
import { OperationSensitiveResultService } from '../operations/operation-sensitive-result.service';
import {
  OperationCancelledError,
  OperationsWorkerService,
  type OperationExecutionContext,
} from '../operations/operations-worker.service';
import {
  OperationFailedError,
  OperationNeedsAttentionError,
} from '../operations/operation-errors';
import { DatabasesService } from './databases.service';
import { getDatabaseExportsDir } from './database-paths';
import {
  assertSafeFilePath,
} from '../common/validators/safe-path';
import { TransferArtifactService } from '../transfers/transfer-artifact.service';
import { TransferSessionService } from '../transfers/transfer-session.service';
import { CreateDatabaseDto } from './databases.dto';

const DATABASE_CREATE_ACTION = 'database.create';
const DATABASE_RESET_PASSWORD_ACTION = 'database.reset_password';
const DATABASE_DELETE_ACTION = 'database.delete';
const DATABASE_EXPORT_ACTION = 'database.export.stage';
const DATABASE_IMPORT_ACTION = 'database.import';
const DATABASE_ARTIFACT_TTL_MS = 4 * 60 * 60_000;
const DATABASE_AGENT_ACTIONS = {
  EXPORT: 'agent.database.export',
  DROP: 'agent.database.drop',
  CREATE: 'agent.database.create',
  IMPORT: 'agent.database.import',
  RESET_PASSWORD: 'agent.database.reset_password',
} as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,128}$/;

function deterministicDatabaseMaterial(
  purpose: 'create' | 'reset-password',
  idempotencyKey: string | undefined,
  actorUserId: string,
  resource: string,
): { databaseId: string; password: string } {
  const key = idempotencyKey?.trim();
  if (!key || !IDEMPOTENCY_KEY.test(key)) {
    throw new BadRequestException('Idempotency-Key must be 8-128 printable ASCII characters');
  }
  const material = `${purpose}\0${actorUserId}\0${resource}\0${key}`;
  const uuidBytes = createHmac('sha256', deriveKey('operations'))
    .update('MEOWBOX-DATABASE-ID-V1\0')
    .update(material)
    .digest()
    .subarray(0, 16);
  uuidBytes[6] = (uuidBytes[6] & 0x0f) | 0x80;
  uuidBytes[8] = (uuidBytes[8] & 0x3f) | 0x80;
  const hex = uuidBytes.toString('hex');
  const databaseId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const password = createHmac('sha256', deriveKey('operations'))
    .update('MEOWBOX-DATABASE-PASSWORD-V1\0')
    .update(material)
    .digest('base64url')
    .slice(0, 24);
  return { databaseId, password };
}

interface DatabaseDeleteRequest {
  siteId: string;
  domainId: string;
  databaseId: string;
}

interface DatabaseExportRequest extends DatabaseDeleteRequest {}

interface DatabaseImportRequest extends DatabaseDeleteRequest {
  uploadSessionId: string;
}

interface DatabaseCreateRequest {
  siteId: string;
  domainId: string;
  databaseId: string;
  name: string;
  type: 'MARIADB' | 'MYSQL' | 'POSTGRESQL';
  dbUser: string;
  purpose: 'APP_PRIMARY' | 'AUXILIARY';
  password: string;
}

interface DatabaseResetPasswordRequest extends DatabaseDeleteRequest {
  password: string;
}

@Injectable()
export class DatabaseOperationsService implements OnModuleInit, OnModuleDestroy {
  private readonly unregisterHandlers: Array<() => void> = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly relay: AgentRelayService,
    private readonly databases: DatabasesService,
    private readonly admission: OperationAdmissionService,
    private readonly worker: OperationsWorkerService,
    private readonly artifacts: TransferArtifactService,
    private readonly transfers: TransferSessionService,
    private readonly sensitiveResults: OperationSensitiveResultService,
  ) {}

  onModuleInit(): void {
    this.unregisterHandlers.push(
      this.worker.registerHandler(
        DATABASE_CREATE_ACTION,
        (request, context) => this.executeCreate(request, context),
      ),
      this.worker.registerHandler(
        DATABASE_RESET_PASSWORD_ACTION,
        (request, context) => this.executeResetPassword(request, context),
      ),
      this.worker.registerHandler(
        DATABASE_DELETE_ACTION,
        (request, context) => this.executeDelete(request, context),
      ),
      this.worker.registerHandler(
        DATABASE_EXPORT_ACTION,
        (request, context) => this.executeExport(request, context),
      ),
      this.worker.registerHandler(
        DATABASE_IMPORT_ACTION,
        (request, context) => this.executeImport(request, context),
      ),
    );
  }

  onModuleDestroy(): void {
    for (const unregister of this.unregisterHandlers.splice(0)) unregister();
  }

  async enqueueCreate(
    siteId: string,
    domainId: string,
    dto: CreateDatabaseDto,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    this.assertAdmin(actor.role, 'create databases');
    await this.databases.assertCreateAllowed(
      siteId,
      domainId,
      dto,
      actor.userId,
      actor.role,
    );
    this.assertAgentConnected('database creation');
    const material = deterministicDatabaseMaterial(
      'create',
      idempotencyKey,
      actor.userId,
      `${siteId}:${domainId}:${dto.type}:${dto.name}`,
    );
    const dbUser = dto.dbUser || `u_${dto.name}`.substring(0, 32);
    return this.admission.admit({
      actionId: DATABASE_CREATE_ACTION,
      type: 'DATABASE_CREATE',
      idempotencyKey,
      actor,
      request: {
        siteId,
        domainId,
        databaseId: material.databaseId,
        name: dto.name,
        type: dto.type as DatabaseCreateRequest['type'],
        dbUser,
        purpose: dto.purpose || 'AUXILIARY',
        password: material.password,
      } satisfies DatabaseCreateRequest,
      deadlineMs: 30 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      globalLockKey: `database-create:${material.databaseId}`,
      siteId,
      siteDomainId: domainId,
      lockSite: false,
    });
  }

  async enqueueResetPassword(
    siteId: string,
    domainId: string,
    databaseId: string,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    this.assertAdmin(actor.role, 'reset database passwords');
    await this.databases.findById(
      siteId,
      domainId,
      databaseId,
      actor.userId,
      actor.role,
    );
    this.assertAgentConnected('database password reset');
    const material = deterministicDatabaseMaterial(
      'reset-password',
      idempotencyKey,
      actor.userId,
      `${siteId}:${domainId}:${databaseId}`,
    );
    return this.admission.admit({
      actionId: DATABASE_RESET_PASSWORD_ACTION,
      type: 'DATABASE_RESET_PASSWORD',
      idempotencyKey,
      actor,
      request: {
        siteId,
        domainId,
        databaseId,
        password: material.password,
      } satisfies DatabaseResetPasswordRequest,
      deadlineMs: 30 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      siteId,
      siteDomainId: domainId,
      databaseId,
      lockSite: false,
    });
  }

  async enqueueDelete(
    siteId: string,
    domainId: string,
    databaseId: string,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    if (actor.role !== 'ADMIN') throw new ConflictException('Only ADMIN can delete databases');
    const database = await this.databases.findById(
      siteId,
      domainId,
      databaseId,
      actor.userId,
      actor.role,
    );
    this.assertDeletionAllowed(database);
    if (!this.relay.isAgentConnected()) {
      throw new ConflictException('Agent is offline; database deletion is unavailable');
    }
    return this.admission.admit({
      actionId: DATABASE_DELETE_ACTION,
      type: 'DATABASE_DELETE',
      idempotencyKey,
      actor,
      request: { siteId, domainId, databaseId },
      deadlineMs: 45 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      siteId,
      siteDomainId: domainId,
      databaseId,
      lockSite: false,
    });
  }

  async enqueueExport(
    siteId: string,
    domainId: string,
    databaseId: string,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    this.assertAdmin(actor.role, 'export databases');
    await this.databases.findById(
      siteId,
      domainId,
      databaseId,
      actor.userId,
      actor.role,
    );
    this.assertAgentConnected('database export');
    return this.admission.admit({
      actionId: DATABASE_EXPORT_ACTION,
      type: 'DATABASE_EXPORT_STAGE',
      idempotencyKey,
      actor,
      request: { siteId, domainId, databaseId },
      deadlineMs: 24 * 60 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      siteId,
      siteDomainId: domainId,
      databaseId,
      lockSite: false,
    });
  }

  async issueExportDelivery(
    siteId: string,
    domainId: string,
    databaseId: string,
    operationId: string,
    actor: { userId: string; role: string },
  ): Promise<TransferSessionDelivery> {
    this.assertAdmin(actor.role, 'download database exports');
    await this.databases.findById(
      siteId,
      domainId,
      databaseId,
      actor.userId,
      actor.role,
    );
    const operation = await this.prisma.operation.findUnique({
      where: { id: operationId },
      select: {
        status: true,
        actionId: true,
        siteId: true,
        siteDomainId: true,
        databaseId: true,
        createdByUserId: true,
        result: true,
      },
    });
    if (
      !operation || operation.status !== 'SUCCEEDED' ||
      operation.actionId !== DATABASE_EXPORT_ACTION ||
      operation.siteId !== siteId || operation.siteDomainId !== domainId ||
      operation.databaseId !== databaseId || operation.createdByUserId !== actor.userId
    ) throw new GoneException('Database export operation is unavailable');
    const result = this.parseExportOperationResult(operation.result, databaseId);
    const artifact = await this.prisma.transferArtifact.findUnique({
      where: { id: result.artifactId },
    });
    if (
      !artifact || artifact.state !== 'READY' || artifact.deletedAt ||
      artifact.sourceKind !== 'DATABASE_EXPORT' || artifact.resourceId !== operationId ||
      artifact.createdByUserId !== actor.userId ||
      artifact.sizeBytes !== BigInt(result.sizeBytes) || artifact.sha256 !== result.sha256
    ) throw new GoneException('Database export artifact is unavailable');
    return this.transfers.issueStagedArtifact({
      artifactId: result.artifactId,
      actor,
    });
  }

  async createImportSession(
    siteId: string,
    domainId: string,
    databaseId: string,
    actor: { userId: string; role: string },
    input: { filename: string; contentLength: number },
    idempotencyKey?: string,
  ): Promise<TransferSessionDelivery> {
    this.assertAdmin(actor.role, 'import databases');
    await this.databases.findById(
      siteId,
      domainId,
      databaseId,
      actor.userId,
      actor.role,
    );
    const filename = this.validateImportFilename(input.filename);
    if (!Number.isSafeInteger(input.contentLength) || input.contentLength <= 0) {
      throw new BadRequestException('Database import file must have a positive length');
    }
    return this.transfers.issueStagedUpload({
      sourceKind: 'DATABASE_IMPORT',
      resourceId: databaseId,
      actor,
      filename,
      contentType: 'application/octet-stream',
      contentLength: input.contentLength,
      resourceExpiresAt: new Date(Date.now() + DATABASE_ARTIFACT_TTL_MS),
      idempotencyKey: idempotencyKey ?? '',
    });
  }

  async enqueueImport(
    siteId: string,
    domainId: string,
    databaseId: string,
    uploadSessionId: string,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    this.assertAdmin(actor.role, 'import databases');
    if (!UUID.test(uploadSessionId)) throw new BadRequestException('Upload session is invalid');
    await this.databases.findById(
      siteId,
      domainId,
      databaseId,
      actor.userId,
      actor.role,
    );
    await this.artifacts.requireUploadedArtifact({
      sessionId: uploadSessionId,
      sourceKind: 'DATABASE_IMPORT',
      resourceId: databaseId,
      actorUserId: actor.userId,
    });
    this.assertAgentConnected('database import');
    return this.admission.admit({
      actionId: DATABASE_IMPORT_ACTION,
      type: 'DATABASE_IMPORT',
      idempotencyKey,
      actor,
      request: { siteId, domainId, databaseId, uploadSessionId },
      deadlineMs: 24 * 60 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      siteId,
      siteDomainId: domainId,
      databaseId,
      lockSite: false,
    });
  }

  private async executeCreate(
    request: unknown,
    context: OperationExecutionContext,
  ): Promise<{
    databaseId: string;
    sensitiveResult: ReturnType<OperationSensitiveResultService['seal']>;
  }> {
    const input = this.parseCreateRequest(request);
    this.assertOperationAdmin(context, 'Database creation');
    const existing = await this.prisma.database.findUnique({
      where: { id: input.databaseId },
    });
    if (existing) {
      if (
        existing.siteId !== input.siteId ||
        existing.siteDomainId !== input.domainId ||
        existing.name !== input.name ||
        existing.type !== input.type ||
        existing.dbUser !== input.dbUser ||
        existing.purpose !== input.purpose ||
        this.databases.getPlainPassword(existing) !== input.password
      ) {
        throw new OperationNeedsAttentionError(
          'Database creation postcondition conflicts with persisted metadata',
        );
      }
      return this.databaseCredentialResult(context.operationId, input);
    }

    let physicalCreateConfirmed = false;
    if (context.recovering) {
      const state = await this.agentJobState(context.operationId, 'create');
      if (state === 'SUCCEEDED') physicalCreateConfirmed = true;
      else if (state === 'FAILED' || state === 'CANCELLED') {
        throw new OperationFailedError('Database creation failed before metadata commit');
      } else {
        throw new OperationNeedsAttentionError(
          'Database creation outcome is unknown; reconcile the physical database before retrying',
        );
      }
    } else {
      await this.databases.assertCreateAllowed(
        input.siteId,
        input.domainId,
        {
          name: input.name,
          type: input.type,
          dbUser: input.dbUser,
          purpose: input.purpose,
        },
        context.actor.userId,
        context.actor.role,
      );
      await context.throwIfCancellationRequested();
      await context.heartbeat('create', 20);
      await this.relay.runAgentJob(
        {
          operationId: context.operationId,
          actionId: DATABASE_AGENT_ACTIONS.CREATE,
          step: 'create',
          payload: {
            name: input.name,
            type: input.type,
            dbUser: input.dbUser,
            password: input.password,
          },
          deadlineAt: context.deadlineAt,
          cancelSafe: false,
        },
        () => context.isCancellationRequested(),
      );
      physicalCreateConfirmed = true;
    }

    try {
      await context.heartbeat('commit-metadata', 85);
      await this.prisma.database.create({
        data: {
          id: input.databaseId,
          name: input.name,
          type: input.type as DatabaseType,
          dbUser: input.dbUser,
          dbPasswordHash: await hashPassword(input.password),
          dbPasswordEnc: encryptDbPassword(input.password),
          siteId: input.siteId,
          siteDomainId: input.domainId,
          purpose: input.purpose,
        },
      });
    } catch (error) {
      if (!physicalCreateConfirmed || context.recovering) {
        throw new OperationNeedsAttentionError(
          `${safeErrorMessage(error, 'Database metadata commit failed')}; reconcile the physical database`,
        );
      }
      try {
        await context.heartbeat('rollback-drop', 92);
        await this.relay.runAgentJob(
          {
            operationId: context.operationId,
            actionId: DATABASE_AGENT_ACTIONS.DROP,
            step: 'rollback-drop',
            payload: {
              name: input.name,
              type: input.type,
              dbUser: input.dbUser,
            },
            deadlineAt: context.deadlineAt,
            cancelSafe: false,
          },
          async () => false,
        );
      } catch (rollbackError) {
        throw new OperationNeedsAttentionError(
          `${safeErrorMessage(error, 'Database metadata commit failed')}; physical rollback failed: ${safeErrorMessage(rollbackError)}`,
        );
      }
      throw new OperationFailedError(safeErrorMessage(error, 'Database metadata commit failed'));
    }
    return this.databaseCredentialResult(context.operationId, input);
  }

  private async executeResetPassword(
    request: unknown,
    context: OperationExecutionContext,
  ): Promise<{
    databaseId: string;
    sensitiveResult: ReturnType<OperationSensitiveResultService['seal']>;
  }> {
    const input = this.parseResetPasswordRequest(request);
    this.assertOperationAdmin(context, 'Database password reset');
    const database = await this.databases.findById(
      input.siteId,
      input.domainId,
      input.databaseId,
      context.actor.userId,
      context.actor.role,
    );
    try {
      if (this.databases.getPlainPassword(database) === input.password) {
        return this.databaseCredentialResult(context.operationId, {
          ...input,
          name: database.name,
          type: database.type as DatabaseCreateRequest['type'],
          dbUser: database.dbUser,
          purpose: database.purpose as DatabaseCreateRequest['purpose'],
        });
      }
    } catch {
      // Legacy rows without a decryptable password still support reset.
    }

    if (context.recovering) {
      const state = await this.agentJobState(context.operationId, 'reset-password');
      if (state === 'FAILED' || state === 'CANCELLED') {
        throw new OperationFailedError('Database password reset failed');
      }
      if (state !== 'SUCCEEDED') {
        throw new OperationNeedsAttentionError(
          'Database password reset outcome is unknown; reconcile the physical database before retrying',
        );
      }
    } else {
      await context.throwIfCancellationRequested();
      await context.heartbeat('reset-password', 25);
      await this.relay.runAgentJob(
        {
          operationId: context.operationId,
          actionId: DATABASE_AGENT_ACTIONS.RESET_PASSWORD,
          step: 'reset-password',
          payload: {
            name: database.name,
            type: database.type,
            dbUser: database.dbUser,
            password: input.password,
          },
          deadlineAt: context.deadlineAt,
          cancelSafe: false,
        },
        () => context.isCancellationRequested(),
      );
    }

    try {
      await context.heartbeat('commit-metadata', 90);
      await this.prisma.database.update({
        where: { id: input.databaseId },
        data: {
          dbPasswordHash: await hashPassword(input.password),
          dbPasswordEnc: encryptDbPassword(input.password),
        },
      });
    } catch (error) {
      throw new OperationNeedsAttentionError(
        `${safeErrorMessage(error, 'Database password metadata commit failed')}; physical password was already changed`,
      );
    }
    return this.databaseCredentialResult(context.operationId, {
      ...input,
      name: database.name,
      type: database.type as DatabaseCreateRequest['type'],
      dbUser: database.dbUser,
      purpose: database.purpose as DatabaseCreateRequest['purpose'],
    });
  }

  private async executeExport(
    request: unknown,
    context: OperationExecutionContext,
  ): Promise<{
    databaseId: string;
    artifactId: string;
    sizeBytes: number;
    sha256: string;
  }> {
    const input = this.parseDatabaseRequest(request, 'export');
    this.assertOperationAdmin(context, 'Database export');
    const existing = await this.prisma.transferArtifact.findFirst({
      where: {
        sourceKind: 'DATABASE_EXPORT',
        resourceId: context.operationId,
        createdByUserId: context.actor.userId,
        state: 'READY',
        deletedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing?.sizeBytes !== null && existing?.sha256) {
      return {
        databaseId: input.databaseId,
        artifactId: existing.id,
        sizeBytes: Number(existing.sizeBytes),
        sha256: existing.sha256,
      };
    }

    const database = await this.databases.findById(
      input.siteId,
      input.domainId,
      input.databaseId,
      context.actor.userId,
      context.actor.role,
    );
    await context.heartbeat('export', 5);
    const exported = await this.relay.runAgentJob(
      {
        operationId: context.operationId,
        actionId: DATABASE_AGENT_ACTIONS.EXPORT,
        step: 'export',
        payload: { name: database.name, type: database.type },
        deadlineAt: context.deadlineAt,
        cancelSafe: true,
      },
      () => context.isCancellationRequested(),
    );
    const exportPath = this.validateExportResult(exported);
    const file = await lstat(exportPath);
    if (!file.isFile() || file.isSymbolicLink() || file.size <= 0) {
      throw new OperationNeedsAttentionError('Database export file is invalid');
    }
    await context.throwIfCancellationRequested();
    await context.heartbeat('stage-artifact', 40);
    const staged = await this.artifacts.stage({
      sourceKind: 'DATABASE_EXPORT',
      resourceId: context.operationId,
      actor: { userId: context.actor.userId, role: context.actor.role },
      filename: path.basename(exportPath),
      contentType: 'application/octet-stream',
      expiresAt: new Date(Date.now() + DATABASE_ARTIFACT_TTL_MS),
      expectedMaxBytes: file.size,
      source: createReadStream(exportPath),
      onProgress: async (sizeBytes) => {
        const progress = Math.max(40, Math.min(95, Math.floor(sizeBytes / file.size * 55) + 40));
        await context.heartbeat('stage-artifact', progress);
      },
    });
    await unlink(exportPath).catch(() => undefined);
    return {
      databaseId: input.databaseId,
      artifactId: staged.artifactId,
      sizeBytes: staged.sizeBytes,
      sha256: staged.sha256,
    };
  }

  private async executeImport(
    request: unknown,
    context: OperationExecutionContext,
  ): Promise<{ databaseId: string }> {
    const input = this.parseImportRequest(request);
    this.assertOperationAdmin(context, 'Database import');
    const database = await this.databases.findById(
      input.siteId,
      input.domainId,
      input.databaseId,
      context.actor.userId,
      context.actor.role,
    );
    const uploaded = await this.artifacts.requireUploadedArtifact({
      sessionId: input.uploadSessionId,
      sourceKind: 'DATABASE_IMPORT',
      resourceId: input.databaseId,
      actorUserId: context.actor.userId,
    });
    const password = this.databases.getPlainPassword(database);
    let snapshotPath: string | null = null;
    let importStarted = false;
    try {
      await context.heartbeat('snapshot', 5);
      const snapshot = await this.relay.runAgentJob(
        {
          operationId: context.operationId,
          actionId: DATABASE_AGENT_ACTIONS.EXPORT,
          step: 'snapshot',
          payload: { name: database.name, type: database.type },
          deadlineAt: context.deadlineAt,
          cancelSafe: true,
        },
        () => context.isCancellationRequested(),
      );
      snapshotPath = this.validateExportResult(snapshot);
      await context.throwIfCancellationRequested();
      await context.heartbeat('import', 35);
      importStarted = true;
      await this.relay.runAgentJob(
        {
          operationId: context.operationId,
          actionId: DATABASE_AGENT_ACTIONS.IMPORT,
          step: 'import',
          payload: {
            name: database.name,
            type: database.type,
            filePath: uploaded.path,
            originalFilename: uploaded.filename,
          },
          deadlineAt: context.deadlineAt,
          cancelSafe: false,
        },
        () => context.isCancellationRequested(),
      );
      await this.artifacts.revoke({
        artifactId: uploaded.artifactId,
        sourceKind: 'DATABASE_IMPORT',
        resourceId: input.databaseId,
        createdByUserId: context.actor.userId,
      });
      return { databaseId: input.databaseId };
    } catch (error) {
      if (error instanceof OperationCancelledError && !importStarted) throw error;
      if (!importStarted) throw new OperationFailedError(safeErrorMessage(error));

      const importJob = await this.prisma.agentJob.findUnique({
        where: {
          operationId_step: {
            operationId: context.operationId,
            step: 'import',
          },
        },
        select: { state: true },
      });
      if (importJob?.state === 'SUCCEEDED') {
        await this.artifacts.revoke({
          artifactId: uploaded.artifactId,
          sourceKind: 'DATABASE_IMPORT',
          resourceId: input.databaseId,
          createdByUserId: context.actor.userId,
        });
        return { databaseId: input.databaseId };
      }
      if (importJob?.state !== 'FAILED' || !snapshotPath) {
        throw new OperationNeedsAttentionError(
          `${safeErrorMessage(error, 'Database import outcome is unknown')}; reconcile the physical database before retrying`,
        );
      }
      const rollbackErrors = await this.restoreDatabaseSnapshot(
        context,
        database,
        password,
        snapshotPath,
        true,
      );
      if (rollbackErrors.length > 0) {
        throw new OperationNeedsAttentionError(
          `${safeErrorMessage(error, 'Database import failed')}; rollback failed: ${rollbackErrors.join('; ')}`,
        );
      }
      throw new OperationFailedError(safeErrorMessage(error, 'Database import failed'));
    }
  }

  private async executeDelete(
    request: unknown,
    context: OperationExecutionContext,
  ): Promise<{ databaseId: string }> {
    const input = this.parseDeleteRequest(request);
    if (context.actor.role !== 'ADMIN') {
      throw new OperationNeedsAttentionError('Database deletion requires ADMIN');
    }
    const exists = await this.prisma.database.findUnique({
      where: { id: input.databaseId },
      select: { id: true },
    });
    if (!exists) {
      const dropJob = await this.prisma.agentJob.findUnique({
        where: {
          operationId_step: {
            operationId: context.operationId,
            step: 'drop',
          },
        },
        select: { state: true },
      });
      if (dropJob?.state === 'SUCCEEDED') return { databaseId: input.databaseId };
      throw new OperationNeedsAttentionError(
        'Database metadata disappeared before a confirmed drop',
      );
    }

    const database = await this.databases.findById(
      input.siteId,
      input.domainId,
      input.databaseId,
      context.actor.userId,
      context.actor.role,
    );
    this.assertDeletionAllowed(database);
    const password = this.databases.getPlainPassword(database);
    let snapshotPath: string | null = null;
    let dropStarted = false;
    let dropConfirmed = false;

    try {
      await context.heartbeat('snapshot', 5);
      const snapshot = await this.relay.runAgentJob(
        {
          operationId: context.operationId,
          actionId: DATABASE_AGENT_ACTIONS.EXPORT,
          step: 'snapshot',
          payload: {
            name: database.name,
            type: database.type,
          },
          deadlineAt: context.deadlineAt,
          cancelSafe: true,
        },
        () => context.isCancellationRequested(),
      );
      snapshotPath = this.validateExportResult(snapshot);
      await context.throwIfCancellationRequested();
      await context.heartbeat('drop', 45);
      dropStarted = true;
      await this.relay.runAgentJob(
        {
          operationId: context.operationId,
          actionId: DATABASE_AGENT_ACTIONS.DROP,
          step: 'drop',
          payload: {
            name: database.name,
            type: database.type,
            dbUser: database.dbUser,
          },
          deadlineAt: context.deadlineAt,
          cancelSafe: false,
        },
        () => context.isCancellationRequested(),
      );
      dropConfirmed = true;
      await context.heartbeat('commit-metadata', 90);
      await this.prisma.database.delete({ where: { id: input.databaseId } });
      return { databaseId: input.databaseId };
    } catch (error) {
      if (error instanceof OperationCancelledError && !dropStarted) throw error;
      if (dropStarted && !dropConfirmed) {
        throw new OperationNeedsAttentionError(
          `${safeErrorMessage(error, 'Database drop outcome is unknown')}; reconcile the physical database before retrying`,
        );
      }
      if (!dropStarted || !snapshotPath) {
        if (error instanceof OperationNeedsAttentionError) throw error;
        throw new OperationFailedError(safeErrorMessage(error));
      }
      const rollbackErrors: string[] = [];
      try {
        await context.heartbeat('rollback-create', 92);
        await this.relay.runAgentJob(
          {
            operationId: context.operationId,
            actionId: DATABASE_AGENT_ACTIONS.CREATE,
            step: 'rollback-create',
            payload: {
              name: database.name,
              type: database.type,
              dbUser: database.dbUser,
              password,
            },
            deadlineAt: context.deadlineAt,
            cancelSafe: false,
          },
          async () => false,
        );
      } catch (rollbackError) {
        rollbackErrors.push(safeErrorMessage(rollbackError, 'database create failed'));
      }
      if (rollbackErrors.length === 0) {
        try {
          await context.heartbeat('rollback-import', 96);
          await this.relay.runAgentJob(
            {
              operationId: context.operationId,
              actionId: DATABASE_AGENT_ACTIONS.IMPORT,
              step: 'rollback-import',
              payload: {
                name: database.name,
                type: database.type,
                filePath: snapshotPath,
              },
              deadlineAt: context.deadlineAt,
              cancelSafe: false,
            },
            async () => false,
          );
        } catch (rollbackError) {
          rollbackErrors.push(safeErrorMessage(rollbackError, 'database import failed'));
        }
      }
      if (rollbackErrors.length > 0) {
        throw new OperationNeedsAttentionError(
          `${safeErrorMessage(error, 'Database deletion failed')}; rollback failed: ${rollbackErrors.join('; ')}`,
        );
      }
      throw new OperationFailedError(safeErrorMessage(error, 'Database deletion failed'));
    }
  }

  private async restoreDatabaseSnapshot(
    context: OperationExecutionContext,
    database: { name: string; type: string; dbUser: string },
    password: string,
    snapshotPath: string,
    dropFirst: boolean,
  ): Promise<string[]> {
    const errors: string[] = [];
    if (dropFirst) {
      try {
        await context.heartbeat('rollback-drop', 88);
        await this.relay.runAgentJob(
          {
            operationId: context.operationId,
            actionId: DATABASE_AGENT_ACTIONS.DROP,
            step: 'rollback-drop',
            payload: {
              name: database.name,
              type: database.type,
              dbUser: database.dbUser,
            },
            deadlineAt: context.deadlineAt,
            cancelSafe: false,
          },
          async () => false,
        );
      } catch (error) {
        errors.push(safeErrorMessage(error, 'database rollback drop failed'));
      }
    }
    if (errors.length === 0) {
      try {
        await context.heartbeat('rollback-create', 92);
        await this.relay.runAgentJob(
          {
            operationId: context.operationId,
            actionId: DATABASE_AGENT_ACTIONS.CREATE,
            step: 'rollback-create',
            payload: {
              name: database.name,
              type: database.type,
              dbUser: database.dbUser,
              password,
            },
            deadlineAt: context.deadlineAt,
            cancelSafe: false,
          },
          async () => false,
        );
      } catch (error) {
        errors.push(safeErrorMessage(error, 'database rollback create failed'));
      }
    }
    if (errors.length === 0) {
      try {
        await context.heartbeat('rollback-import', 96);
        await this.relay.runAgentJob(
          {
            operationId: context.operationId,
            actionId: DATABASE_AGENT_ACTIONS.IMPORT,
            step: 'rollback-import',
            payload: {
              name: database.name,
              type: database.type,
              filePath: snapshotPath,
              originalFilename: path.basename(snapshotPath),
            },
            deadlineAt: context.deadlineAt,
            cancelSafe: false,
          },
          async () => false,
        );
      } catch (error) {
        errors.push(safeErrorMessage(error, 'database rollback import failed'));
      }
    }
    return errors;
  }

  private databaseCredentialResult(
    operationId: string,
    input: DatabaseCreateRequest,
  ): {
    databaseId: string;
    sensitiveResult: ReturnType<OperationSensitiveResultService['seal']>;
  } {
    return {
      databaseId: input.databaseId,
      sensitiveResult: this.sensitiveResults.seal(
        operationId,
        'DATABASE_CREDENTIALS',
        {
          databaseId: input.databaseId,
          name: input.name,
          dbUser: input.dbUser,
          password: input.password,
        },
      ),
    };
  }

  private async agentJobState(
    operationId: string,
    step: string,
  ): Promise<string | null> {
    const job = await this.prisma.agentJob.findUnique({
      where: { operationId_step: { operationId, step } },
      select: { state: true },
    });
    return job?.state ?? null;
  }

  private parseCreateRequest(value: unknown): DatabaseCreateRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new OperationNeedsAttentionError('Database creation request is invalid');
    }
    const input = value as Record<string, unknown>;
    if (
      Object.keys(input).sort().join(',') !==
        'databaseId,dbUser,domainId,name,password,purpose,siteId,type' ||
      typeof input.siteId !== 'string' || !UUID.test(input.siteId) ||
      typeof input.domainId !== 'string' || !UUID.test(input.domainId) ||
      typeof input.databaseId !== 'string' || !UUID.test(input.databaseId) ||
      typeof input.name !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(input.name) ||
      typeof input.dbUser !== 'string' || !/^[A-Za-z0-9_]{1,32}$/.test(input.dbUser) ||
      typeof input.password !== 'string' || !/^[A-Za-z0-9_-]{24}$/.test(input.password) ||
      !['MARIADB', 'MYSQL', 'POSTGRESQL'].includes(String(input.type)) ||
      !['APP_PRIMARY', 'AUXILIARY'].includes(String(input.purpose))
    ) throw new OperationNeedsAttentionError('Database creation request is invalid');
    return input as unknown as DatabaseCreateRequest;
  }

  private parseResetPasswordRequest(value: unknown): DatabaseResetPasswordRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new OperationNeedsAttentionError('Database password reset request is invalid');
    }
    const input = value as Record<string, unknown>;
    if (
      Object.keys(input).sort().join(',') !== 'databaseId,domainId,password,siteId' ||
      typeof input.siteId !== 'string' || !UUID.test(input.siteId) ||
      typeof input.domainId !== 'string' || !UUID.test(input.domainId) ||
      typeof input.databaseId !== 'string' || !UUID.test(input.databaseId) ||
      typeof input.password !== 'string' || !/^[A-Za-z0-9_-]{24}$/.test(input.password)
    ) throw new OperationNeedsAttentionError('Database password reset request is invalid');
    return input as unknown as DatabaseResetPasswordRequest;
  }

  private parseDatabaseRequest(value: unknown, purpose: string): DatabaseExportRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new OperationNeedsAttentionError(`Database ${purpose} request is invalid`);
    }
    const input = value as Record<string, unknown>;
    if (
      Object.keys(input).sort().join(',') !== 'databaseId,domainId,siteId' ||
      typeof input.siteId !== 'string' ||
      typeof input.domainId !== 'string' ||
      typeof input.databaseId !== 'string' ||
      !UUID.test(input.siteId) ||
      !UUID.test(input.domainId) ||
      !UUID.test(input.databaseId)
    ) throw new OperationNeedsAttentionError(`Database ${purpose} request is invalid`);
    return input as unknown as DatabaseExportRequest;
  }

  private parseImportRequest(value: unknown): DatabaseImportRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new OperationNeedsAttentionError('Database import request is invalid');
    }
    const input = value as Record<string, unknown>;
    if (
      Object.keys(input).sort().join(',') !== 'databaseId,domainId,siteId,uploadSessionId' ||
      typeof input.siteId !== 'string' || typeof input.domainId !== 'string' ||
      typeof input.databaseId !== 'string' || typeof input.uploadSessionId !== 'string' ||
      !UUID.test(input.siteId) || !UUID.test(input.domainId) ||
      !UUID.test(input.databaseId) || !UUID.test(input.uploadSessionId)
    ) throw new OperationNeedsAttentionError('Database import request is invalid');
    return input as unknown as DatabaseImportRequest;
  }

  private parseExportOperationResult(
    raw: string | null,
    databaseId: string,
  ): { artifactId: string; sizeBytes: number; sha256: string } {
    let value: unknown;
    try { value = raw ? JSON.parse(raw) : null; } catch { value = null; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new GoneException('Database export result is invalid');
    }
    const result = value as Record<string, unknown>;
    if (
      Object.keys(result).sort().join(',') !== 'artifactId,databaseId,sha256,sizeBytes' ||
      result.databaseId !== databaseId ||
      typeof result.artifactId !== 'string' || !UUID.test(result.artifactId) ||
      typeof result.sizeBytes !== 'number' || !Number.isSafeInteger(result.sizeBytes) || result.sizeBytes <= 0 ||
      typeof result.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(result.sha256)
    ) throw new GoneException('Database export result is invalid');
    return {
      artifactId: result.artifactId,
      sizeBytes: result.sizeBytes,
      sha256: result.sha256,
    };
  }

  private validateImportFilename(value: string): string {
    const filename = String(value || '');
    if (
      path.basename(filename) !== filename ||
      !/^[A-Za-z0-9._-]{1,180}$/.test(filename) ||
      !['.sql', '.sql.gz'].some((extension) =>
        filename.toLowerCase().endsWith(extension))
    ) {
      throw new BadRequestException(
        'Database import must be .sql or .sql.gz',
      );
    }
    return filename;
  }

  private assertAdmin(role: string, action: string): void {
    if (role !== 'ADMIN') throw new ConflictException(`Only ADMIN can ${action}`);
  }

  private assertOperationAdmin(context: OperationExecutionContext, action: string): void {
    if (context.actor.kind !== 'OPERATOR' || context.actor.role !== 'ADMIN') {
      throw new OperationNeedsAttentionError(`${action} requires ADMIN`);
    }
  }

  private assertAgentConnected(action: string): void {
    if (!this.relay.isAgentConnected()) {
      throw new ConflictException(`Agent is offline; ${action} is unavailable`);
    }
  }

  private parseDeleteRequest(value: unknown): DatabaseDeleteRequest {
    return this.parseDatabaseRequest(value, 'deletion');
  }

  private assertDeletionAllowed(database: {
    purpose: string;
    siteDomain: { preset: string };
  }): void {
    if (
      database.purpose === 'APP_PRIMARY' &&
      (database.siteDomain.preset === 'MODX_REVO' ||
        database.siteDomain.preset === 'MODX_3')
    ) {
      throw new ConflictException(
        'Delete or convert the managed MODX application before its primary database',
      );
    }
  }

  private validateExportResult(value: unknown): string {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new OperationNeedsAttentionError('Database snapshot result is invalid');
    }
    const result = value as Record<string, unknown>;
    if (
      Object.keys(result).sort().join(',') !== 'filePath' ||
      typeof result.filePath !== 'string'
    ) throw new OperationNeedsAttentionError('Database snapshot path is invalid');
    try {
      return assertSafeFilePath(result.filePath, [getDatabaseExportsDir()], {
        mustExist: true,
        extensions: ['sql', 'gz', 'bz2', 'xz', 'zip'],
      });
    } catch {
      throw new OperationNeedsAttentionError('Database snapshot path is invalid');
    }
  }
}
