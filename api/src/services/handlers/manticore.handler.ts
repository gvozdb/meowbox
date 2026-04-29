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
 * Manticore Search handler.
 *
 * Модель: per-site daemon. На каждый активированный сайт стартует отдельный
 * процесс `searchd`, изолированный от остальных:
 *   - data_dir: /var/lib/manticore/{siteName}/
 *   - сокеты: /var/www/{siteName}/tmp/manticore.sock + manticore-http.sock
 *   - systemd: manticore@{siteName}.service (через template unit)
 *   - logs: /var/www/{siteName}/logs/manticore*.log
 *   - env-файл: /var/www/{siteName}/.meowbox/manticore/.env (для удобства)
 *
 * Установка демона на сервер ставит apt-пакет `manticore` и кладёт
 * template-unit `/etc/systemd/system/manticore@.service` (без global-демона).
 *
 * Все системные действия делегируются на агент через socket.
 */
export class ManticoreServiceHandler implements ServiceHandler {
  private readonly logger = new Logger('ManticoreHandler');
  readonly key = 'manticore';

  constructor(private readonly agent: AgentRelayService) {}

  // ===== Server level =====

  async isInstalledOnServer(): Promise<{ installed: boolean; version: string | null }> {
    const r = await this.agent.emitToAgent<{ installed: boolean; version: string | null }>(
      'manticore:server-status',
      {},
      30_000,
    );
    if (!r.success) throw new Error(r.error || 'manticore:server-status failed');
    return r.data!;
  }

  async installOnServer(): Promise<{ version: string }> {
    const r = await this.agent.emitToAgent<{ version: string }>(
      'manticore:server-install',
      {},
      300_000,
    );
    if (!r.success) throw new Error(r.error || 'manticore:server-install failed');
    return r.data!;
  }

  async uninstallFromServer(): Promise<void> {
    const r = await this.agent.emitToAgent<unknown>(
      'manticore:server-uninstall',
      {},
      120_000,
    );
    if (!r.success) throw new Error(r.error || 'manticore:server-uninstall failed');
  }

  // ===== Site level =====

  async enableForSite(site: SiteContext, config: Record<string, unknown>): Promise<void> {
    const memoryMaxMb = this.parseMemory(config);
    const r = await this.agent.emitToAgent<unknown>(
      'manticore:site-enable',
      {
        siteName: site.name,
        systemUser: site.systemUser,
        rootPath: site.rootPath,
        memoryMaxMb,
      },
      120_000,
    );
    if (!r.success) throw new Error(r.error || 'manticore:site-enable failed');
  }

  async disableForSite(site: SiteContext): Promise<void> {
    const r = await this.agent.emitToAgent<unknown>(
      'manticore:site-disable',
      {
        siteName: site.name,
        systemUser: site.systemUser,
        rootPath: site.rootPath,
      },
      120_000,
    );
    if (!r.success) throw new Error(r.error || 'manticore:site-disable failed');
  }

  async startForSite(site: SiteContext): Promise<void> {
    const r = await this.agent.emitToAgent<unknown>(
      'manticore:site-start',
      { siteName: site.name },
      60_000,
    );
    if (!r.success) throw new Error(r.error || 'manticore:site-start failed');
  }

  async stopForSite(site: SiteContext): Promise<void> {
    const r = await this.agent.emitToAgent<unknown>(
      'manticore:site-stop',
      { siteName: site.name },
      60_000,
    );
    if (!r.success) throw new Error(r.error || 'manticore:site-stop failed');
  }

  async statusForSite(site: SiteContext): Promise<SiteServiceStatus> {
    try {
      const r = await this.agent.emitToAgent<{ status: SiteServiceStatus }>(
        'manticore:site-status',
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
        tables: number;
        documents: number;
        diskBytes: number;
        uptimeSec: number;
        lastQueryAt?: number | null;
      }>('manticore:site-metrics', { siteName: site.name, rootPath: site.rootPath }, 30_000);
      if (!r.success || !r.data) return { items: [] };
      const d = r.data;
      const items: Array<{ label: string; value: string }> = [
        { label: 'Таблиц', value: String(d.tables) },
        { label: 'Документов', value: d.documents.toLocaleString('ru-RU') },
        { label: 'Размер', value: humanBytes(d.diskBytes) },
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
        { label: 'MySQL-протокол (socket)', value: `${tmp}/manticore.sock`, copyable: true },
        { label: 'HTTP-протокол (socket)', value: `${tmp}/manticore-http.sock`, copyable: true },
        { label: 'Data dir', value: `/var/lib/manticore/${site.name}`, copyable: true },
        { label: '.env файл', value: `${site.rootPath}/.meowbox/manticore/.env`, copyable: true },
      ],
      hint:
        'Подключайся к Unix-сокету через PHP \\Manticoresearch\\Client. Имена таблиц задаёшь сам через CREATE TABLE.',
    };
  }

  async logsForSite(site: SiteContext, lines: number = 200): Promise<string> {
    try {
      const r = await this.agent.emitToAgent<{ content: string }>(
        'manticore:site-logs',
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
      'manticore:site-reconfigure',
      { siteName: site.name, memoryMaxMb },
      60_000,
    );
    if (!r.success) throw new Error(r.error || 'manticore:site-reconfigure failed');
  }

  // ===== helpers =====

  private parseMemory(config: Record<string, unknown>): number {
    const raw = config?.memoryMaxMb;
    const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
    if (!Number.isFinite(n) || n <= 0) return 128;
    // Защита от безумных значений
    if (n < 32) return 32;
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
