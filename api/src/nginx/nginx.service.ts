import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { PrismaService } from '../common/prisma.service';

export interface NginxStatus {
  running: boolean;
  version: string | null;
}

export interface ConfigListItem {
  domain: string;
  enabled: boolean;
  siteName?: string;
  siteId?: string;
}

@Injectable()
export class NginxService {
  private readonly logger = new Logger('NginxService');

  constructor(
    private readonly agentRelay: AgentRelayService,
    private readonly prisma: PrismaService,
  ) {}

  async getStatus(): Promise<NginxStatus> {
    const result = await this.agentRelay.emitToAgent<NginxStatus>(
      'nginx:status',
      {},
    );
    if (!result.success) {
      throw new InternalServerErrorException(
        result.error || 'Failed to get nginx status',
      );
    }
    return result.data!;
  }

  async test(): Promise<{ valid: boolean; output?: string }> {
    const result = await this.agentRelay.emitToAgent<void>('nginx:test', {});
    return {
      valid: result.success,
      output: result.error,
    };
  }

  async reload(): Promise<void> {
    const result = await this.agentRelay.emitToAgent('nginx:reload', {});
    if (!result.success) {
      throw new InternalServerErrorException(
        result.error || 'Failed to reload nginx',
      );
    }
    this.logger.log('Nginx reloaded');
  }

  async listConfigs(): Promise<ConfigListItem[]> {
    // List configs from agent filesystem
    const result = await this.agentRelay.emitToAgent<string[]>(
      'nginx:list-configs',
      {},
    );

    // Even if agent doesn't support list-configs, fallback to DB sites
    const sites = await this.prisma.site.findMany({
      select: { id: true, name: true, domain: true },
    });

    const siteMap = new Map(sites.map((s) => [s.domain, s]));

    if (result.success && result.data) {
      return result.data.map((domain) => {
        const site = siteMap.get(domain);
        return {
          domain,
          enabled: true,
          siteName: site?.name,
          siteId: site?.id,
        };
      });
    }

    // Fallback: just return sites from DB
    return sites.map((s) => ({
      domain: s.domain,
      enabled: true,
      siteName: s.name,
      siteId: s.id,
    }));
  }

  /**
   * Резолвим «ключ конфига» в siteName (неизменяемый якорь путей). На вход
   * обычно приходит domain (из старого UI-роутинга и списка configs) —
   * по нему ищем сайт в БД и достаём его `name`. Для файлов, которые
   * не принадлежат meowbox-сайту (ручной nginx-конфиг), оставляем как есть.
   */
  private async resolveAnchor(key: string): Promise<{ siteName?: string; domain: string }> {
    const site = await this.prisma.site.findFirst({
      where: { OR: [{ name: key }, { domain: key }] },
      select: { name: true, domain: true },
    });
    if (site) return { siteName: site.name, domain: site.domain };
    return { domain: key };
  }

  async readConfig(key: string): Promise<string | null> {
    const { siteName, domain } = await this.resolveAnchor(key);
    const result = await this.agentRelay.emitToAgent<string | null>(
      'nginx:read-config',
      { siteName, domain },
    );
    if (!result.success) {
      throw new InternalServerErrorException(
        result.error || 'Failed to read config',
      );
    }
    return result.data ?? null;
  }

  async updateConfig(key: string, config: string): Promise<void> {
    const { siteName, domain } = await this.resolveAnchor(key);
    const result = await this.agentRelay.emitToAgent('nginx:update-config', {
      siteName,
      domain,
      config,
    });
    if (!result.success) {
      throw new InternalServerErrorException(
        result.error || 'Failed to update config (nginx -t failed)',
      );
    }
    this.logger.log(`Nginx config updated for ${siteName || domain}`);
  }

  async readGlobalConfig(): Promise<string | null> {
    const result = await this.agentRelay.emitToAgent<string | null>(
      'nginx:read-global-config',
      {},
    );
    if (!result.success) {
      throw new InternalServerErrorException(
        result.error || 'Failed to read global config',
      );
    }
    return result.data ?? null;
  }

  async writeGlobalConfig(content: string): Promise<void> {
    const result = await this.agentRelay.emitToAgent('nginx:write-global-config', {
      content,
    });
    if (!result.success) {
      throw new InternalServerErrorException(
        result.error || 'Failed to update global config (nginx -t failed)',
      );
    }
    this.logger.log('Nginx global config updated');
  }
}
