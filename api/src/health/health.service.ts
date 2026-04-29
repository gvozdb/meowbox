import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

export interface SiteHealthSummary {
  siteId: string;
  siteName: string;
  domain: string;
  uptimePercent: number;
  avgResponseMs: number;
  lastPing: {
    reachable: boolean;
    statusCode: number | null;
    responseTimeMs: number;
    createdAt: string;
  } | null;
  totalPings: number;
  successPings: number;
}

export interface PingEntry {
  reachable: boolean;
  statusCode: number | null;
  responseTimeMs: number;
  createdAt: string;
}

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  async getAllSitesHealth(userId: string, role: string): Promise<SiteHealthSummary[]> {
    const where = role === 'ADMIN' ? {} : { userId };
    const sites = await this.prisma.site.findMany({
      where,
      select: { id: true, name: true, domain: true, status: true },
      orderBy: { name: 'asc' },
    });

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const results: SiteHealthSummary[] = [];

    for (const site of sites) {
      const pings = await this.prisma.healthCheckPing.findMany({
        where: { siteId: site.id, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        select: { reachable: true, statusCode: true, responseTimeMs: true, createdAt: true },
      });

      const total = pings.length;
      const success = pings.filter((p) => p.reachable).length;
      const avgMs = total > 0
        ? Math.round(pings.reduce((sum, p) => sum + p.responseTimeMs, 0) / total)
        : 0;

      results.push({
        siteId: site.id,
        siteName: site.name,
        domain: site.domain,
        uptimePercent: total > 0 ? Math.round((success / total) * 10000) / 100 : 100,
        avgResponseMs: avgMs,
        lastPing: pings[0]
          ? {
              reachable: pings[0].reachable,
              statusCode: pings[0].statusCode,
              responseTimeMs: pings[0].responseTimeMs,
              createdAt: pings[0].createdAt.toISOString(),
            }
          : null,
        totalPings: total,
        successPings: success,
      });
    }

    return results;
  }

  async getSitePingHistory(
    siteId: string,
    userId: string,
    role: string,
    hours: number,
  ): Promise<PingEntry[]> {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { userId: true },
    });
    if (!site) return [];
    if (role !== 'ADMIN' && site.userId !== userId) return [];

    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const pings = await this.prisma.healthCheckPing.findMany({
      where: { siteId, createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
      select: { reachable: true, statusCode: true, responseTimeMs: true, createdAt: true },
    });

    return pings.map((p) => ({
      reachable: p.reachable,
      statusCode: p.statusCode,
      responseTimeMs: p.responseTimeMs,
      createdAt: p.createdAt.toISOString(),
    }));
  }
}
