import {
  BadRequestException,
  Injectable,
  ForbiddenException,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { OperationAdmissionService } from '../operations/operation-admission.service';
import { OperationsWorkerService } from '../operations/operations-worker.service';

const TOP_FILES_OPERATION_ACTION = 'storage.top_files.scan';
const TOP_FILES_AGENT_ACTION = 'agent.storage.top_files';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validateTopFilesRequest(request: unknown): { siteId: string } {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new BadRequestException('Storage scan operation request is invalid');
  }
  const value = request as Record<string, unknown>;
  if (
    Object.keys(value).join(',') !== 'siteId' ||
    typeof value.siteId !== 'string' ||
    !UUID.test(value.siteId)
  ) throw new BadRequestException('Storage scan operation request is invalid');
  return value as { siteId: string };
}

function validateTopFilesResult(value: unknown): TopFile[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new BadRequestException('Storage scan result is invalid');
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new BadRequestException('Storage scan result is invalid');
    }
    const file = entry as Record<string, unknown>;
    if (
      Object.keys(file).sort().join(',') !== 'path,size' ||
      typeof file.path !== 'string' ||
      file.path.length === 0 ||
      file.path.length > 4096 ||
      /[\0-\x1f\x7f]/.test(file.path) ||
      typeof file.size !== 'number' ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    ) throw new BadRequestException('Storage scan result is invalid');
    return file as unknown as TopFile;
  });
}

export interface SiteStorageInfo {
  siteId: string;
  siteName: string;
  domain: string;
  wwwBytes: number;
  logsBytes: number;
  tmpBytes: number;
  dbBytes: number;
  totalBytes: number;
}

export interface TopFile {
  size: number;
  path: string;
}

export interface ServerDisk {
  total: number;
  used: number;
  percent: number;
}

export interface DiskTrendPoint {
  date: string;
  wwwBytes: number;
  logsBytes: number;
  tmpBytes: number;
  dbBytes: number;
  totalBytes: number;
}

