import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../common/prisma.service';

/**
 * Журнал прокси-операций (вход и выход).
 *
 *   direction=OUT — master отправил запрос на slave (запись на master-стороне).
 *   direction=IN  — slave получил запрос от чужой панели (запись на slave-стороне).
 *
 * Лог выживает удаление сервера: serverName/serverId хранятся как snapshot,
 * без FK. Для compliance/forensics — никогда не удаляем строки автоматически
 * (можно почистить через cron, но не сейчас).
 */
@Injectable()
export class ProxyAuditService {
  private readonly logger = new Logger(ProxyAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async logOut(params: {
    userId: string | null;
    serverId: string;
    serverName: string;
    method: string;
    path: string;
    statusCode: number | null;
    durationMs: number;
    ipAddress: string;
    userAgent?: string | null;
    errorMsg?: string | null;
  }): Promise<void> {
    try {
      await this.prisma.proxyAuditLog.create({
        data: {
          direction: 'OUT',
          userId: params.userId,
          serverId: params.serverId,
          serverName: params.serverName,
          method: params.method,
          path: params.path,
          statusCode: params.statusCode,
          durationMs: params.durationMs,
          ipAddress: params.ipAddress,
          userAgent: params.userAgent ?? null,
          errorMsg: params.errorMsg ?? null,
        },
      });
    } catch (err) {
      // Аудит-фейл не должен ронять прокси-запрос. Только лог.
      this.logger.warn(`Audit OUT write failed: ${(err as Error).message}`);
    }
  }

  async logIn(params: {
    method: string;
    path: string;
    statusCode: number | null;
    durationMs: number;
    ipAddress: string;
    userAgent?: string | null;
    errorMsg?: string | null;
  }): Promise<void> {
    try {
      await this.prisma.proxyAuditLog.create({
        data: {
          direction: 'IN',
          userId: null,
          serverId: null,
          serverName: null,
          method: params.method,
          path: params.path,
          statusCode: params.statusCode,
          durationMs: params.durationMs,
          ipAddress: params.ipAddress,
          userAgent: params.userAgent ?? null,
          errorMsg: params.errorMsg ?? null,
        },
      });
    } catch (err) {
      this.logger.warn(`Audit IN write failed: ${(err as Error).message}`);
    }
  }

  /**
   * Последние N записей (для UI на /servers, вкладка "audit").
   * Можно фильтровать по serverId.
   */
  async listRecent(opts: { serverId?: string; direction?: 'OUT' | 'IN'; limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    return this.prisma.proxyAuditLog.findMany({
      where: {
        ...(opts.serverId ? { serverId: opts.serverId } : {}),
        ...(opts.direction ? { direction: opts.direction } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
