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
 * MariaDB handler — глобальный сервис.
 *
 * Один общий MariaDB-демон обслуживает все сайты (per-site mysqld был бы overkill
 * по RAM). Per-site разделение на уровне БД-юзера (CREATE USER ... GRANT ...).
 *
 * Сервер ставит install.sh из коробки (apt install mariadb-server), но через
 * /services админ может его снести (если на сайтах MariaDB не используется),
 * либо переустановить.
 *
 * unix_socket auth для root → агент подключается как `mariadb -u root` без пароля.
 *
 * Per-site методы (enableForSite/disableForSite/etc.) НЕ ИМЕЮТ СМЫСЛА для глобальных
 * сервисов — для каждого сайта база создаётся через отдельный механизм
 * (DatabasesService → agent.db:create), а не через активацию SiteService.
 * Если кто-то их случайно дёрнет (в обход scope-фильтра в UI) — кидаем явную
 * ошибку, чтобы поймать баг как можно раньше.
 */
export class MariadbServiceHandler implements ServiceHandler {
  private readonly logger = new Logger('MariadbHandler');
  readonly key = 'mariadb';

  constructor(private readonly agent: AgentRelayService) {}

  async isInstalledOnServer(): Promise<{ installed: boolean; version: string | null }> {
    const r = await this.agent.emitToAgent<{ installed: boolean; version: string | null }>(
      'mariadb:server-status',
      {},
      30_000,
    );
    if (!r.success) throw new Error(r.error || 'mariadb:server-status failed');
    return r.data!;
  }

  async installOnServer(): Promise<{ version: string }> {
    const r = await this.agent.emitToAgent<{ version: string }>(
      'mariadb:server-install',
      {},
      600_000,
    );
    if (!r.success) throw new Error(r.error || 'mariadb:server-install failed');
    return r.data!;
  }

  async uninstallFromServer(): Promise<void> {
    const r = await this.agent.emitToAgent<unknown>(
      'mariadb:server-uninstall',
      {},
      300_000,
    );
    if (!r.success) throw new Error(r.error || 'mariadb:server-uninstall failed');
  }

  // ---- Per-site методы — для глобального сервиса не имеют смысла ----

  enableForSite(): Promise<void> {
    throw new Error('MariaDB — глобальный сервис, per-site enable не поддерживается. БД создаётся через /databases.');
  }
  disableForSite(): Promise<void> {
    throw new Error('MariaDB — глобальный сервис, per-site disable не поддерживается');
  }
  startForSite(): Promise<void> {
    throw new Error('MariaDB — глобальный сервис, per-site start не поддерживается');
  }
  stopForSite(): Promise<void> {
    throw new Error('MariaDB — глобальный сервис, per-site stop не поддерживается');
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
    throw new Error('MariaDB — глобальный сервис, reconfigure не поддерживается');
  }
}
