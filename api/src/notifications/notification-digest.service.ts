import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { NotificationDispatcherService } from './notification-dispatcher.service';

export type DigestConfigType = 'SITE_SCHEDULE' | 'SERVER_PATH' | 'PANEL_DATA';
export type DigestNotificationMode = 'INSTANT' | 'DIGEST' | 'FAILURES_ONLY';

/**
 * Параметры одного завершившегося бэкапа, которые нужно либо отправить
 * пользователю мгновенно, либо положить в очередь дайджеста — в зависимости
 * от `mode` конкретного бэкап-конфига.
 */
interface BackupCompletionEvent {
  configType: DigestConfigType;
  configId: string;
  configName: string;
  /** Что показать в шапке "X объект ...": site/path/panel-data-name. */
  resourceLabel: string;
  success: boolean;
  sizeBytes?: number;
  errorMessage?: string;
}

/**
 * Управляет уведомлениями о бэкапах с учётом notificationMode конфига.
 *
 * Три режима:
 *   - INSTANT          — мгновенно через NotificationDispatcherService (старое поведение).
 *   - DIGEST           — копится в notification_digest_queue, отдельный cron шлёт пачкой.
 *   - FAILURES_ONLY    — INSTANT, но только при ошибке (success=false).
 *
 * Точка входа: handleCompletion() — её зовёт completeBackup() в каждом из
 * трёх backup-сервисов.
 *
 * Flush крон: flushDue() — обходит конфиги с notificationMode=DIGEST, для тех
 * у кого совпало digestSchedule — собирает unsent записи очереди по этому
 * configId, формирует одно сообщение и отправляет через dispatch.
 */
