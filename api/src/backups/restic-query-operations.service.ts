import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { BackupEngine } from '../common/enums';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { OperationAdmissionService } from '../operations/operation-admission.service';
import {
  OperationCancelledError,
  OperationsWorkerService,
  type OperationExecutionContext,
} from '../operations/operations-worker.service';
import { StorageLocationsService } from '../storage-locations/storage-locations.service';
import {
  RESTIC_QUERY_ACTIONS,
  RESTIC_QUERY_AGENT_ACTIONS,
  parseResticBackupTreeRequest,
  parseResticDiffFileLiveRequest,
  parseResticDiffFileRequest,
  parseResticDiffLiveRequest,
  parseResticDiffSnapshotsRequest,
  parseResticSnapshotTreeRequest,
  parseResticSnapshotsRequest,
  validateResticDiffResult,
  validateResticFileDiffResult,
  validateResticSnapshotsResult,
  validateResticTreeResult,
  type ResticBackupTreeRequest,
  type ResticDiffFileLiveRequest,
  type ResticDiffFileRequest,
  type ResticDiffLiveRequest,
  type ResticDiffSnapshotsRequest,
  type ResticSnapshotTreeRequest,
  type ResticSnapshotsRequest,
} from './restic-query-contract';
import {
  OperationFailedError,
  OperationNeedsAttentionError,
} from '../operations/operation-errors';
import { safeErrorMessage } from '@meowbox/shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNAPSHOT_ID = /^[a-f0-9]{6,64}$/i;

interface OperatorActor {
  userId: string;
  role: string;
}

interface ResticSiteScope {
  id: string;
  name: string;
  rootPath: string;
}

