import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { isReleaseMaintenanceActive } from '../common/release-maintenance';
import { AgentRelayService } from '../gateway/agent-relay.service';

export interface SiteHealthSummary {
  siteId: string;
  siteDomainId: string;
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
  ) {}

  async getReleaseHealth() {
    const [sites, siteDomains, activeOperations, representativeDomain] = await Promise.all([
      this.prisma.site.count(),
      this.prisma.siteDomain.count(),
      this.prisma.operation.count({
        where: { status: { in: ['PENDING', 'RUNNING'] } },
      }),
      this.prisma.siteDomain.findFirst({
        orderBy: [{ siteId: 'asc' }, { position: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          siteId: true,
          preset: true,
          appStatus: true,
          runtimeKey: true,
          filesRelPath: true,
        },
      }),
    ]);
    return {
      databaseReadable: true,
      agentConnected: this.agentRelay.isAgentConnected(),
      maintenanceActive: isReleaseMaintenanceActive(),
      counts: { sites, siteDomains, activeOperations },
      representativeDomain,
    };
  }

  async getAllSitesHealth(userId: string, role: string): Promise<SiteHealthSummary[]> {
    const where = role === 'ADMIN' ? {} : { userId };
    const domains = await this.prisma.siteDomain.findMany({
      where: { site: where },
      select: {
        id: true,
        siteId: true,
        domain: true,
        site: { select: { name: true } },
      },
      orderBy: [{ site: { name: 'asc' } }, { position: 'asc' }],
    });

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const results: SiteHealthSummary[] = [];

    for (const domain of domains) {
      const pings = await this.prisma.healthCheckPing.findMany({
        where: {
          siteDomainId: domain.id,
          createdAt: { gte: since },
        },
        orderBy: { createdAt: 'desc' },
        select: { reachable: true, statusCode: true, responseTimeMs: true, createdAt: true },
      });

      const total = pings.length;
      const success = pings.filter(
        (p) =>
          p.reachable &&
          (p.statusCode ?? 0) > 0 &&
          (p.statusCode ?? 0) < 500,
      ).length;
      const avgMs = total > 0
        ? Math.round(pings.reduce((sum, p) => sum + p.responseTimeMs, 0) / total)
        : 0;

      results.push({
        siteId: domain.siteId,
        siteDomainId: domain.id,
        siteName: domain.site.name,
        domain: domain.domain,
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
    domainId: string,
    userId: string,
    role: string,
    hours: number,
  ): Promise<PingEntry[]> {
    const domain = await this.prisma.siteDomain.findFirst({
      where: { id: domainId, siteId },
      select: { site: { select: { userId: true } } },
    });
    if (!domain) return [];
    if (role !== 'ADMIN' && domain.site.userId !== userId) return [];

    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const pings = await this.prisma.healthCheckPing.findMany({
      where: { siteId, siteDomainId: domainId, createdAt: { gte: since } },
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
