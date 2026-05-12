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
 * Fail2ban handler — глобальный сервис, защита от брутфорса.
 *
 * Per-site методы не используются. Управление пресетами — отдельные методы
 * в `ServicesService` (getFail2banPresets / applyFail2banPresets), потому что
 * это не вписывается в стандартный install/uninstall flow.
 */
export class Fail2banServiceHandler implements ServiceHandler {
  private readonly logger = new Logger('Fail2banHandler');
  readonly key = 'fail2ban';

  constructor(private readonly agent: AgentRelayService) {}

  async isInstalledOnServer(): Promise<{ installed: boolean; version: string | null }> {
    const r = await this.agent.emitToAgent<{ installed: boolean; version: string | null }>(
      'fail2ban:server-status',
      {},
      30_000,
    );
    if (!r.success) throw new Error(r.error || 'fail2ban:server-status failed');
    return r.data!;
  }

  async installOnServer(): Promise<{ version: string }> {
    const r = await this.agent.emitToAgent<{ version: string }>(
      'fail2ban:server-install',
      {},
      600_000,
    );
    if (!r.success) throw new Error(r.error || 'fail2ban:server-install failed');
    return r.data!;
  }

  async uninstallFromServer(): Promise<void> {
    const r = await this.agent.emitToAgent<unknown>(
      'fail2ban:server-uninstall',
      {},
      300_000,
    );
    if (!r.success) throw new Error(r.error || 'fail2ban:server-uninstall failed');
  }

  // ---- Per-site методы — для глобального сервиса не имеют смысла ----
  enableForSite(): Promise<void> { throw new Error('Fail2ban — глобальный сервис'); }
  disableForSite(): Promise<void> { throw new Error('Fail2ban — глобальный сервис'); }
  startForSite(): Promise<void> { throw new Error('Fail2ban — глобальный сервис'); }
  stopForSite(): Promise<void> { throw new Error('Fail2ban — глобальный сервис'); }
  async statusForSite(_site: SiteContext): Promise<SiteServiceStatus> { return 'STOPPED'; }
  async metricsForSite(_site: SiteContext): Promise<ServiceMetrics> { return { items: [] }; }
  connectionInfoForSite(_site: SiteContext): ConnectionInfo { return { items: [] }; }
  async logsForSite(_site: SiteContext): Promise<string> { return ''; }
  reconfigureForSite(): Promise<void> { throw new Error('Fail2ban — глобальный сервис'); }
}
