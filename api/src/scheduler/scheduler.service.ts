import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma.service';
import { BackupsService } from '../backups/backups.service';
import { ServerPathBackupService } from '../backups/server-path-backup.service';
import { PanelDataBackupService } from '../backups/panel-data-backup.service';
import { ResticCheckService } from '../backups/restic-check.service';
import { SslService } from '../ssl/ssl.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { MonitoringService } from '../monitoring/monitoring.service';
import { NotificationDispatcherService } from '../notifications/notification-dispatcher.service';
import { SessionService } from '../auth/session.service';
import { SslStatus, SiteStatus, BackupStatus, DeployStatus } from '../common/enums';
import { PanelSettingsService } from '../panel-settings/panel-settings.service';
import { DnsService } from '../dns/dns.service';
import { CountryBlockService } from '../country-block/country-block.service';

// Thresholds for high load alerts (avoid alert storms with cooldown).
// Все пороги конфигурируются через env, т.к. оператор регулярно их подстраивает
// (на слабых VPS 90% CPU — норма; на хайлоаде даже 70% — already alarming).
function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const HIGH_LOAD_CPU_THRESHOLD = envInt('ALERT_CPU_THRESHOLD', 90);
const HIGH_LOAD_MEM_THRESHOLD = envInt('ALERT_MEM_THRESHOLD', 95);
const HIGH_LOAD_COOLDOWN_MS = envInt('ALERT_COOLDOWN_MS', 30 * 60 * 1000);
const DISK_ALERT_HIGH_THRESHOLD = envInt('ALERT_DISK_THRESHOLD', 80);
const DISK_ALERT_CRITICAL_THRESHOLD = envInt('ALERT_DISK_CRITICAL_THRESHOLD', 90);
// Watchdog cutoffs — за сколько считаем «зависшие» бэкапы/деплои/health-pings.
const WATCHDOG_BACKUP_TIMEOUT_MS = envInt('WATCHDOG_BACKUP_TIMEOUT_MS', 4 * 60 * 60 * 1000);
const WATCHDOG_DEPLOY_TIMEOUT_MS = envInt('WATCHDOG_DEPLOY_TIMEOUT_MS', 60 * 60 * 1000);
const HEALTH_PING_RETENTION_MS = envInt('HEALTH_PING_RETENTION_DAYS', 7) * 24 * 60 * 60 * 1000;
const DISK_SNAPSHOT_RETENTION_MS = envInt('DISK_SNAPSHOT_RETENTION_DAYS', 90) * 24 * 60 * 60 * 1000;

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger('Scheduler');
  private lastHighLoadAlert = 0;
  private lastDiskAlert = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly backupsService: BackupsService,
    private readonly serverPathBackupService: ServerPathBackupService,
    private readonly panelDataBackupService: PanelDataBackupService,
    private readonly resticCheckService: ResticCheckService,
    private readonly sslService: SslService,
    private readonly agentRelay: AgentRelayService,
    private readonly monitoringService: MonitoringService,
    private readonly notifier: NotificationDispatcherService,
    private readonly sessionService: SessionService,
    private readonly panelSettings: PanelSettingsService,
    private readonly dnsService: DnsService,
    private readonly countryBlockService: CountryBlockService,
  ) {}

  // =========================================================================
  // Country block — refresh CIDR-баз по cron из настроек (`updateSchedule`).
  //
  // Тикаем каждую минуту и сверяемся с пользовательским cron-расписанием.
  // Тот же паттерн используется для backup/check (см. handleScheduledBackups,
  // handleResticCheck) — без SchedulerRegistry, проще и надёжнее.
  // Дефолт расписания — '30 4 * * *' (каждый день в 04:30).
  // =========================================================================
  @Cron(CronExpression.EVERY_MINUTE)
  async handleCountryBlockRefresh() {
    if (!this.agentRelay.isAgentConnected()) return;
    try {
      const settings = await this.countryBlockService.getSettings();
      if (!settings.enabled) return;
      const schedule = settings.updateSchedule?.trim() || '30 4 * * *';
      if (!this.shouldRunNow(schedule, new Date())) return;

      const r = await this.countryBlockService.refreshDb();
      if (r.success) {
        this.logger.log(
          `country-block: обновлены CIDR для ${r.updated?.length || 0} стран`,
        );
      } else {
        this.logger.warn(
          `country-block refresh: ${r.error || (r.errors || []).join('; ')}`,
        );
      }
    } catch (err) {
      this.logger.error(`country-block refresh failed: ${(err as Error).message}`);
    }
  }

  // =========================================================================
  // DNS sync — каждый час полный sync zones+records у всех ACTIVE/ERROR провайдеров.
  // ERROR пробуем тоже, чтобы транзиентные сбои сами восстанавливались.
  // UNAUTHORIZED не трогаем — токен надо пересоздавать руками, нет смысла бомбить API.
  //
  // Расчёт лимитов: для Y360 бесплатного тарифа лимит ~1000 запросов/сутки на орг.
  // 1 sync = 1 list domains + N×(list dns + ?) — для 1 домена + 30 записей это ~5
  // запросов. Час × 24 = 120 запросов/сутки на провайдера. Сильно в рамках.
  // =========================================================================
  @Cron('17 * * * *')
  async handleDnsSync() {
    try {
      const results = await this.dnsService.syncAllProvidersCron();
      const ok = results.filter((r) => r.ok).length;
      const fail = results.filter((r) => !r.ok).length;
      if (results.length) {
        this.logger.log(`DNS sync: ${ok}/${results.length} providers OK${fail ? `, ${fail} failed` : ''}`);
        for (const r of results) {
          if (!r.ok) this.logger.warn(`  ✗ provider ${r.accountId}: ${r.error}`);
        }
      }
    } catch (err) {
      this.logger.error(`DNS sync cron failed: ${(err as Error).message}`);
    }
  }

  // =========================================================================
  // Auth TTL Cleanup — очищает протухшие sessions/blacklist/login-attempts
  // (бывшая работа Redis TTL, теперь SQLite + cron каждые 10 минут)
  // =========================================================================
  @Cron('*/10 * * * *')
  async handleAuthCleanup() {
    try {
      const removed = await this.sessionService.cleanupExpired();
      if (removed.blacklist + removed.attempts + removed.sessions > 0) {
        this.logger.log(
          `Auth cleanup: blacklist=${removed.blacklist}, attempts=${removed.attempts}, sessions=${removed.sessions}`,
        );
      }
    } catch (err) {
      this.logger.error(`Auth cleanup failed: ${(err as Error).message}`);
    }
  }

  // =========================================================================
  // Metrics Snapshot — save every 60 seconds
  // =========================================================================
  @Cron(CronExpression.EVERY_MINUTE)
  async handleMetricsSnapshot() {
    try {
      await this.monitoringService.saveSnapshot();
    } catch (err) {
      this.logger.error(`Metrics snapshot failed: ${(err as Error).message}`);
    }
  }

  // =========================================================================
  // Metrics Cleanup — delete old snapshots daily at 4:00 AM
  // =========================================================================
  @Cron('0 4 * * *')
  async handleMetricsCleanup() {
    try {
      await this.monitoringService.cleanup();
    } catch (err) {
      this.logger.error(`Metrics cleanup failed: ${(err as Error).message}`);
    }

    // Cleanup health check pings older than 7 days
    try {
      const cutoff = new Date(Date.now() - HEALTH_PING_RETENTION_MS);
      await this.prisma.healthCheckPing.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
    } catch (err) {
      this.logger.error(`Health ping cleanup failed: ${(err as Error).message}`);
    }
  }

  // =========================================================================
  // Scheduled Backups — проверка каждую минуту.
  //
  // Два источника расписания:
  //   1) Per-site BackupConfig с cron schedule — как было.
  //   2) Глобальные настройки (`backup-defaults`) — применяются ко ВСЕМ сайтам,
  //      у которых нет per-site BackupConfig (или у которых он disabled).
  // =========================================================================
  @Cron(CronExpression.EVERY_MINUTE)
  async handleScheduledBackups() {
    const now = new Date();
    if (!this.agentRelay.isAgentConnected()) return;

    // --- 1. Per-site конфиги ---
    const configs = await this.prisma.backupConfig.findMany({
      where: {
        enabled: true,
        schedule: { not: null },
      },
      include: {
        site: {
          select: { id: true, name: true, userId: true },
        },
      },
    });

    const sitesCoveredByConfig = new Set<string>();

    for (const config of configs) {
      if (!config.schedule || !config.site) continue;
      sitesCoveredByConfig.add(config.siteId);
      if (!this.shouldRunNow(config.schedule, now)) continue;

      // Активный бэкап?
      const active = await this.prisma.backup.findFirst({
        where: {
          siteId: config.siteId,
          status: { in: ['PENDING', 'IN_PROGRESS'] },
        },
      });
      if (active) continue;

      try {
        await this.backupsService.triggerBackup(
          { siteId: config.siteId, configId: config.id },
          config.site.userId,
          'ADMIN',
        );
        this.logger.log(`Scheduled backup (per-site config) triggered for "${config.site.name}"`);
      } catch (err) {
        this.logger.error(
          `Scheduled backup failed for "${config.site.name}": ${(err as Error).message}`,
        );
      }
    }

    // --- 2. Глобальные дефолты (per-site сайты, не покрытые конфигом) ---
    // ВАЖНО: эти три условия НЕ должны быть `return` — иначе блоки 3 и 4
    // (server-path и panel-data) никогда не дойдут до выполнения, когда
    // глобальные дефолты не настроены. Раньше тут было `return` — баг.
    try {
      const defaults = await this.panelSettings.getBackupDefaults();
      const globalsActive =
        defaults.enabled &&
        defaults.schedule &&
        this.shouldRunNow(defaults.schedule, now) &&
        defaults.storageLocationIds.length > 0;

      if (globalsActive) {
        const sites = await this.prisma.site.findMany({
          where: {
            id: { notIn: Array.from(sitesCoveredByConfig) },
          },
          select: { id: true, name: true, userId: true },
        });

        for (const site of sites) {
          const active = await this.prisma.backup.findFirst({
            where: {
              siteId: site.id,
              status: { in: ['PENDING', 'IN_PROGRESS'] },
            },
          });
          if (active) continue;

          try {
            await this.backupsService.triggerBackup(
              { siteId: site.id }, // без configId → сервис возьмёт globals
              site.userId,
              'ADMIN',
            );
            this.logger.log(`Scheduled backup (global) triggered for "${site.name}"`);
          } catch (err) {
            this.logger.error(
              `Global scheduled backup failed for "${site.name}": ${(err as Error).message}`,
            );
          }
        }
      }
    } catch (err) {
      this.logger.error(`Global backup defaults check failed: ${(err as Error).message}`);
    }

    // --- 3. Server-path backup configs ---
    try {
      const serverPathConfigs = await this.prisma.serverPathBackupConfig.findMany({
        where: { enabled: true, schedule: { not: null } },
      });
      for (const config of serverPathConfigs) {
        if (!config.schedule) continue;
        if (!this.shouldRunNow(config.schedule, now)) continue;
        try {
          await this.serverPathBackupService.triggerBackup(config.id);
          this.logger.log(`Scheduled server-path backup triggered: "${config.name}" → ${config.path}`);
        } catch (err) {
          this.logger.error(`Server-path backup failed for "${config.name}": ${(err as Error).message}`);
        }
      }
    } catch (err) {
      this.logger.error(`Server-path scheduler failed: ${(err as Error).message}`);
    }

    // --- 4. Panel-data backup configs ---
    try {
      const panelDataConfigs = await this.prisma.panelDataBackupConfig.findMany({
        where: { enabled: true, schedule: { not: null } },
      });
      for (const config of panelDataConfigs) {
        if (!config.schedule) continue;
        if (!this.shouldRunNow(config.schedule, now)) continue;
        try {
          await this.panelDataBackupService.triggerBackup(config.id);
          this.logger.log(`Scheduled panel-data backup triggered: "${config.name}"`);
        } catch (err) {
          this.logger.error(`Panel-data backup failed for "${config.name}": ${(err as Error).message}`);
        }
      }
    } catch (err) {
      this.logger.error(`Panel-data scheduler failed: ${(err as Error).message}`);
    }
  }

  // =========================================================================
  // Scheduled Restic Check — verify repo integrity on schedule
  //
  // Запускается каждую минуту, но проверка делается только когда совпадает cron.
  // Throttle: на одну репу (siteId × locationId) — не чаще, чем раз в
  // `checkMinIntervalHours` часов. Это страховка от кривых cron'ов и от
  // параллельных запусков из UI.
  // =========================================================================
  @Cron(CronExpression.EVERY_MINUTE)
  async handleResticCheck() {
    if (!this.agentRelay.isAgentConnected()) return;

    const defaults = await this.panelSettings.getBackupDefaults();
    if (!defaults.checkEnabled || !defaults.checkSchedule) return;
    if (!this.shouldRunNow(defaults.checkSchedule, new Date())) return;

    const repos = await this.resticCheckService.listAllResticRepos();
    if (repos.length === 0) return;

    const minIntervalMs = Math.max(1, defaults.checkMinIntervalHours) * 60 * 60 * 1000;
    const now = Date.now();
    let launched = 0;

    for (const repo of repos) {
      const last = await this.resticCheckService.getLastCheck(repo.siteId, repo.locationId);
      if (last && now - last.startedAt.getTime() < minIntervalMs) {
        continue;
      }
      try {
        await this.resticCheckService.runCheckInternal({
          siteId: repo.siteId,
          siteName: repo.siteName,
          locationId: repo.locationId,
          options: {
            readData: !!defaults.checkReadData,
            readDataSubset: defaults.checkReadData ? (defaults.checkReadDataSubset || '10%') : undefined,
            source: 'scheduled',
          },
        });
        launched++;
      } catch (err) {
        this.logger.warn(
          `Scheduled restic check failed to start for ${repo.siteName} / ${repo.locationId}: ${(err as Error).message}`,
        );
      }
    }

    if (launched > 0) {
      this.logger.log(`Scheduled restic check: launched ${launched} repo check(s)`);
    }
  }

  // =========================================================================
  // Backup Cleanup — run daily at 3:00 AM
  // =========================================================================
  @Cron('0 3 * * *')
  async handleBackupCleanup() {
    try {
      await this.backupsService.cleanupOldBackups();
      this.logger.log('Backup cleanup completed');
    } catch (err) {
      this.logger.error(`Backup cleanup failed: ${(err as Error).message}`);
    }
  }

  // =========================================================================
  // SSL Expiration Check — run twice daily at 6:00 and 18:00
  // =========================================================================
  @Cron('0 6,18 * * *')
  async handleSslCheck() {
    try {
      // Update expiration status for all certs
      await this.sslService.checkExpirations();

      // Auto-renew expiring certs
      if (!this.agentRelay.isAgentConnected()) return;

      const expiring = await this.prisma.sslCertificate.findMany({
        where: {
          status: { in: [SslStatus.EXPIRING_SOON, SslStatus.EXPIRED] },
        },
        include: {
          site: { select: { id: true, domain: true, userId: true } },
        },
      });

      for (const cert of expiring) {
        if (!cert.site) continue;

        try {
          // Try to renew via certbot renew-all
          const result = await this.agentRelay.emitToAgent(
            'ssl:renew-all',
            {},
            180_000,
          );

          if (result.success) {
            this.logger.log(`SSL renewed for ${cert.site.domain}`);
            // Re-check expirations after renewal
            await this.sslService.checkExpirations();
          } else {
            this.logger.warn(
              `SSL renewal failed for ${cert.site.domain}: ${result.error}`,
            );
          }

          // Only run renew-all once (it renews all certs)
          break;
        } catch (err) {
          this.logger.error(
            `SSL renewal error: ${(err as Error).message}`,
          );
          break;
        }
      }
    } catch (err) {
      this.logger.error(`SSL check failed: ${(err as Error).message}`);
    }
  }

  // =========================================================================
  // Database Size Tracking — every 30 minutes
  // =========================================================================
  @Cron('*/30 * * * *')
  async handleDatabaseSizeTracking() {
    if (!this.agentRelay.isAgentConnected()) return;

    try {
      const databases = await this.prisma.database.findMany({
        select: { id: true, name: true, type: true },
      });

      for (const db of databases) {
        try {
          const result = await this.agentRelay.emitToAgent<{ sizeBytes: number }>('db:size', {
            name: db.name,
            type: db.type,
          });

          if (result.success && result.data?.sizeBytes !== undefined) {
            await this.prisma.database.update({
              where: { id: db.id },
              data: { sizeBytes: BigInt(result.data.sizeBytes) },
            });
          }
        } catch {
          // Skip individual failures silently
        }
      }

      this.logger.log(`Database sizes updated for ${databases.length} databases`);
    } catch (err) {
      this.logger.error(`Database size tracking failed: ${(err as Error).message}`);
    }
  }

  // =========================================================================
  // Site Health Check — every 5 minutes, check RUNNING sites are responding
  // =========================================================================
  @Cron('*/5 * * * *')
  async handleSiteHealthCheck() {
    if (!this.agentRelay.isAgentConnected()) return;

    try {
      // Check both RUNNING and ERROR sites (ERROR sites can recover)
      const sites = await this.prisma.site.findMany({
        where: { status: { in: [SiteStatus.RUNNING, SiteStatus.ERROR] } },
        select: { id: true, name: true, domain: true, type: true, appPort: true, status: true },
      });

      for (const site of sites) {
        try {
          const result = await this.agentRelay.emitToAgent<{
            reachable: boolean;
            statusCode: number | null;
            responseTimeMs: number;
          }>(
            'site:health-check',
            { domain: site.domain, port: site.appPort },
            10_000,
          );

          if (result.success && result.data) {
            // Save ping result
            await this.prisma.healthCheckPing.create({
              data: {
                siteId: site.id,
                reachable: result.data.reachable,
                statusCode: result.data.statusCode,
                responseTimeMs: result.data.responseTimeMs,
              },
            });

            // "Здоровый" ответ — TCP-коннект успешен И статус-код не 5xx.
            // 5xx значит, что nginx-то жив, но апстрим (FPM/Node/файлы) сломан —
            // это не "работает", а "ответил, что сломано". Без этой проверки
            // ERROR-сайты с пустым/снесённым артефактом флипались в RUNNING,
            // т.к. на их домен прилетал 502 от дефолтного/wildcard-сервера.
            const code = result.data.statusCode ?? 0;
            const healthy = result.data.reachable && code > 0 && code < 500;

            if (!healthy && site.status === SiteStatus.RUNNING) {
              // Site went down — update status and notify
              await this.prisma.site.update({
                where: { id: site.id },
                data: { status: SiteStatus.ERROR },
              });

              this.notifier.dispatch({
                event: 'SITE_DOWN',
                title: 'Site Down',
                message: `${site.domain} is not responding`,
                siteName: site.name,
                timestamp: new Date(),
              }).catch((err) => this.logger.error(`Notification failed: ${(err as Error).message}`));

              this.logger.warn(`Site "${site.name}" (${site.domain}) is down`);
            } else if (healthy && site.status === SiteStatus.ERROR) {
              // Site recovered — set back to RUNNING
              await this.prisma.site.update({
                where: { id: site.id },
                data: { status: SiteStatus.RUNNING, errorMessage: null },
              });

              this.logger.log(`Site "${site.name}" (${site.domain}) recovered`);
            }
          }
        } catch {
          // Agent failed to check — skip silently
        }
      }
    } catch (err) {
      this.logger.error(`Site health check failed: ${(err as Error).message}`);
    }
  }

  // =========================================================================
  // High Load Check — every 2 minutes, check system metrics against thresholds
  // =========================================================================
  @Cron('*/2 * * * *')
  async handleHighLoadCheck() {
    const metrics = this.monitoringService.getLatestMetrics();
    if (!metrics) return;

    const now = Date.now();
    if (now - this.lastHighLoadAlert < HIGH_LOAD_COOLDOWN_MS) return;

    const alerts: string[] = [];

    if (metrics.cpuPercent >= HIGH_LOAD_CPU_THRESHOLD) {
      alerts.push(`CPU at ${Math.round(metrics.cpuPercent)}%`);
    }
    if (metrics.memoryPercent >= HIGH_LOAD_MEM_THRESHOLD) {
      alerts.push(`Memory at ${Math.round(metrics.memoryPercent)}%`);
    }

    if (alerts.length > 0) {
      this.lastHighLoadAlert = now;

      this.notifier.dispatch({
        event: 'HIGH_LOAD',
        title: 'High Server Load',
        message: alerts.join(', '),
        timestamp: new Date(),
      }).catch((err) => this.logger.error(`Notification failed: ${(err as Error).message}`));

      this.logger.warn(`High load detected: ${alerts.join(', ')}`);
    }

    // Disk space alert (separate from CPU/memory with own cooldown)
    if (metrics.diskPercent >= DISK_ALERT_HIGH_THRESHOLD && now - this.lastDiskAlert >= HIGH_LOAD_COOLDOWN_MS) {
      this.lastDiskAlert = now;
      const diskTitle = metrics.diskPercent >= DISK_ALERT_CRITICAL_THRESHOLD ? 'Disk Almost Full' : 'Disk Usage High';

      this.notifier.dispatch({
        event: 'DISK_FULL',
        title: diskTitle,
        message: `Disk usage at ${Math.round(metrics.diskPercent)}%`,
        timestamp: new Date(),
      }).catch((err) => this.logger.error(`Notification failed: ${(err as Error).message}`));

      this.logger.warn(`Disk usage high: ${Math.round(metrics.diskPercent)}%`);
    }
  }

  // =========================================================================
  // Stuck Operations Watchdog — every 15 minutes
  // =========================================================================
  @Cron('*/15 * * * *')
  async handleStuckOperationsWatchdog() {
    // Stuck backups (4 hours — large backups can take a while)
    try {
      const backupCutoff = new Date(Date.now() - WATCHDOG_BACKUP_TIMEOUT_MS);
      const stuckBackups = await this.prisma.backup.findMany({
        where: {
          status: { in: [BackupStatus.PENDING, BackupStatus.IN_PROGRESS] },
          createdAt: { lt: backupCutoff },
        },
        select: { id: true },
      });

      if (stuckBackups.length > 0) {
        await this.prisma.backup.updateMany({
          where: { id: { in: stuckBackups.map((b) => b.id) } },
          data: {
            status: BackupStatus.FAILED,
            errorMessage: 'Операция зависла (превышен лимит 4 часа)',
            completedAt: new Date(),
          },
        });
        this.logger.warn(`Marked ${stuckBackups.length} stuck backup(s) as FAILED`);
      }
    } catch (err) {
      this.logger.error(`Stuck backup watchdog failed: ${(err as Error).message}`);
    }

    // Stuck deploys (1 hour)
    try {
      const deployCutoff = new Date(Date.now() - WATCHDOG_DEPLOY_TIMEOUT_MS);
      const stuckDeploys = await this.prisma.deployLog.findMany({
        where: {
          status: { in: [DeployStatus.PENDING, DeployStatus.IN_PROGRESS] },
          createdAt: { lt: deployCutoff },
        },
        select: { id: true, siteId: true },
      });

      if (stuckDeploys.length > 0) {
        await this.prisma.deployLog.updateMany({
          where: { id: { in: stuckDeploys.map((d) => d.id) } },
          data: {
            status: DeployStatus.FAILED,
            completedAt: new Date(),
          },
        });

        for (const d of stuckDeploys) {
          await this.prisma.site.updateMany({
            where: { id: d.siteId, status: SiteStatus.DEPLOYING },
            data: { status: SiteStatus.ERROR },
          });
        }

        this.logger.warn(`Marked ${stuckDeploys.length} stuck deploy(s) as FAILED`);
      }
    } catch (err) {
      this.logger.error(`Stuck deploy watchdog failed: ${(err as Error).message}`);
    }
  }

  // =========================================================================
  // Site Disk Snapshots — every 6 hours
  // =========================================================================
  @Cron('0 */6 * * *')
  async handleDiskSnapshots() {
    if (!this.agentRelay.isAgentConnected()) return;

    try {
      const sites = await this.prisma.site.findMany({
        select: {
          id: true,
          name: true,
          rootPath: true,
          filesRelPath: true,
          databases: { select: { sizeBytes: true } },
        },
      });

      for (const site of sites) {
        try {
          const res = await this.agentRelay.emitToAgent<{
            wwwBytes: number; logsBytes: number; tmpBytes: number; totalBytes: number;
          }>('site:storage', { rootPath: site.rootPath, filesRelPath: site.filesRelPath || undefined }, 30_000);

          if (res.success && res.data) {
            const dbBytes = site.databases.reduce(
              (sum, db) => sum + Number(db.sizeBytes), 0,
            );
            await this.prisma.siteDiskSnapshot.create({
              data: {
                siteId: site.id,
                wwwBytes: BigInt(res.data.wwwBytes),
                logsBytes: BigInt(res.data.logsBytes),
                tmpBytes: BigInt(res.data.tmpBytes),
                dbBytes: BigInt(dbBytes),
              },
            });
          }
        } catch {
          // Skip individual failures
        }
      }

      this.logger.log(`Disk snapshots saved for ${sites.length} sites`);

      // Cleanup snapshots older than 90 days
      const cutoff = new Date(Date.now() - DISK_SNAPSHOT_RETENTION_MS);
      await this.prisma.siteDiskSnapshot.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
    } catch (err) {
      this.logger.error(`Disk snapshots failed: ${(err as Error).message}`);
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  /**
   * Simple cron schedule matcher.
   * Supports standard 5-field cron: minute hour day month weekday
   * and common presets like @daily, @hourly, @weekly.
   */
  private shouldRunNow(schedule: string, now: Date): boolean {
    // Handle presets
    switch (schedule) {
      case '@hourly':
        return now.getMinutes() === 0;
      case '@daily':
        return now.getHours() === 0 && now.getMinutes() === 0;
      case '@weekly':
        return now.getDay() === 0 && now.getHours() === 0 && now.getMinutes() === 0;
      case '@monthly':
        return now.getDate() === 1 && now.getHours() === 0 && now.getMinutes() === 0;
    }

    // Parse 5-field cron
    const parts = schedule.trim().split(/\s+/);
    if (parts.length !== 5) return false;

    const [min, hour, day, month, weekday] = parts;

    return (
      this.matchField(min, now.getMinutes()) &&
      this.matchField(hour, now.getHours()) &&
      this.matchField(day, now.getDate()) &&
      this.matchField(month, now.getMonth() + 1) &&
      this.matchField(weekday, now.getDay())
    );
  }

  private matchField(field: string, value: number): boolean {
    if (field === '*') return true;

    // Handle step: */N
    if (field.startsWith('*/')) {
      const step = parseInt(field.substring(2), 10);
      return !isNaN(step) && step > 0 && value % step === 0;
    }

    // Handle range: A-B
    if (field.includes('-')) {
      const [start, end] = field.split('-').map(Number);
      return value >= start && value <= end;
    }

    // Handle list: A,B,C
    if (field.includes(',')) {
      return field.split(',').map(Number).includes(value);
    }

    // Exact match
    return parseInt(field, 10) === value;
  }
}
