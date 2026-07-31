import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { artifactAnchor, siteDomainLogBase } from '@meowbox/shared';
import { DomainContextService } from '../sites/domain-context.service';

export interface LogSource {
  id: string;
  name: string;
  type: 'site' | 'system';
  types: string[];
  domain?: string;
}

@Injectable()
export class LogsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
    private readonly domainContext: DomainContextService,
  ) {}

  /**
   * Get all available log sources: sites + system services.
   */
  async getLogSources(userId: string, role: string): Promise<LogSource[]> {
    const sources: LogSource[] = [];

    // Site sources
    const where = role === 'ADMIN' ? {} : { userId };
    const domains = await this.prisma.siteDomain.findMany({
      where: { site: where },
      select: {
        id: true,
        domain: true,
        preset: true,
        phpVersion: true,
        runtimeKey: true,
        site: { select: { name: true } },
      },
      orderBy: [{ site: { name: 'asc' } }, { position: 'asc' }],
    });

    for (const domain of domains) {
      sources.push({
        id: `domain:${domain.id}`,
        name: `${domain.site.name} · ${domain.domain}`,
        type: 'site',
        types: [
          'access',
          'error',
          ...(domain.phpVersion ? ['php'] : []),
          ...(domain.preset === 'CUSTOM' ? ['app'] : []),
        ],
        domain: domain.domain,
      });
    }

    // System sources
    const systemResult = await this.agentRelay.emitToAgent<Array<{ id: string; name: string; types: string[] }>>(
      'logs:system:sources',
      {},
    );
    if (systemResult.success && systemResult.data) {
      for (const src of systemResult.data) {
        sources.push({
          id: `system:${src.id}`,
          name: src.name,
          type: 'system',
          types: src.types,
        });
      }
    }

    return sources;
  }

  /**
   * Read logs from any source (site or system).
   */
  async readCentralLog(
    source: string,
    type: string,
    lines: number,
    userId: string,
    role: string,
  ) {
    const maxLines = Math.min(lines || 200, 1000);

    if (source.startsWith('domain:')) {
      const domainId = source.slice(7);
      const domain = await this.prisma.siteDomain.findUnique({
        where: { id: domainId },
        select: { siteId: true },
      });
      if (!domain) throw new NotFoundException('Domain application not found');
      return this.getSiteLogs(
        domain.siteId,
        domainId,
        userId,
        role,
        type,
        maxLines,
      );
    }

    if (source.startsWith('system:')) {
      if (role !== 'ADMIN') {
        throw new ForbiddenException('Only admins can view system logs');
      }
      const service = source.slice(7);
      const result = await this.agentRelay.emitToAgent('logs:system', {
        service,
        type,
        lines: maxLines,
      });
      if (!result.success) {
        throw new InternalServerErrorException(result.error || 'Failed to read system logs');
      }
      return result.data;
    }

    throw new BadRequestException(
      'Invalid source format. Use domain:{id} or system:{service}',
    );
  }

  /**
   * Resolve a log file path for tail streaming.
   */
  async resolveLogPath(
    source: string,
    type: string,
    userId: string,
    role: string,
  ): Promise<string> {
    if (source.startsWith('domain:')) {
      const domainId = source.slice(7);
      const record = await this.prisma.siteDomain.findUnique({
        where: { id: domainId },
        select: { siteId: true },
      });
      if (!record) throw new NotFoundException('Domain application not found');
      const { site, domain } =
        await this.domainContext.requireOwnedSiteDomain(
          record.siteId,
          domainId,
          userId,
          role,
        );

      switch (type) {
        case 'access':
          return `/var/log/nginx/${siteDomainLogBase({ siteName: site.name, domain: domain.domain })}-access.log`;
        case 'error':
          return `/var/log/nginx/${siteDomainLogBase({ siteName: site.name, domain: domain.domain })}-error.log`;
        case 'php':
          return `/var/log/php/${domain.runtimeKey}-error.log`;
        case 'app':
          return `/root/.pm2/logs/${domain.runtimeKey}-out.log`;
        default:
          throw new BadRequestException(`Unknown log type: ${type}`);
      }
    }

    if (source.startsWith('system:')) {
      if (role !== 'ADMIN') {
        throw new ForbiddenException('Only admins can tail system logs');
      }
      const service = source.slice(7);
      switch (service) {
        case 'nginx':
          return type === 'access'
            ? '/var/log/nginx/access.log'
            : '/var/log/nginx/error.log';
        default:
          throw new BadRequestException('Tail streaming not supported for journalctl-based services');
      }
    }

    throw new BadRequestException('Invalid source format');
  }

  async getSiteLogs(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
    type: string,
    lines?: number,
  ) {
    const { site, domain } =
      await this.domainContext.requireOwnedSiteDomain(
        siteId,
        domainId,
        userId,
        role,
      );

    const result = await this.agentRelay.emitToAgent('site:logs', {
      siteDomainId: domainId,
      systemUser: site.systemUser,
      domain: domain.domain,
      runtimeKey: domain.runtimeKey,
      type,
      siteName: site.name,
      lines: lines || 200,
    });

    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Failed to read logs');
    }

    return result.data;
  }

  async getAvailableLogs(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
  ) {
    const { site, domain } =
      await this.domainContext.requireOwnedSiteDomain(
        siteId,
        domainId,
        userId,
        role,
      );

    const result = await this.agentRelay.emitToAgent('site:logs:available', {
      siteDomainId: domainId,
      systemUser: site.systemUser,
      domain: domain.domain,
      runtimeKey: domain.runtimeKey,
      siteName: site.name,
    });

    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Failed to list logs');
    }

    return result.data;
  }
}