@Injectable()
export class ResticQueryOperationsService implements OnModuleInit, OnModuleDestroy {
  private unregisterHandlers: Array<() => void> = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly relay: AgentRelayService,
    private readonly locations: StorageLocationsService,
    private readonly admission: OperationAdmissionService,
    private readonly worker: OperationsWorkerService,
  ) {}

  onModuleInit(): void {
    this.unregisterHandlers.push(
      this.worker.registerHandler(
        RESTIC_QUERY_ACTIONS.SNAPSHOTS,
        (request, context) => this.executeRetrySafe(request, context, this.executeSnapshots.bind(this)),
      ),
      this.worker.registerHandler(
        RESTIC_QUERY_ACTIONS.BACKUP_TREE,
        (request, context) => this.executeRetrySafe(request, context, this.executeBackupTree.bind(this)),
      ),
      this.worker.registerHandler(
        RESTIC_QUERY_ACTIONS.SNAPSHOT_TREE,
        (request, context) => this.executeRetrySafe(request, context, this.executeSnapshotTree.bind(this)),
      ),
      this.worker.registerHandler(
        RESTIC_QUERY_ACTIONS.DIFF_SNAPSHOTS,
        (request, context) => this.executeRetrySafe(request, context, this.executeDiffSnapshots.bind(this)),
      ),
      this.worker.registerHandler(
        RESTIC_QUERY_ACTIONS.DIFF_LIVE,
        (request, context) => this.executeRetrySafe(request, context, this.executeDiffLive.bind(this)),
      ),
      this.worker.registerHandler(
        RESTIC_QUERY_ACTIONS.DIFF_FILE,
        (request, context) => this.executeRetrySafe(request, context, this.executeDiffFile.bind(this)),
      ),
      this.worker.registerHandler(
        RESTIC_QUERY_ACTIONS.DIFF_FILE_LIVE,
        (request, context) => this.executeRetrySafe(request, context, this.executeDiffFileLive.bind(this)),
      ),
    );
  }

  onModuleDestroy(): void {
    for (const unregister of this.unregisterHandlers.splice(0)) unregister();
  }

  async enqueueSnapshots(
    siteId: string,
    locationId: string,
    actor: OperatorActor,
    idempotencyKey?: string,
  ) {
    this.assertUuid(siteId, 'Некорректный siteId');
    this.assertUuid(locationId, 'Некорректный locationId');
    await this.preflight(siteId, locationId, actor);
    return this.admit(
      RESTIC_QUERY_ACTIONS.SNAPSHOTS,
      'RESTIC_SNAPSHOTS_LIST',
      { siteId, locationId },
      actor,
      idempotencyKey,
      siteId,
      locationId,
      5 * 60_000,
    );
  }

  async enqueueBackupTree(
    backupId: string,
    actor: OperatorActor,
    idempotencyKey?: string,
  ) {
    this.assertUuid(backupId, 'Некорректный backupId');
    const backup = await this.loadBackupScope(backupId, actor);
    await this.preflight(backup.siteId, backup.locationId, actor);
    return this.admit(
      RESTIC_QUERY_ACTIONS.BACKUP_TREE,
      'RESTIC_BACKUP_TREE_LIST',
      { siteId: backup.siteId, backupId },
      actor,
      idempotencyKey,
      backup.siteId,
      backup.locationId,
      5 * 60_000,
    );
  }

  async enqueueSnapshotTree(
    input: ResticSnapshotTreeRequest,
    actor: OperatorActor,
    idempotencyKey?: string,
  ) {
    this.assertSnapshotInput(input);
    await this.preflight(input.siteId, input.locationId, actor);
    return this.admit(
      RESTIC_QUERY_ACTIONS.SNAPSHOT_TREE,
      'RESTIC_SNAPSHOT_TREE_LIST',
      input,
      actor,
      idempotencyKey,
      input.siteId,
      input.locationId,
      5 * 60_000,
    );
  }

  async enqueueDiffSnapshots(
    input: ResticDiffSnapshotsRequest,
    actor: OperatorActor,
    idempotencyKey?: string,
  ) {
    this.assertDiffSnapshotsInput(input);
    await this.preflight(input.siteId, input.locationId, actor);
    return this.admit(
      RESTIC_QUERY_ACTIONS.DIFF_SNAPSHOTS,
      'RESTIC_DIFF_SNAPSHOTS',
      input,
      actor,
      idempotencyKey,
      input.siteId,
      input.locationId,
      10 * 60_000,
    );
  }

  async enqueueDiffLive(
    input: ResticDiffLiveRequest,
    actor: OperatorActor,
    idempotencyKey?: string,
  ) {
    this.assertSnapshotInput(input);
    await this.preflight(input.siteId, input.locationId, actor);
    return this.admit(
      RESTIC_QUERY_ACTIONS.DIFF_LIVE,
      'RESTIC_DIFF_LIVE',
      input,
      actor,
      idempotencyKey,
      input.siteId,
      input.locationId,
      15 * 60_000,
    );
  }

  async enqueueDiffFile(
    input: ResticDiffFileRequest,
    actor: OperatorActor,
    idempotencyKey?: string,
  ) {
    this.assertDiffSnapshotsInput(input);
    this.assertFilePath(input.filePath);
    const site = await this.preflight(input.siteId, input.locationId, actor);
    this.assertPathInsideSite(input.filePath, site.rootPath);
    return this.admit(
      RESTIC_QUERY_ACTIONS.DIFF_FILE,
      'RESTIC_DIFF_FILE',
      input,
      actor,
      idempotencyKey,
      input.siteId,
      input.locationId,
      5 * 60_000,
    );
  }

  async enqueueDiffFileLive(
    input: ResticDiffFileLiveRequest,
    actor: OperatorActor,
    idempotencyKey?: string,
  ) {
    this.assertSnapshotInput(input);
    this.assertFilePath(input.filePath);
    const site = await this.preflight(input.siteId, input.locationId, actor);
    this.assertPathInsideSite(input.filePath, site.rootPath);
    return this.admit(
      RESTIC_QUERY_ACTIONS.DIFF_FILE_LIVE,
      'RESTIC_DIFF_FILE_LIVE',
      input,
      actor,
      idempotencyKey,
      input.siteId,
      input.locationId,
      5 * 60_000,
    );
  }

  private admit(
    actionId: string,
    type: string,
    request: unknown,
    actor: OperatorActor,
    idempotencyKey: string | undefined,
    siteId: string,
    locationId: string,
    deadlineMs: number,
  ) {
    return this.admission.admit({
      actionId,
      type,
      request,
      actor,
      idempotencyKey,
      deadlineMs,
      recoveryPolicy: 'RETRY_SAFE',
      retryable: true,
      maxAttempts: 3,
      siteId,
      lockSite: false,
      globalLockKey: `restic:${createHash('sha256')
        .update(siteId)
        .update('\0')
        .update(locationId)
        .digest('hex')
        .slice(0, 48)}`,
    });
  }

  private async executeSnapshots(request: unknown, context: OperationExecutionContext) {
    const input = parseResticSnapshotsRequest(request);
    const site = await this.loadSiteScope(input.siteId, context.actor);
    const storage = await this.loadStorage(input.locationId);
    const raw = await this.runJob(
      RESTIC_QUERY_AGENT_ACTIONS.SNAPSHOTS,
      { siteName: site.name, storage },
      context,
    );
    const snapshots = validateResticSnapshotsResult(raw);
    const knownIds = new Set<string>();
    for (let offset = 0; offset < snapshots.length; offset += 400) {
      const rows = await this.prisma.backup.findMany({
        where: {
          siteId: input.siteId,
          storageLocationId: input.locationId,
          engine: BackupEngine.RESTIC,
          resticSnapshotId: { in: snapshots.slice(offset, offset + 400).map((item) => item.id) },
        },
        select: { resticSnapshotId: true },
      });
      for (const row of rows) if (row.resticSnapshotId) knownIds.add(row.resticSnapshotId);
    }
    const result = snapshots.map((snapshot) => ({
      ...snapshot,
      inDatabase: knownIds.has(snapshot.id),
    }));
    this.assertOperationResultBudget(result);
    return result;
  }

  private async executeBackupTree(request: unknown, context: OperationExecutionContext) {
    const input = parseResticBackupTreeRequest(request);
    const backup = await this.loadBackupScope(input.backupId, context.actor);
    if (backup.siteId !== input.siteId) {
      throw new OperationNeedsAttentionError('Restic backup scope changed');
    }
    const storage = await this.loadStorage(backup.locationId);
    const raw = await this.runJob(
      RESTIC_QUERY_AGENT_ACTIONS.TREE,
      {
        siteName: backup.siteName,
        snapshotId: backup.snapshotId,
        rootPath: backup.rootPath,
        storage,
      },
      context,
    );
    return { items: validateResticTreeResult(raw) };
  }

  private async executeSnapshotTree(request: unknown, context: OperationExecutionContext) {
    const input = parseResticSnapshotTreeRequest(request);
    const site = await this.loadSiteScope(input.siteId, context.actor);
    const storage = await this.loadStorage(input.locationId);
    const raw = await this.runJob(
      RESTIC_QUERY_AGENT_ACTIONS.TREE,
      {
        siteName: site.name,
        snapshotId: input.snapshotId,
        rootPath: site.rootPath,
        storage,
      },
      context,
    );
    return { items: validateResticTreeResult(raw) };
  }

  private async executeDiffSnapshots(request: unknown, context: OperationExecutionContext) {
    const input = parseResticDiffSnapshotsRequest(request);
    const site = await this.loadSiteScope(input.siteId, context.actor);
    const storage = await this.loadStorage(input.locationId);
    const raw = await this.runJob(
      RESTIC_QUERY_AGENT_ACTIONS.DIFF_SNAPSHOTS,
      {
        siteName: site.name,
        storage,
        snapshotIdA: input.snapshotIdA,
        snapshotIdB: input.snapshotIdB,
      },
      context,
    );
    return validateResticDiffResult(raw);
  }

  private async executeDiffLive(request: unknown, context: OperationExecutionContext) {
    const input = parseResticDiffLiveRequest(request);
    const site = await this.loadSiteScope(input.siteId, context.actor);
    const storage = await this.loadStorage(input.locationId);
    const raw = await this.runJob(
      RESTIC_QUERY_AGENT_ACTIONS.DIFF_LIVE,
      {
        siteName: site.name,
        storage,
        snapshotId: input.snapshotId,
        snapshotRoot: site.rootPath,
        liveRoot: site.rootPath,
      },
      context,
    );
    return validateResticDiffResult(raw);
  }

  private async executeDiffFile(request: unknown, context: OperationExecutionContext) {
    const input = parseResticDiffFileRequest(request);
    const site = await this.loadSiteScope(input.siteId, context.actor);
    this.assertPathInsideSite(input.filePath, site.rootPath, true);
    const storage = await this.loadStorage(input.locationId);
    const raw = await this.runJob(
      RESTIC_QUERY_AGENT_ACTIONS.DIFF_FILE,
      {
        siteName: site.name,
        storage,
        snapshotIdA: input.snapshotIdA,
        snapshotIdB: input.snapshotIdB,
        filePath: input.filePath,
      },
      context,
    );
    return validateResticFileDiffResult(raw);
  }

  private async executeDiffFileLive(request: unknown, context: OperationExecutionContext) {
    const input = parseResticDiffFileLiveRequest(request);
    const site = await this.loadSiteScope(input.siteId, context.actor);
    this.assertPathInsideSite(input.filePath, site.rootPath, true);
    const storage = await this.loadStorage(input.locationId);
    const raw = await this.runJob(
      RESTIC_QUERY_AGENT_ACTIONS.DIFF_FILE_LIVE,
      {
        siteName: site.name,
        storage,
        snapshotId: input.snapshotId,
        snapshotFilePath: input.filePath,
        livePath: input.filePath,
      },
      context,
    );
    return validateResticFileDiffResult(raw);
  }

  private async runJob(
    actionId: string,
    payload: unknown,
    context: OperationExecutionContext,
  ): Promise<unknown> {
    await context.throwIfCancellationRequested();
    return this.relay.runAgentJob(
      {
        operationId: context.operationId,
        actionId,
        step: `query:${context.attempt}`,
        payload,
        deadlineAt: context.deadlineAt,
        cancelSafe: true,
      },
      () => context.isCancellationRequested(),
    );
  }

  private async executeRetrySafe(
    request: unknown,
    context: OperationExecutionContext,
    handler: (request: unknown, context: OperationExecutionContext) => Promise<unknown>,
  ): Promise<unknown> {
    try {
      return await handler(request, context);
    } catch (error) {
      if (
        error instanceof OperationNeedsAttentionError ||
        error instanceof OperationCancelledError ||
        context.attempt < 3
      ) throw error;
      throw new OperationFailedError(safeErrorMessage(error));
    }
  }

  private async preflight(
    siteId: string,
    locationId: string,
    actor: OperatorActor,
  ): Promise<ResticSiteScope> {
    if (!this.relay.isAgentConnected()) throw new BadRequestException('Агент не подключён');
    const site = await this.loadSiteScope(siteId, actor);
    await this.loadStorage(locationId);
    return site;
  }

  private async loadSiteScope(
    siteId: string,
    actor: { userId: string; role: string },
  ): Promise<ResticSiteScope> {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { id: true, name: true, rootPath: true, userId: true },
    });
    if (!site) throw new NotFoundException('Site not found');
    if (actor.role !== 'ADMIN' && site.userId !== actor.userId) {
      throw new ForbiddenException('Access denied');
    }
    return { id: site.id, name: site.name, rootPath: site.rootPath };
  }

  private async loadBackupScope(backupId: string, actor: OperatorActor): Promise<{
    siteId: string;
    siteName: string;
    rootPath: string;
    locationId: string;
    snapshotId: string;
  }> {
    const backup = await this.prisma.backup.findUnique({
      where: { id: backupId },
      select: {
        engine: true,
        resticSnapshotId: true,
        storageLocationId: true,
        siteId: true,
        site: { select: { name: true, rootPath: true, userId: true } },
      },
    });
    if (!backup) throw new NotFoundException('Backup not found');
    if (actor.role !== 'ADMIN' && backup.site.userId !== actor.userId) {
      throw new ForbiddenException('Access denied');
    }
    if (
      backup.engine !== BackupEngine.RESTIC ||
      !backup.resticSnapshotId ||
      !backup.storageLocationId
    ) {
      throw new BadRequestException('Selective restore доступен только для Restic-бэкапа с хранилищем');
    }
    return {
      siteId: backup.siteId,
      siteName: backup.site.name,
      rootPath: backup.site.rootPath,
      locationId: backup.storageLocationId,
      snapshotId: backup.resticSnapshotId,
    };
  }

  private async loadStorage(locationId: string) {
    const location = await this.locations.getFullConfigForAgent(locationId);
    if (!location.resticPassword) {
      throw new BadRequestException('У этого хранилища нет Restic-пароля');
    }
    return {
      type: location.type,
      config: location.config,
      password: location.resticPassword,
    };
  }

  private assertUuid(value: string, message: string): void {
    if (!UUID.test(value)) throw new BadRequestException(message);
  }

  private assertSnapshotInput(input: ResticSnapshotTreeRequest | ResticDiffLiveRequest): void {
    this.assertUuid(input.siteId, 'Некорректный siteId');
    this.assertUuid(input.locationId, 'Некорректный locationId');
    if (!SNAPSHOT_ID.test(input.snapshotId)) throw new BadRequestException('Некорректный snapshotId');
  }

  private assertDiffSnapshotsInput(input: ResticDiffSnapshotsRequest): void {
    this.assertUuid(input.siteId, 'Некорректный siteId');
    this.assertUuid(input.locationId, 'Некорректный locationId');
    if (!SNAPSHOT_ID.test(input.snapshotIdA) || !SNAPSHOT_ID.test(input.snapshotIdB)) {
      throw new BadRequestException('Некорректный snapshotId');
    }
    if (input.snapshotIdA === input.snapshotIdB) {
      throw new BadRequestException('Снапшоты идентичны — нечего сравнивать');
    }
  }

  private assertFilePath(value: string): void {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > 4096 ||
      !value.startsWith('/') ||
      /[\0-\x1f\x7f]/.test(value) ||
      value.split('/').includes('..')
    ) throw new BadRequestException('Некорректный путь файла');
  }

  private assertPathInsideSite(value: string, rootPath: string, worker = false): void {
    if (value !== rootPath && !value.startsWith(`${rootPath.replace(/\/+$/, '')}/`)) {
      if (worker) throw new OperationNeedsAttentionError('Restic diff file is outside Site root');
      throw new BadRequestException('Файл вне корня сайта');
    }
  }

  private assertOperationResultBudget(value: unknown): void {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 1024 * 1024) {
      throw new OperationNeedsAttentionError('Restic query result exceeds operation result budget');
    }
  }
}
