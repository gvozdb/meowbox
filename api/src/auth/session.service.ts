import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

/**
 * Хранилище auth-метаданных на SQLite — заменяет прежний RedisService.
 *
 * Содержит три набора данных:
 *   1. TokenBlacklist — отозванные refresh-токены по jti
 *   2. LoginAttempt   — счётчики brute-force по IP
 *   3. Session        — активные refresh-токены (IP-binding + список сессий в UI)
 *
 * TTL реализован через поле `expiresAt`. Записи с прошлым `expiresAt` считаются
 * устаревшими и игнорируются при чтении. Физическая чистка — см. AuthCleanupService.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ===========================================================================
  // Refresh token blacklist
  // ===========================================================================

  async blacklistToken(jti: string, ttlSeconds: number): Promise<void> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await this.prisma.tokenBlacklist.upsert({
      where: { jti },
      create: { jti, expiresAt },
      update: { expiresAt },
    });
  }

  async isTokenBlacklisted(jti: string): Promise<boolean> {
    const row = await this.prisma.tokenBlacklist.findUnique({ where: { jti } });
    if (!row) return false;
    if (row.expiresAt.getTime() <= Date.now()) {
      // Просрочено — считаем что уже отозвана; не пересоздаём
      return false;
    }
    return true;
  }

  /**
   * Проверяет, был ли токен отозван недавно — в пределах `windowMs`.
   * Используется для grace-периода при конкурентном refresh: несколько
   * вкладок одновременно пытаются обновить один и тот же refresh-токен,
   * первая ротирует (blacklist + новый jti), остальные приходят со «старым»,
   * уже blacklisted — но это НЕ атака, а гонка. В таком случае возвращаем
   * true → и вызывающий код выдаёт новые токены вместо 403.
   */
  async wasBlacklistedRecently(jti: string, windowMs: number): Promise<boolean> {
    const row = await this.prisma.tokenBlacklist.findUnique({ where: { jti } });
    if (!row) return false;
    return row.createdAt.getTime() > Date.now() - windowMs;
  }

  /**
   * Удаляет дубликат-сессии того же юзера с того же IP+UA.
   * Вызывается при создании новой сессии (логин или refresh), чтобы в UI
   * не плодились «куча открытых сессий» после каждой ротации/передеплоя.
   * Возвращает список удалённых jti — их же надо занести в blacklist, чтобы
   * старые refresh-токены, ещё живущие в localStorage у пользователя, не
   * дали второй логин в обход.
   */
  async dedupeSessions(
    userId: string,
    ip: string,
    userAgent: string,
    exceptJti: string,
  ): Promise<string[]> {
    const ua = userAgent || '';
    const rows = await this.prisma.session.findMany({
      where: {
        userId,
        ip,
        userAgent: ua,
        jti: { not: exceptJti },
      },
      select: { jti: true },
    });
    if (!rows.length) return [];
    const jtis = rows.map((r) => r.jti);
    await this.prisma.session.deleteMany({ where: { jti: { in: jtis } } });
    return jtis;
  }

  // ===========================================================================
  // Login attempts (brute-force protection, 15-минутное окно)
  // ===========================================================================

  private static readonly LOGIN_WINDOW_SECONDS = 15 * 60;

  async incrementLoginAttempts(ip: string): Promise<number> {
    // Атомарно: read+upsert в одной транзакции, иначе параллельные login'ы
    // оба попадают в ветку "новая запись" и оба сбрасывают count=1 → bypass
    // brute-force защиты. SQLite сериализует write-транзакции на уровне БД.
    const now = new Date();
    const newExpiresAt = new Date(now.getTime() + SessionService.LOGIN_WINDOW_SECONDS * 1000);

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.loginAttempt.findUnique({ where: { ip } });
      if (!existing || existing.expiresAt.getTime() <= now.getTime()) {
        await tx.loginAttempt.upsert({
          where: { ip },
          create: { ip, count: 1, expiresAt: newExpiresAt },
          update: { count: 1, expiresAt: newExpiresAt },
        });
        return 1;
      }
      const updated = await tx.loginAttempt.update({
        where: { ip },
        data: { count: { increment: 1 } },
      });
      return updated.count;
    });
  }

  async getLoginAttempts(ip: string): Promise<number> {
    const row = await this.prisma.loginAttempt.findUnique({ where: { ip } });
    if (!row) return 0;
    if (row.expiresAt.getTime() <= Date.now()) return 0;
    return row.count;
  }

  async resetLoginAttempts(ip: string): Promise<void> {
    await this.prisma.loginAttempt.deleteMany({ where: { ip } });
  }

  // ===========================================================================
  // Per-username lockout (защита от distributed brute-force)
  //
  // Per-IP лимита недостаточно: botnet рассылает пару (admin, 1..N) с тысяч
  // разных IP — каждый отдельный IP попадает в лимит 10/15m, но для username
  // уже миллион попыток. Поэтому параллельно трекаем попытки по username,
  // делим лимит и гасим спрэй.
  //
  // Реализация хранится в той же таблице LoginAttempt, ключом служит строка
  // `u:${username}` — она уникальна и не пересекается с реальными IP.
  // ===========================================================================

  private usernameKey(username: string): string {
    return `u:${String(username).toLowerCase().slice(0, 64)}`;
  }

  async incrementUsernameAttempts(username: string): Promise<number> {
    return this.incrementLoginAttempts(this.usernameKey(username));
  }

  async getUsernameAttempts(username: string): Promise<number> {
    return this.getLoginAttempts(this.usernameKey(username));
  }

  async resetUsernameAttempts(username: string): Promise<void> {
    await this.resetLoginAttempts(this.usernameKey(username));
  }

  // ===========================================================================
  // Refresh token metadata + sessions (единый ресурс — Session)
  // ===========================================================================

  async addSession(
    jti: string,
    userId: string,
    ip: string,
    userAgent: string,
    ttlSeconds: number,
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await this.prisma.session.upsert({
      where: { jti },
      create: { jti, userId, ip, userAgent, expiresAt },
      update: { ip, userAgent, expiresAt },
    });
  }

  async getSessionMeta(
    jti: string,
  ): Promise<{ userId: string; ip: string } | null> {
    const s = await this.prisma.session.findUnique({ where: { jti } });
    if (!s) return null;
    if (s.expiresAt.getTime() <= Date.now()) return null;
    return { userId: s.userId, ip: s.ip };
  }

  async removeSession(jti: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { jti } });
  }

  async getUserSessions(
    userId: string,
  ): Promise<
    Array<{ jti: string; ip: string; userAgent: string; createdAt: string }>
  > {
    const rows = await this.prisma.session.findMany({
      where: {
        userId,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    // Исключаем blacklisted
    const result: Array<{ jti: string; ip: string; userAgent: string; createdAt: string }> = [];
    for (const s of rows) {
      const blk = await this.prisma.tokenBlacklist.findUnique({ where: { jti: s.jti } });
      if (blk && blk.expiresAt.getTime() > Date.now()) continue;
      result.push({
        jti: s.jti,
        ip: s.ip,
        userAgent: s.userAgent ?? '',
        createdAt: s.createdAt.toISOString(),
      });
    }
    return result;
  }

  /** Удаляет все сессии пользователя кроме exceptJti. Возвращает список удалённых jti. */
  async removeAllUserSessions(userId: string, exceptJti?: string): Promise<string[]> {
    const rows = await this.prisma.session.findMany({
      where: {
        userId,
        ...(exceptJti ? { jti: { not: exceptJti } } : {}),
      },
      select: { jti: true },
    });
    const jtis = rows.map((r) => r.jti);
    if (jtis.length > 0) {
      await this.prisma.session.deleteMany({ where: { jti: { in: jtis } } });
    }
    return jtis;
  }

  // ===========================================================================
  // Cleanup of expired rows (вызывается из cron)
  // ===========================================================================

  async cleanupExpired(): Promise<{ blacklist: number; attempts: number; sessions: number }> {
    const now = new Date();
    const [bl, at, ss] = await Promise.all([
      this.prisma.tokenBlacklist.deleteMany({ where: { expiresAt: { lte: now } } }),
      this.prisma.loginAttempt.deleteMany({ where: { expiresAt: { lte: now } } }),
      this.prisma.session.deleteMany({ where: { expiresAt: { lte: now } } }),
    ]);
    return { blacklist: bl.count, attempts: at.count, sessions: ss.count };
  }
}
