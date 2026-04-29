import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { hashPassword, verifyPassword } from '../common/crypto/argon2.helper';

/**
 * Сингл-стоп конфиг Basic Auth (защита входа в панель).
 * Таблица basic_auth_config всегда имеет 0 или 1 запись (id = '_').
 *
 * Использование:
 *   - `getConfig()` — читает состояние (для UI и для Nuxt-middleware).
 *   - `verify(user, pass)` — constant-time проверка.
 *   - `enable(user, pass)` / `disable()` — управление с UI (требует ADMIN).
 */
@Injectable()
export class BasicAuthService {
  private readonly logger = new Logger('BasicAuthService');
  private readonly SINGLETON_ID = '_';

  constructor(private readonly prisma: PrismaService) {}

  async getConfig(): Promise<{ enabled: boolean; username: string }> {
    const row = await this.prisma.basicAuthConfig.findUnique({
      where: { id: this.SINGLETON_ID },
    });
    if (!row) return { enabled: false, username: '' };
    return { enabled: row.enabled, username: row.username };
  }

  /** Публичная часть: то же что getConfig + хэш (только для внутреннего использования Nuxt-middleware). */
  async getFullConfig(): Promise<{ enabled: boolean; username: string; passwordHash: string }> {
    const row = await this.prisma.basicAuthConfig.findUnique({
      where: { id: this.SINGLETON_ID },
    });
    if (!row) return { enabled: false, username: '', passwordHash: '' };
    return { enabled: row.enabled, username: row.username, passwordHash: row.passwordHash };
  }

  async enable(username: string, password: string): Promise<void> {
    if (!username || username.length < 3) {
      throw new Error('Username must be at least 3 characters');
    }
    if (!password || password.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }

    const passwordHash = await hashPassword(password);

    await this.prisma.basicAuthConfig.upsert({
      where: { id: this.SINGLETON_ID },
      create: { id: this.SINGLETON_ID, enabled: true, username, passwordHash },
      update: { enabled: true, username, passwordHash },
    });
    this.logger.log(`Basic Auth enabled for user ${username}`);
  }

  async disable(): Promise<void> {
    await this.prisma.basicAuthConfig.upsert({
      where: { id: this.SINGLETON_ID },
      create: { id: this.SINGLETON_ID, enabled: false, username: '', passwordHash: '' },
      update: { enabled: false },
    });
    this.logger.log('Basic Auth disabled');
  }

  /** Constant-time проверка Basic Auth header. */
  async verify(username: string, password: string): Promise<boolean> {
    const cfg = await this.getFullConfig();
    if (!cfg.enabled || !cfg.passwordHash) return false;
    if (cfg.username !== username) {
      // Чтобы не давать тайминг-атаку — всё равно прогоняем verify со случайным хэшем.
      try {
        await verifyPassword('$argon2id$v=19$m=65536,t=3,p=4$dummy$dummy', password);
      } catch { /* ignore */ }
      return false;
    }
    try {
      return await verifyPassword(cfg.passwordHash, password);
    } catch {
      return false;
    }
  }
}
