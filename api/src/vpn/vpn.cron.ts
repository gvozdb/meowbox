import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { VpnService } from './vpn.service';

/**
 * Periodic SNI health check для всех VLESS+Reality сервисов.
 *
 * Раз в 6 часов прогоняет TLS-handshake к маске каждого сервиса.
 * Если упало 2 раза подряд — UI горит warning'ом + (TODO) push-нотификация.
 *
 * См. docs/specs/2026-05-09-vpn-management.md §7.6.
 */
@Injectable()
export class VpnSniCron {
  private readonly logger = new Logger('VpnSniCron');

  constructor(private readonly vpn: VpnService) {}

  @Cron(CronExpression.EVERY_6_HOURS)
  async runCheck(): Promise<void> {
    try {
      const r = await this.vpn.runSniHealthCheck();
      if (r.checked === 0) return;
      this.logger.log(
        `SNI health check: checked=${r.checked} failed=${r.failed}`,
      );
    } catch (err) {
      this.logger.warn(`SNI cron failed: ${(err as Error).message}`);
    }
  }
}
