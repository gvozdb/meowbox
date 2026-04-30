import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { ProxyService } from './proxy.service';

/**
 * Фоновый healthcheck подключённых серверов.
 *
 * Раз в минуту пингует все сервера и наполняет statusCache в ProxyService.
 * UI на /servers получает свежий снапшот без ожидания HTTP-запросов на пинг
 * (Promise.allSettled может занимать секунды для оффлайн-серверов).
 *
 * Идемпотентен: если refreshStatuses уже идёт — параллельный запуск просто
 * перезапишет кеш ещё раз (всё ок, гонок нет).
 */
@Injectable()
export class ProxyHealthcheckService {
  private readonly logger = new Logger(ProxyHealthcheckService.name);
  private inProgress = false;

  constructor(private readonly proxy: ProxyService) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'proxy-healthcheck' })
  async runHealthcheck() {
    if (this.inProgress) {
      // Если предыдущий запуск ещё не завершился (например, 50 серверов
      // и какой-то висит на 30-сек таймауте) — пропускаем тик.
      return;
    }
    this.inProgress = true;
    try {
      const servers = this.proxy.getServers();
      if (servers.length === 0) return;
      const result = await this.proxy.refreshStatuses();
      const offline = result.filter((s) => !s.online).length;
      if (offline > 0) {
        this.logger.warn(`Healthcheck: ${offline}/${result.length} servers offline`);
      }
    } catch (err) {
      this.logger.error(`Healthcheck failed: ${(err as Error).message}`);
    } finally {
      this.inProgress = false;
    }
  }
}