@Injectable()
export class StorageService implements OnModuleInit, OnModuleDestroy {
  private unregisterHandler: (() => void) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
    private readonly admission: OperationAdmissionService,
    private readonly worker: OperationsWorkerService,
  ) {}

  onModuleInit(): void {
    this.unregisterHandler = this.worker.registerHandler(
      TOP_FILES_OPERATION_ACTION,
      (request, context) => this.executeQueuedTopFilesScan(request, context),
    );
  }

  onModuleDestroy(): void {
    this.unregisterHandler?.();
    this.unregisterHandler = null;
  }

  async getAllSitesStorage(userId: string, role: string): Promise<SiteStorageInfo[]> {
    const where = role === 'ADMIN' ? {} : { userId };
    const sites = await this.prisma.site.findMany({
      where,
      select: {
        id: true,
        name: true,
        rootPath: true,
        domains: {
          orderBy: { position: 'asc' },
          select: { domain: true, filesRelPath: true },
        },
        databases: { select: { sizeBytes: true } },
      },
      orderBy: { name: 'asc' },
    });

    if (!this.agentRelay.isAgentConnected()) {
      return sites.map((s) => ({
        siteId: s.id,
        siteName: s.name,
        domain: s.domains[0]?.domain || '',
        wwwBytes: 0,
        logsBytes: 0,
        tmpBytes: 0,
        dbBytes: s.databases.reduce((sum, db) => sum + Number(db.sizeBytes), 0),
        totalBytes: s.databases.reduce((sum, db) => sum + Number(db.sizeBytes), 0),
      }));
    }

    const results: SiteStorageInfo[] = [];
    for (const site of sites) {
      const dbBytes = site.databases.reduce((sum, db) => sum + Number(db.sizeBytes), 0);
      try {
        const res = await this.agentRelay.emitToAgent<{
          wwwBytes: number; logsBytes: number; tmpBytes: number; totalBytes: number;
        }>(
          'site:storage',
          {
            rootPath: site.rootPath,
            filesRelPaths: [
              ...new Set(site.domains.map((domain) => domain.filesRelPath)),
            ],
          },
          30_000,
        );

        if (res.success && res.data) {
          results.push({
            siteId: site.id,
            siteName: site.name,
            domain: site.domains[0]?.domain || '',
            wwwBytes: res.data.wwwBytes,
            logsBytes: res.data.logsBytes,
            tmpBytes: res.data.tmpBytes,
            dbBytes,
            totalBytes: res.data.totalBytes + dbBytes,
          });
        } else {
          results.push({
            siteId: site.id, siteName: site.name, domain: site.domains[0]?.domain || '',
            wwwBytes: 0, logsBytes: 0, tmpBytes: 0, dbBytes, totalBytes: dbBytes,
          });
        }
      } catch {
        results.push({
          siteId: site.id, siteName: site.name, domain: site.domains[0]?.domain || '',
          wwwBytes: 0, logsBytes: 0, tmpBytes: 0, dbBytes, totalBytes: dbBytes,
        });
      }
    }

    return results;
  }

  async getSiteTopFiles(siteId: string, userId: string, role: string): Promise<TopFile[]> {
    const site = await this.authorizedSiteStorageScope(siteId, userId, role);

    const res = await this.agentRelay.emitToAgent<TopFile[]>(
      'site:top-files',
      {
        rootPath: site.rootPath,
        limit: 20,
        filesRelPaths: [
          ...new Set(site.domains.map((domain) => domain.filesRelPath)),
        ],
      },
      60_000,
    );
    return res.success && res.data ? res.data : [];
  }

  async enqueueSiteTopFilesScan(
    siteId: string,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    validateTopFilesRequest({ siteId });
    await this.authorizedSiteStorageScope(siteId, actor.userId, actor.role);
    return this.admission.admit({
      actionId: TOP_FILES_OPERATION_ACTION,
      type: 'STORAGE_TOP_FILES_SCAN',
      idempotencyKey,
      actor,
      request: { siteId },
      deadlineMs: 10 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      globalLockKey: `storage-scan:${siteId}`,
      siteId,
    });
  }

  async getServerDisk(): Promise<ServerDisk> {
    const res = await this.agentRelay.emitToAgent<ServerDisk>('server:disk', {});
    if (res.success && res.data) return res.data;
    return { total: 0, used: 0, percent: 0 };
  }

  async getTrend(siteId: string, userId: string, role: string, days: number): Promise<DiskTrendPoint[]> {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { userId: true },
    });
    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) throw new ForbiddenException();

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const snapshots = await this.prisma.siteDiskSnapshot.findMany({
      where: { siteId, createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
    });

    return snapshots.map((s) => ({
      date: s.createdAt.toISOString(),
      wwwBytes: Number(s.wwwBytes),
      logsBytes: Number(s.logsBytes),
      tmpBytes: Number(s.tmpBytes),
      dbBytes: Number(s.dbBytes),
      totalBytes: Number(s.wwwBytes) + Number(s.logsBytes) + Number(s.tmpBytes) + Number(s.dbBytes),
    }));
  }

  private async authorizedSiteStorageScope(
    siteId: string,
    userId: string,
    role: string,
  ) {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: {
        rootPath: true,
        userId: true,
        domains: { select: { filesRelPath: true } },
      },
    });
    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) throw new ForbiddenException();
    return site;
  }

  private async executeQueuedTopFilesScan(
    request: unknown,
    context: {
      operationId: string;
      deadlineAt: Date;
      actor: { userId: string; role: string };
      isCancellationRequested(): Promise<boolean>;
    },
  ): Promise<TopFile[]> {
    const input = validateTopFilesRequest(request);
    const site = await this.authorizedSiteStorageScope(
      input.siteId,
      context.actor.userId,
      context.actor.role,
    );
    const result = await this.agentRelay.runAgentJob(
      {
        operationId: context.operationId,
        actionId: TOP_FILES_AGENT_ACTION,
        step: 'scan',
        payload: {
          rootPath: site.rootPath,
          limit: 20,
          filesRelPaths: [
            ...new Set(site.domains.map((domain) => domain.filesRelPath)),
          ],
        },
        deadlineAt: context.deadlineAt,
        cancelSafe: false,
      },
      () => context.isCancellationRequested(),
    );
    return validateTopFilesResult(result);
  }
}
