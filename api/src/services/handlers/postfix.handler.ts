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
 * Postfix handler — глобальный сервис системной почты (relay-only).
 *
 * Per-site методы не используются: postfix у нас одна штука на сервер,
 * отправляет письма от cron/fail2ban/certbot через внешний smarthost.
 * Управление relay-конфигом — отдельные методы в ServicesService
 * (`getPostfixRelay`, `applyPostfixRelay`, `sendPostfixTestEmail`),
 * аналогично fail2ban-пресетам.
 */
export class PostfixServiceHandler implements ServiceHandler {
  private readonly logger = new Logger('PostfixHandler');
  readonly key = 'postfix';

  constructor(private readonly agent: AgentRelayService) {}

  async isInstalledOnServer(): Promise<{ installed: boolean; version: string | null }> {
    const r = await this.agent.emitToAgent<{ installed: boolean; version: string | null }>(
      'postfix:server-status',
      {},
      30_000,
    );
    if (!r.success) throw new Error(r.error || 'postfix:server-status failed');
    return r.data!;
  }

  async installOnServer(): Promise<{ version: string }> {
    const r = await this.agent.emitToAgent<{ version: string }>(
      'postfix:server-install',
      {},
      600_000,
    );
    if (!r.success) throw new Error(r.error || 'postfix:server-install failed');
    return r.data!;
  }

  async uninstallFromServer(): Promise<void> {
    const r = await this.agent.emitToAgent<unknown>(
      'postfix:server-uninstall',
      {},
      300_000,
    );
    if (!r.success) throw new Error(r.error || 'postfix:server-uninstall failed');
  }

  // ---- Per-site методы — для глобального сервиса не имеют смысла ----
  enableForSite(): Promise<void> { throw new Error('Postfix — глобальный сервис'); }
  disableForSite(): Promise<void> { throw new Error('Postfix — глобальный сервис'); }
  startForSite(): Promise<void> { throw new Error('Postfix — глобальный сервис'); }
  stopForSite(): Promise<void> { throw new Error('Postfix — глобальный сервис'); }
  async statusForSite(_site: SiteContext): Promise<SiteServiceStatus> { return 'STOPPED'; }
  async metricsForSite(_site: SiteContext): Promise<ServiceMetrics> { return { items: [] }; }
  connectionInfoForSite(_site: SiteContext): ConnectionInfo { return { items: [] }; }
  async logsForSite(_site: SiteContext): Promise<string> { return ''; }
  reconfigureForSite(): Promise<void> { throw new Error('Postfix — глобальный сервис'); }
}
