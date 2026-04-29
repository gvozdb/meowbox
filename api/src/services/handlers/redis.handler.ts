import { Logger } from '@nestjs/common';
import { AgentRelayService } from '../../gateway/agent-relay.service';
import { ServiceHandler } from '../service.handler';
import {
  ConnectionInfo,
  ServiceMetrics,
  SiteContext,
  SiteServiceStatus,
} from '../service.types';

/**
 * Redis handler.
 *
 * Модель: per-site daemon с unix-сокетом, без TCP.
 *   - data_dir: /var/lib/redis/{siteName}/
 *   - socket: /var/www/{siteName}/tmp/redis.sock
 *   - config: /var/lib/redis/{siteName}/redis.conf
 *   - logs: /var/www/{siteName}/logs/redis.log
 *   - systemd: redis@{siteName}.service (наш template, не системный redis-server)
 *   - .env: /var/www/{siteName}/.meowbox/redis/.env
 *
 * Серверная установка ставит apt-пакет `redis-server`, отключает дефолтный
 * системный демон и кладёт template-unit `redis@.service`.
 */
export class RedisServiceHandler implements ServiceHandler {
  private readonly logger = new Logger('RedisHandler');
  readonly key = 'redis';

  constructor(private readonly agent: AgentRelayService) {}

  async isInstalledOnServer(): Promise<{ installed: boolean; version: string | null }> {
    const r = await this.agent.emitToAgent<{ installed: boolean; version: string | null }>(
      'redis:server-status',
      {},
      30_000,
    );
    if (!r.success) throw new Error(r.error || 'redis:server-status failed');
    return r.data!;
  }

  async installOnServer(): Promise<{ version: string }> {
    const r = await this.agent.emitToAgent<{ version: string }>(
      'redis:server-install',
      {},
      300_000,
    );
    if (!r.success) throw new Error(r.error || 'redis:server-install failed');
    return r.data!;
  }

  async uninstallFromServer(): Promise<void> {
    const r = await this.agent.emitToAgent<unknown>('redis:server-uninstall', {}, 120_000);
    if (!r.success) throw new Error(r.error || 'redis:server-uninstall failed');
  }

  async enableForSite(site: SiteContext, config: Record<string, unknown>): Promise<void> {
    const memoryMaxMb = this.parseMemory(config);
    const r = await this.agent.emitToAgent<unknown>(
      'redis:site-enable',
      {
        siteName: site.name,
        systemUser: site.systemUser,
        rootPath: site.rootPath,
        memoryMaxMb,
      },
      120_000,
    );
    if (!r.success) throw new Error(r.error || 'redis:site-enable failed');
  }

  async disableForSite(site: SiteContext): Promise<void> {
    const r = await this.agent.emitToAgent<unknown>(
      'redis:site-disable',
      {
        siteName: site.name,
        systemUser: site.systemUser,
        rootPath: site.rootPath,
      },
      120_000,
    );
    if (!r.success) throw new Error(r.error || 'redis:site-disable failed');
  }

  async startForSite(site: SiteContext): Promise<void> {
    const r = await this.agent.emitToAgent<unknown>(
      'redis:site-start',
      { siteName: site.name },
      60_000,
    );
    if (!r.success) throw new Error(r.error || 'redis:site-start failed');
  }

  async stopForSite(site: SiteContext): Promise<void> {
    const r = await this.agent.emitToAgent<unknown>(
      'redis:site-stop',
      { siteName: site.name },
      60_000,
    );
    if (!r.success) throw new Error(r.error || 'redis:site-stop failed');
  }

  async statusForSite(site: SiteContext): Promise<SiteServiceStatus> {
    try {
      const r = await this.agent.emitToAgent<{ status: SiteServiceStatus }>(
        'redis:site-status',
        { siteName: site.name },
        15_000,
      );
      if (!r.success || !r.data) return 'ERROR';
      return r.data.status;
    } catch {
      return 'ERROR';
    }
  }

  async metricsForSite(site: SiteContext): Promise<ServiceMetrics> {
    try {
      const r = await this.agent.emitToAgent<{
        usedMemory: number;
        usedMemoryPeak: number;
        maxMemory: number;
        connectedClients: number;
        keysCount: number;
        commandsTotal: number;
        diskBytes: number;
        uptimeSec: number;
      }>('redis:site-metrics', { siteName: site.name, rootPath: site.rootPath }, 30_000);
      if (!r.success || !r.data) return { items: [] };
      const d = r.data;
      const items: Array<{ label: string; value: string }> = [
        { label: 'Ключей', value: d.keysCount.toLocaleString('ru-RU') },
        { label: 'Память', value: `${humanBytes(d.usedMemory)} / ${humanBytes(d.maxMemory)}` },
        { label: 'Пик памяти', value: humanBytes(d.usedMemoryPeak) },
        { label: 'Клиентов', value: String(d.connectedClients) },
        { label: 'Команд всего', value: d.commandsTotal.toLocaleString('ru-RU') },
        { label: 'Размер на диске', value: humanBytes(d.diskBytes) },
        { label: 'Uptime', value: humanUptime(d.uptimeSec) },
      ];
      return { items, diskBytes: d.diskBytes, uptimeSec: d.uptimeSec };
    } catch {
      return { items: [] };
    }
  }

  connectionInfoForSite(site: SiteContext): ConnectionInfo {
    const tmp = `${site.rootPath}/tmp`;
    return {
      items: [
        { label: 'Unix socket', value: `${tmp}/redis.sock`, copyable: true },
        { label: 'Database', value: '0 (по умолчанию)', copyable: true },
        { label: 'TCP', value: 'отключён (port 0)', copyable: false },
        { label: '.env файл', value: `${site.rootPath}/.meowbox/redis/.env`, copyable: true },
      ],
      hint:
        'PHP: new Redis(); $r->connect("/var/www/' + site.name + '/tmp/redis.sock"); — никаких паролей, изоляция через права socket файла.',
    };
  }

  async logsForSite(site: SiteContext, lines: number = 200): Promise<string> {
    try {
      const r = await this.agent.emitToAgent<{ content: string }>(
        'redis:site-logs',
        { siteName: site.name, rootPath: site.rootPath, lines },
        30_000,
      );
      if (!r.success || !r.data) return r.error || '(no logs)';
      return r.data.content;
    } catch (err) {
      return `Ошибка чтения логов: ${(err as Error).message}`;
    }
  }

  async reconfigureForSite(site: SiteContext, config: Record<string, unknown>): Promise<void> {
    const memoryMaxMb = this.parseMemory(config);
    const r = await this.agent.emitToAgent<unknown>(
      'redis:site-reconfigure',
      { siteName: site.name, memoryMaxMb },
      60_000,
    );
    if (!r.success) throw new Error(r.error || 'redis:site-reconfigure failed');
  }

  private parseMemory(config: Record<string, unknown>): number {
    const raw = config?.memoryMaxMb;
    const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
    if (!Number.isFinite(n) || n <= 0) return 64;
    if (n < 16) return 16;
    if (n > 4096) return 4096;
    return Math.floor(n);
  }
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function humanUptime(sec: number): string {
  if (sec < 60) return `${sec}с`;
  if (sec < 3600) return `${Math.floor(sec / 60)}м`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}ч ${Math.floor((sec % 3600) / 60)}м`;
  return `${Math.floor(sec / 86400)}д ${Math.floor((sec % 86400) / 3600)}ч`;
}
