import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';

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
  ) {}

  /**
   * Get all available log sources: sites + system services.
   */
  async getLogSources(userId: string, role: string): Promise<LogSource[]> {
    const sources: LogSource[] = [];

    // Site sources
    const where = role === 'ADMIN' ? {} : { userId };
    const sites = await this.prisma.site.findMany({
      where,
      select: { id: true, name: true, domain: true },
      orderBy: { name: 'asc' },
    });

    for (const site of sites) {
      sources.push({
        id: `site:${site.id}`,
        name: site.name,
        type: 'site',
        types: ['access', 'error', 'php', 'app'],
        domain: site.domain,
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

    if (source.startsWith('site:')) {
      const siteId = source.slice(5);
      return this.getSiteLogs(siteId, userId, role, type, maxLines);
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

    throw new BadRequestException('Invalid source format. Use site:{id} or system:{service}');
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
    if (source.startsWith('site:')) {
      const siteId = source.slice(5);
      const site = await this.getSiteOrFail(siteId, userId, role);

      // Map type to file path (must match agent LogReader.resolveLogPath).
      // Логи теперь якорятся на Site.name (неизменяемый юзер-юзер), не на домене.
      const anchor = site.name || site.domain;
      switch (type) {
        case 'access':
          return `/var/log/nginx/${anchor}-access.log`;
        case 'error':
          return `/var/log/nginx/${anchor}-error.log`;
        case 'php':
          return `/var/log/php/${anchor}-error.log`;
        case 'app':
          if (site.name) {
            return `/root/.pm2/logs/${site.name}-out.log`;
          }
          throw new BadRequestException('App logs not available for this site');
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

  // --- Per-site methods (kept for backward compat) ---

  async getSiteLogs(
    siteId: string,
    userId: string,
    role: string,
    type: string,
    lines?: number,
  ) {
    const site = await this.getSiteOrFail(siteId, userId, role);

    const result = await this.agentRelay.emitToAgent('site:logs', {
      systemUser: site.systemUser,
      domain: site.domain,
      type,
      siteName: site.name,
      lines: lines || 200,
    });

    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Failed to read logs');
    }

    return result.data;
  }

  async getAvailableLogs(siteId: string, userId: string, role: string) {
    const site = await this.getSiteOrFail(siteId, userId, role);

    const result = await this.agentRelay.emitToAgent('site:logs:available', {
      systemUser: site.systemUser,
      domain: site.domain,
      siteName: site.name,
    });

    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Failed to list logs');
    }

    return result.data;
  }

  private async getSiteOrFail(siteId: string, userId: string, role: string) {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: {
        id: true,
        name: true,
        domain: true,
        systemUser: true,
        userId: true,
      },
    });

    if (!site) throw new NotFoundException('Site not found');
    if (!site.systemUser) throw new NotFoundException('Site has no system user');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    return site;
  }
}
