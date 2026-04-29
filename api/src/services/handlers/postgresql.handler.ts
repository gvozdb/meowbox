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
 * PostgreSQL handler — глобальный сервис.
 *
 * Один общий postgres-демон на все сайты. peer auth для роли `postgres` →
 * агент подключается через `sudo -u postgres psql`.
 *
 * Поведение и ограничения те же, что у MariaDB-хэндлера: per-site методы
 * не имеют смысла, бросают ошибку если их дёрнули в обход scope-фильтра.
 */
export class PostgresqlServiceHandler implements ServiceHandler {
  private readonly logger = new Logger('PostgresqlHandler');
  readonly key = 'postgresql';

  constructor(private readonly agent: AgentRelayService) {}

  async isInstalledOnServer(): Promise<{ installed: boolean; version: string | null }> {
    const r = await this.agent.emitToAgent<{ installed: boolean; version: string | null }>(
      'postgresql:server-status',
      {},
      30_000,
    );
    if (!r.success) throw new Error(r.error || 'postgresql:server-status failed');
    return r.data!;
  }

  async installOnServer(): Promise<{ version: string }> {
    const r = await this.agent.emitToAgent<{ version: string }>(
      'postgresql:server-install',
      {},
      600_000,
    );
    if (!r.success) throw new Error(r.error || 'postgresql:server-install failed');
    return r.data!;
  }

  async uninstallFromServer(): Promise<void> {
    const r = await this.agent.emitToAgent<unknown>(
      'postgresql:server-uninstall',
      {},
      300_000,
    );
    if (!r.success) throw new Error(r.error || 'postgresql:server-uninstall failed');
  }

  // ---- Per-site методы — для глобального сервиса не имеют смысла ----

  enableForSite(): Promise<void> {
    throw new Error('PostgreSQL — глобальный сервис, per-site enable не поддерживается. БД создаётся через /databases.');
  }
  disableForSite(): Promise<void> {
    throw new Error('PostgreSQL — глобальный сервис, per-site disable не поддерживается');
  }
  startForSite(): Promise<void> {
    throw new Error('PostgreSQL — глобальный сервис, per-site start не поддерживается');
  }
  stopForSite(): Promise<void> {
    throw new Error('PostgreSQL — глобальный сервис, per-site stop не поддерживается');
  }
  async statusForSite(_site: SiteContext): Promise<SiteServiceStatus> {
    return 'STOPPED';
  }
  async metricsForSite(_site: SiteContext): Promise<ServiceMetrics> {
    return { items: [] };
  }
  connectionInfoForSite(_site: SiteContext): ConnectionInfo {
    return { items: [] };
  }
  async logsForSite(_site: SiteContext): Promise<string> {
    return '';
  }
  reconfigureForSite(): Promise<void> {
    throw new Error('PostgreSQL — глобальный сервис, reconfigure не поддерживается');
  }
}
