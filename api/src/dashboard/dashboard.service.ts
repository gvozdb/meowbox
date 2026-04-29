import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { SessionService } from '../auth/session.service';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionService: SessionService,
  ) {}

  async getSummary(userId: string) {
    const [recentActivity, backups, ssl, services, security] =
      await Promise.all([
        this.getRecentActivity(),
        this.getBackupsSummary(),
        this.getSslSummary(),
        this.getServicesStatus(),
        this.getSecurityStats(userId),
      ]);

    return { recentActivity, backups, ssl, services, security };
  }

  private async getRecentActivity() {
    const logs = await this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 7,
      include: {
        user: { select: { id: true, username: true } },
      },
    });

    return logs.map((l) => ({
      id: l.id,
      action: l.action,
      entity: l.entity,
      entityId: l.entityId,
      ipAddress: l.ipAddress,
      createdAt: l.createdAt.toISOString(),
      username: l.user?.username || 'system',
    }));
  }

  private async getBackupsSummary() {
    const sites = await this.prisma.site.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    const lastBackups = await Promise.all(
      sites.map(async (site) => {
        const backup = await this.prisma.backup.findFirst({
          where: { siteId: site.id },
          orderBy: { createdAt: 'desc' },
          select: {
            status: true,
            completedAt: true,
            sizeBytes: true,
            createdAt: true,
          },
        });

        return {
          siteId: site.id,
          siteName: site.name,
          lastBackup: backup
            ? {
                status: backup.status,
                completedAt: (backup.completedAt || backup.createdAt).toISOString(),
                sizeBytes: backup.sizeBytes ? Number(backup.sizeBytes) : null,
              }
            : null,
        };
      }),
    );

    return lastBackups;
  }

  private async getSslSummary() {
    const certs = await this.prisma.sslCertificate.findMany({
      where: { status: { not: 'NONE' } },
      select: {
        siteId: true,
        domains: true,
        status: true,
        issuer: true,
        expiresAt: true,
        daysRemaining: true,
        site: { select: { name: true, domain: true } },
      },
    });

    return certs.map((c) => ({
      siteId: c.siteId,
      siteName: c.site.name,
      domain: c.site.domain,
      issuer: c.issuer,
      status: c.status,
      expiresAt: c.expiresAt?.toISOString() || null,
      daysRemaining: c.daysRemaining,
    }));
  }

  private async getServicesStatus() {
    // Набор сервисов собираем динамически:
    //   1) nginx / mariadb / postgresql — стандартные, есть или нет.
    //   2) phpX.Y-fpm — сколько реально установлено (php-list-installed),
    //      ранее был хардкод php8.3-fpm, что ломалось на серверах без 8.3.
    const phpServices = await this.detectInstalledPhpFpm();
    const serviceNames = ['nginx', ...phpServices, 'mariadb', 'postgresql'];

    const results = await Promise.all(
      serviceNames.map(async (name) => {
        try {
          const { stdout } = await execFileAsync('systemctl', [
            'is-active',
            name,
          ]);
          return { name: this.friendlyServiceName(name), active: stdout.trim() === 'active' };
        } catch {
          return { name: this.friendlyServiceName(name), active: false };
        }
      }),
    );

    return results;
  }

  /**
   * Возвращает список реально установленных php-fpm сервисов. Смотрим
   * /lib/systemd/system и /etc/systemd/system на unit-файлы phpX.Y-fpm.service.
   * Без запуска shell — чистый fs.readdir. Кешируется на время процесса,
   * переустановка PHP — редкость.
   */
  private phpFpmServicesCache: string[] | null = null;
  private async detectInstalledPhpFpm(): Promise<string[]> {
    if (this.phpFpmServicesCache) return this.phpFpmServicesCache;
    const fs = await import('fs/promises');
    const dirs = ['/lib/systemd/system', '/etc/systemd/system'];
    const found = new Set<string>();
    for (const dir of dirs) {
      try {
        const entries = await fs.readdir(dir);
        for (const f of entries) {
          const m = /^(php\d(?:\.\d)?-fpm)\.service$/.exec(f);
          if (m) found.add(m[1]);
        }
      } catch {
        // Каталога может не быть (разные дистрибутивы), молча пропускаем.
      }
    }
    this.phpFpmServicesCache = Array.from(found).sort();
    return this.phpFpmServicesCache;
  }

  private friendlyServiceName(name: string): string {
    // Статический маппинг для фиксированного набора; php-fpm динамический.
    const map: Record<string, string> = {
      nginx: 'Nginx',
      mariadb: 'MariaDB',
      postgresql: 'PostgreSQL',
    };
    if (map[name]) return map[name];
    // phpX.Y-fpm → PHP-FPM X.Y
    const m = /^php(\d(?:\.\d)?)-fpm$/.exec(name);
    if (m) return `PHP-FPM ${m[1]}`;
    return name;
  }

  private async getSecurityStats(userId: string) {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [failedLogins24h, lastLogin, sessions] = await Promise.all([
      this.prisma.auditLog.count({
        where: {
          action: 'LOGIN',
          entity: 'auth',
          // details хранится как JSON-строка в SQLite: ищем подстроку `"success":false`
          details: { contains: '"success":false' },
          createdAt: { gte: oneDayAgo },
        },
      }).catch(() => 0),
      this.prisma.auditLog.findFirst({
        where: { action: 'LOGIN', userId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      this.sessionService.getUserSessions(userId),
    ]);

    return {
      failedLogins24h,
      activeSessions: sessions.length,
      lastLoginAt: lastLogin?.createdAt.toISOString() || null,
    };
  }
}
