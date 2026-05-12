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
 * SSH handler — системный сервис (openssh-server).
 *
 * Зачем он в каталоге:
 *   - чтобы редактировать /etc/ssh/sshd_config из панели (с валидацией `sshd -t`);
 *   - чтобы рестартовать ssh.service после изменений;
 *   - чтобы видеть текущий статус (installed, version).
 *
 * Уничтожить его через панель НЕВОЗМОЖНО (uninstallable=false в catalog).
 * Per-site методы не имеют смысла — глобальный сервис.
 */
export class SshServiceHandler implements ServiceHandler {
  private readonly logger = new Logger('SshHandler');
  readonly key = 'ssh';

  constructor(private readonly agent: AgentRelayService) {}

  async isInstalledOnServer(): Promise<{ installed: boolean; version: string | null }> {
    const r = await this.agent.emitToAgent<{ installed: boolean; version: string | null }>(
      'ssh:server-status',
      {},
      30_000,
    );
    if (!r.success) throw new Error(r.error || 'ssh:server-status failed');
    return r.data!;
  }

  async installOnServer(): Promise<{ version: string }> {
    const r = await this.agent.emitToAgent<{ version: string }>(
      'ssh:server-install',
      {},
      600_000,
    );
    if (!r.success) throw new Error(r.error || 'ssh:server-install failed');
    return r.data!;
  }

  async uninstallFromServer(): Promise<void> {
    // Каталог уже отсекает удаление по `uninstallable=false`, но добавляем явный
    // throw — на случай если кто-то напрямую дернёт handler. Лучше шумно упасть.
    throw new Error('SSH — системный сервис, удаление через панель запрещено');
  }

  // ---- Per-site методы — для глобального сервиса не имеют смысла ----
  enableForSite(): Promise<void> { throw new Error('SSH — глобальный сервис'); }
  disableForSite(): Promise<void> { throw new Error('SSH — глобальный сервис'); }
  startForSite(): Promise<void> { throw new Error('SSH — глобальный сервис'); }
  stopForSite(): Promise<void> { throw new Error('SSH — глобальный сервис'); }
  async statusForSite(_site: SiteContext): Promise<SiteServiceStatus> { return 'STOPPED'; }
  async metricsForSite(_site: SiteContext): Promise<ServiceMetrics> { return { items: [] }; }
  connectionInfoForSite(_site: SiteContext): ConnectionInfo { return { items: [] }; }
  async logsForSite(_site: SiteContext): Promise<string> { return ''; }
  reconfigureForSite(): Promise<void> { throw new Error('SSH — глобальный сервис'); }
}
