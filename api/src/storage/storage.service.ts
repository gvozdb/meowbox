import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';

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
export class StorageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
  ) {}

  async getAllSitesStorage(userId: string, role: string): Promise<SiteStorageInfo[]> {
    const where = role === 'ADMIN' ? {} : { userId };
    const sites = await this.prisma.site.findMany({
      where,
      select: {
        id: true,
        name: true,
        domain: true,
        rootPath: true,
        filesRelPath: true,
        databases: { select: { sizeBytes: true } },
      },
      orderBy: { name: 'asc' },
    });

    if (!this.agentRelay.isAgentConnected()) {
      return sites.map((s) => ({
        siteId: s.id,
        siteName: s.name,
        domain: s.domain,
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
        }>('site:storage', { rootPath: site.rootPath, filesRelPath: site.filesRelPath || undefined }, 30_000);

        if (res.success && res.data) {
          results.push({
            siteId: site.id,
            siteName: site.name,
            domain: site.domain,
            wwwBytes: res.data.wwwBytes,
            logsBytes: res.data.logsBytes,
            tmpBytes: res.data.tmpBytes,
            dbBytes,
            totalBytes: res.data.totalBytes + dbBytes,
          });
        } else {
          results.push({
            siteId: site.id, siteName: site.name, domain: site.domain,
            wwwBytes: 0, logsBytes: 0, tmpBytes: 0, dbBytes, totalBytes: dbBytes,
          });
        }
      } catch {
        results.push({
          siteId: site.id, siteName: site.name, domain: site.domain,
          wwwBytes: 0, logsBytes: 0, tmpBytes: 0, dbBytes, totalBytes: dbBytes,
        });
      }
    }

    return results;
  }

  async getSiteTopFiles(siteId: string, userId: string, role: string): Promise<TopFile[]> {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { rootPath: true, filesRelPath: true, userId: true },
    });
    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) throw new ForbiddenException();

    const res = await this.agentRelay.emitToAgent<TopFile[]>(
      'site:top-files',
      { rootPath: site.rootPath, limit: 20, filesRelPath: site.filesRelPath || undefined },
      60_000,
    );
    return res.success && res.data ? res.data : [];
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
}