@Injectable()
export class NotificationDigestService {
  private readonly logger = new Logger('NotificationDigest');

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: NotificationDispatcherService,
  ) {}

  // =========================================================================
  // Точка входа: вызывается из completeBackup()
  // =========================================================================

  async handleCompletion(
    event: BackupCompletionEvent,
    mode: DigestNotificationMode,
  ): Promise<void> {
    const eventName = event.success ? 'BACKUP_COMPLETED' : 'BACKUP_FAILED';
    const message = this.formatInstantMessage(event);
    const title = this.formatTitle(event);

    if (mode === 'INSTANT') {
      await this.dispatchInstant({
        event: eventName,
        title,
        message,
        siteName: event.resourceLabel,
        timestamp: new Date(),
      });
      return;
    }

    if (mode === 'FAILURES_ONLY') {
      if (event.success) return; // молчим про OK
      await this.dispatchInstant({
        event: eventName,
        title,
        message,
        siteName: event.resourceLabel,
        timestamp: new Date(),
      });
      return;
    }

    // DIGEST — складываем в очередь
    if (mode === 'DIGEST') {
      await this.prisma.notificationDigestQueue.create({
        data: {
          configType: event.configType,
          configId: event.configId,
          configName: event.configName,
          event: eventName,
          resourceLabel: event.resourceLabel,
          sizeBytes: typeof event.sizeBytes === 'number' ? BigInt(event.sizeBytes) : null,
          message: event.errorMessage || null,
        },
      });
      return;
    }

    // Неизвестный mode — пишем в лог и шлём как INSTANT (fail-safe).
    this.logger.warn(`Unknown notificationMode "${mode}" — falling back to INSTANT`);
    await this.dispatchInstant({
      event: eventName,
      title,
      message,
      siteName: event.resourceLabel,
      timestamp: new Date(),
    });
  }

  // =========================================================================
  // Cron flush — вызывается каждую минуту scheduler'ом
  // =========================================================================

  /**
   * Обходит все конфиги с DIGEST режимом и совпавшим cron, собирает unsent
   * события из очереди и шлёт одним сообщением.
   *
   * @param shouldRunNow — функция cron-матчера (передаём snippет из scheduler'а
   *                      чтобы избежать дублирования логики парсера).
   */
  async flushDue(
    now: Date,
    shouldRunNow: (cron: string, now: Date) => boolean,
  ): Promise<{ flushed: number; skipped: number }> {
    let flushed = 0;
    let skipped = 0;

    // --- Server-path ---
    const serverPathConfigs = await this.prisma.serverPathBackupConfig.findMany({
      where: { notificationMode: 'DIGEST', digestSchedule: { not: null } },
      select: { id: true, name: true, digestSchedule: true },
    });
    for (const config of serverPathConfigs) {
      if (!config.digestSchedule) continue;
      if (!shouldRunNow(config.digestSchedule, now)) {
        skipped++;
        continue;
      }
      const sent = await this.flushOneConfig('SERVER_PATH', config.id, config.name);
      if (sent) flushed++;
    }

    // --- Panel-data ---
    const panelDataConfigs = await this.prisma.panelDataBackupConfig.findMany({
      where: { notificationMode: 'DIGEST', digestSchedule: { not: null } },
      select: { id: true, name: true, digestSchedule: true },
    });
    for (const config of panelDataConfigs) {
      if (!config.digestSchedule) continue;
      if (!shouldRunNow(config.digestSchedule, now)) {
        skipped++;
        continue;
      }
      const sent = await this.flushOneConfig('PANEL_DATA', config.id, config.name);
      if (sent) flushed++;
    }

    // --- Site backup schedules (per-site бэкапы по глобальным шедулям) ---
    // BackupsService.completeBackup() кладёт в очередь по configId = scheduleId,
    // когда у бэкапа выставлен scheduleId (см. SiteBackupSchedule.triggerForAllSites).
    // Здесь по cron шедуля отдаём накопленные события одной пачкой на чат.
    const siteSchedules = await this.prisma.siteBackupSchedule.findMany({
      where: { notificationMode: 'DIGEST', digestSchedule: { not: null } },
      select: { id: true, name: true, digestSchedule: true },
    });
    for (const schedule of siteSchedules) {
      if (!schedule.digestSchedule) continue;
      if (!shouldRunNow(schedule.digestSchedule, now)) {
        skipped++;
        continue;
      }
      const sent = await this.flushOneConfig('SITE_SCHEDULE', schedule.id, schedule.name);
      if (sent) flushed++;
    }

    return { flushed, skipped };
  }

  // =========================================================================
  // Internals
  // =========================================================================

  private async flushOneConfig(
    configType: DigestConfigType,
    configId: string,
    configName: string,
  ): Promise<boolean> {
    const items = await this.prisma.notificationDigestQueue.findMany({
      where: { configType, configId, sentAt: null },
      orderBy: { createdAt: 'asc' },
    });

    if (items.length === 0) {
      return false;
    }

    const okCount = items.filter((i) => i.event === 'BACKUP_COMPLETED').length;
    const failCount = items.filter((i) => i.event === 'BACKUP_FAILED').length;

    const lines: string[] = [];
    lines.push(`📦 Дайджест бэкапов "${configName}" (${items.length})`);
    lines.push('');

    if (okCount > 0) {
      lines.push(`✅ Успешно: ${okCount}`);
      const okItems = items.filter((i) => i.event === 'BACKUP_COMPLETED');
      const shown = okItems.slice(0, 20);
      for (const it of shown) {
        const t = new Date(it.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const sz = it.sizeBytes ? ` (${this.formatBytes(Number(it.sizeBytes))})` : '';
        lines.push(`  • ${t} — ${it.resourceLabel}${sz}`);
      }
      if (okItems.length > shown.length) {
        lines.push(`  • … ещё ${okItems.length - shown.length}`);
      }
    }

    if (failCount > 0) {
      if (okCount > 0) lines.push('');
      lines.push(`❌ Ошибки: ${failCount}`);
      const failItems = items.filter((i) => i.event === 'BACKUP_FAILED');
      const shown = failItems.slice(0, 10);
      for (const it of shown) {
        const t = new Date(it.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const err = it.message ? ` — ${it.message.slice(0, 80)}` : '';
        lines.push(`  • ${t} — ${it.resourceLabel}${err}`);
      }
      if (failItems.length > shown.length) {
        lines.push(`  • … ещё ${failItems.length - shown.length}`);
      }
    }

    const event = failCount > 0 ? 'BACKUP_FAILED' : 'BACKUP_COMPLETED';
    const title = failCount > 0
      ? `Backup digest: ${failCount} failed, ${okCount} ok`
      : `Backup digest: ${okCount} ok`;

    await this.dispatchInstant({
      event,
      title,
      message: lines.join('\n'),
      timestamp: new Date(),
    });

    // Помечаем все как отправленные
    const now = new Date();
    await this.prisma.notificationDigestQueue.updateMany({
      where: { id: { in: items.map((i) => i.id) } },
      data: { sentAt: now },
    });

    return true;
  }

  private async dispatchInstant(payload: {
    event: string;
    title: string;
    message: string;
    siteName?: string;
    timestamp?: Date;
  }) {
    try {
      await this.dispatcher.dispatch(payload);
    } catch (err) {
      this.logger.error(`dispatch failed: ${(err as Error).message}`);
    }
  }

  private formatTitle(event: BackupCompletionEvent): string {
    const ok = event.success;
    switch (event.configType) {
      case 'SERVER_PATH':
        return ok ? 'Server-path Backup Completed' : 'Server-path Backup Failed';
      case 'PANEL_DATA':
        return ok ? 'Panel-data Backup Completed' : 'Panel-data Backup Failed';
      case 'SITE_SCHEDULE':
      default:
        return ok ? 'Backup Completed' : 'Backup Failed';
    }
  }

  private formatInstantMessage(event: BackupCompletionEvent): string {
    if (event.success) {
      const sz = typeof event.sizeBytes === 'number'
        ? ` (${this.formatBytes(event.sizeBytes)})`
        : '';
      return `Backup "${event.configName}" → ${event.resourceLabel} completed${sz}`;
    }
    return `Backup "${event.configName}" → ${event.resourceLabel} failed: ${event.errorMessage || 'unknown error'}`;
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1073741824).toFixed(2)} GB`;
  }
}
