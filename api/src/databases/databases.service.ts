import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  InternalServerErrorException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { DatabaseType } from '../common/enums';
import { randomBytes } from 'crypto';
import { hashPassword } from '../common/crypto/argon2.helper';
import { encryptJson, decryptJson } from '../common/crypto/credentials-cipher';
import { encryptToken } from '../common/crypto/adminer-cipher';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { CreateDatabaseDto, UpdateDatabaseDto } from './databases.dto';

interface DbListOptions {
  userId: string;
  role: string;
  type?: string;
  search?: string;
  siteId?: string;
  page?: number;
  perPage?: number;
}

@Injectable()
export class DatabasesService {
  private readonly logger = new Logger('DatabasesService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
  ) {}

  async findAll(options: DbListOptions) {
    const { userId, role, type, search, siteId, page = 1, perPage = 20 } = options;
    const take = Math.min(perPage, 100);
    const skip = (page - 1) * take;

    const where: Record<string, unknown> = {};

    if (role !== 'ADMIN') {
      where.site = { userId };
    }
    if (siteId) where.siteId = siteId;
    if (type) {
      // Поддерживаем CSV ('MARIADB,MYSQL') — нужно UI-фильтру «MySQL / MariaDB»,
      // объединяющему оба исторических типа в один пункт.
      const types = type.split(',').map((s) => s.trim()).filter(Boolean);
      if (types.length === 1) where.type = types[0];
      else if (types.length > 1) where.type = { in: types };
    }
    if (search) {
      where.name = { contains: search };
    }

    const [databases, total] = await Promise.all([
      this.prisma.database.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        include: {
          site: { select: { id: true, name: true, domain: true } },
        },
      }),
      this.prisma.database.count({ where }),
    ]);

    return {
      databases,
      meta: { page, perPage: take, total, totalPages: Math.ceil(total / take) },
    };
  }

  async findById(id: string, userId: string, role: string) {
    const db = await this.prisma.database.findUnique({
      where: { id },
      include: {
        site: { select: { id: true, name: true, domain: true, userId: true } },
      },
    });

    if (!db) throw new NotFoundException('Database not found');
    if (role !== 'ADMIN' && db.site?.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    return db;
  }

  async create(dto: CreateDatabaseDto, userId: string) {
    // Check uniqueness
    const existing = await this.prisma.database.findUnique({
      where: { name: dto.name },
    });
    if (existing) {
      throw new ConflictException(`Database "${dto.name}" already exists`);
    }

    // Движок должен быть установлен на сервере. ServerService — синхронизированный
    // снимок (пишется при заходе на /services и при install/uninstall).
    await this.assertEngineInstalled(dto.type);

    // Generate credentials
    const dbUser = dto.dbUser || `u_${dto.name}`.substring(0, 32);
    const plainPassword = randomBytes(16).toString('base64url');
    const passwordHash = await hashPassword(plainPassword);
    const passwordEnc = encryptJson({ password: plainPassword });

    const database = await this.prisma.database.create({
      data: {
        name: dto.name,
        type: dto.type as DatabaseType,
        dbUser,
        dbPasswordHash: passwordHash,
        dbPasswordEnc: passwordEnc,
        siteId: dto.siteId || null,
      },
    });

    // =========================================================================
    // Agent: create actual database on the server
    // =========================================================================
    try {
      const result = await this.agentRelay.emitToAgent('db:create', {
        name: dto.name,
        type: dto.type,
        dbUser,
        password: plainPassword,
      });

      if (!result.success) {
        // Rollback DB record
        await this.prisma.database.delete({ where: { id: database.id } });
        throw new Error(result.error || 'Database creation failed on server');
      }

      this.logger.log(`Database "${dto.name}" (${dto.type}) created on server`);
    } catch (err) {
      if ((err as Error).name === 'AgentUnavailableError') {
        await this.prisma.database.delete({ where: { id: database.id } });
        throw new InternalServerErrorException('Agent is not connected');
      }
      if (!(err instanceof InternalServerErrorException)) {
        throw new InternalServerErrorException((err as Error).message);
      }
      throw err;
    }

    return {
      ...database,
      plainPassword,
    };
  }

  async update(id: string, dto: UpdateDatabaseDto, userId: string, role: string) {
    await this.findById(id, userId, role);

    return this.prisma.database.update({
      where: { id },
      data: {
        ...(dto.siteId !== undefined && { siteId: dto.siteId || null }),
      },
    });
  }

  async delete(id: string, userId: string, role: string) {
    const db = await this.findById(id, userId, role);

    // Agent: drop actual database on the server
    if (this.agentRelay.isAgentConnected()) {
      try {
        const result = await this.agentRelay.emitToAgent('db:drop', {
          name: db.name,
          type: db.type,
          dbUser: db.dbUser,
        });

        if (!result.success) {
          this.logger.warn(`Failed to drop DB "${db.name}": ${result.error}`);
        } else {
          this.logger.log(`Database "${db.name}" dropped on server`);
        }
      } catch (err) {
        this.logger.error(`DB drop error: ${(err as Error).message}`);
      }
    }

    await this.prisma.database.delete({ where: { id } });
  }

  async exportDatabase(id: string, userId: string, role: string) {
    const db = await this.findById(id, userId, role);

    const result = await this.agentRelay.emitToAgent<{ filePath: string }>('db:export', {
      name: db.name,
      type: db.type,
    }, 600_000);

    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Export failed');
    }

    return { filePath: result.data?.filePath };
  }

  async importDatabase(id: string, userId: string, role: string, filePath: string) {
    const db = await this.findById(id, userId, role);

    const result = await this.agentRelay.emitToAgent('db:import', {
      name: db.name,
      type: db.type,
      filePath,
    }, 600_000);

    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Import failed');
    }

    return { success: true };
  }

  async resetPassword(id: string, userId: string, role: string) {
    const db = await this.findById(id, userId, role);

    const plainPassword = randomBytes(16).toString('base64url');
    const passwordHash = await hashPassword(plainPassword);
    const passwordEnc = encryptJson({ password: plainPassword });

    // Применяем пароль к реальной БД на сервере (через агента) — иначе мы
    // обновим только запись в meowbox.db, а MariaDB/Postgres продолжит
    // принимать старый пароль, и Adminer будет коннектиться с новым → 1045.
    if (this.agentRelay.isAgentConnected()) {
      const result = await this.agentRelay.emitToAgent('db:reset-password', {
        name: db.name,
        type: db.type,
        dbUser: db.dbUser,
        password: plainPassword,
      });
      if (!result.success) {
        throw new InternalServerErrorException(
          result.error || 'Не удалось обновить пароль БД на сервере',
        );
      }
    } else {
      throw new InternalServerErrorException('Agent is not connected');
    }

    await this.prisma.database.update({
      where: { id },
      data: { dbPasswordHash: passwordHash, dbPasswordEnc: passwordEnc },
    });

    return { plainPassword };
  }

  // ===========================================================================
  // Adminer SSO
  // ===========================================================================

  /**
   * Проверка, что движок БД, нужный под выбранный тип, установлен на сервере.
   * Источник правды — таблица ServerService.
   *
   * Маппинг:
   *   MARIADB | MYSQL  → 'mariadb'    (один пакет mariadb-server обслуживает оба)
   *   POSTGRESQL       → 'postgresql'
   *
   * Если запись ServerService отсутствует или installed=false — кидаем 409 с UI-понятным сообщением.
   */
  private async assertEngineInstalled(type: string): Promise<void> {
    const requiredKey =
      type === 'POSTGRESQL' ? 'postgresql'
      : (type === 'MARIADB' || type === 'MYSQL') ? 'mariadb'
      : null;

    if (!requiredKey) {
      throw new BadRequestException(`Неизвестный тип БД: ${type}`);
    }

    const rec = await this.prisma.serverService.findUnique({
      where: { serviceKey: requiredKey },
      select: { installed: true },
    });
    if (!rec?.installed) {
      const niceName = requiredKey === 'mariadb' ? 'MariaDB / MySQL' : 'PostgreSQL';
      throw new ConflictException(
        `${niceName} не установлен на сервере. Установи его на странице /services.`,
      );
    }
  }

  /**
   * Возвращает плейн-пароль БД, расшифровывая `dbPasswordEnc`.
   * Бросает 400, если пароль не сохранён в зашифрованном виде (legacy-запись).
   */
  private getPlainPassword(db: { dbPasswordEnc: string | null; name: string }): string {
    if (!db.dbPasswordEnc) {
      throw new BadRequestException(
        `У базы "${db.name}" пароль не сохранён в зашифрованном виде. ` +
          `Сделай ресет пароля БД, чтобы открыть её в Adminer ` +
          `(внимание: после ресета нужно обновить connection-строку в коде сайта).`,
      );
    }
    try {
      const obj = decryptJson<{ password: string }>(db.dbPasswordEnc);
      if (!obj?.password) throw new Error('empty password');
      return obj.password;
    } catch (e) {
      this.logger.error(`Failed to decrypt password for db "${db.name}": ${(e as Error).message}`);
      throw new InternalServerErrorException(
        `Не удалось расшифровать пароль БД "${db.name}". Возможно, master-key изменился. ` +
          `Сделай ресет пароля БД.`,
      );
    }
  }

  /**
   * Возвращает короткоживущий ticket для входа в Adminer без ввода данных.
   * Ticket — AES-256-GCM зашифрованный JSON, валидируется PHP-плагином.
   *
   * Безопасность:
   *   - TTL 60 секунд (одноразовый short-lived токен).
   *   - В query-строке. На SSO-эндпоинте PHP сразу обменивает на HttpOnly cookie
   *     и редиректит на чистый URL — пароль в браузере истории не остаётся.
   *   - Доступ проверяется ровно так же, как у любых других databases-эндпоинтов
   *     (роль + ownership через findById).
   */
  async createAdminerTicket(id: string, userId: string, role: string): Promise<{ url: string }> {
    const db = await this.findById(id, userId, role);
    const password = this.getPlainPassword(db);

    const driverByType: Record<string, string> = {
      MARIADB: 'server',
      MYSQL: 'server',
      POSTGRESQL: 'pgsql',
    };
    const portByType: Record<string, number> = {
      MARIADB: 3306,
      MYSQL: 3306,
      POSTGRESQL: 5432,
    };
    const driver = driverByType[db.type];
    if (!driver) {
      throw new BadRequestException(`Adminer не поддерживает тип БД ${db.type}`);
    }

    const now = Math.floor(Date.now() / 1000);
    const ticket = encryptToken({
      v: 1,
      kind: 'sso',
      dbId: db.id,
      driver,
      host: '127.0.0.1',
      port: portByType[db.type],
      user: db.dbUser,
      pass: password,
      database: db.name,
      uid: userId,
      iat: now,
      exp: now + 60,
    });

    return { url: `/adminer/sso.php?ticket=${ticket}` };
  }

  async importUpload(id: string, userId: string, role: string, file: Express.Multer.File) {
    const db = await this.findById(id, userId, role);

    // Save uploaded file to a temp location. `file.originalname` — клиентский,
    // санируем до basename + только безопасные символы, иначе `../etc/evil.sql`
    // попадёт в путь (теоретически не выходит за mkdtemp, но defense in depth).
    const safeName = path
      .basename(String(file.originalname || 'import.sql'))
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 128) || 'import.sql';
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meowbox-dbimport-'));
    const tmpFile = path.join(tmpDir, safeName);

    try {
      await fs.writeFile(tmpFile, file.buffer);

      const result = await this.agentRelay.emitToAgent('db:import', {
        name: db.name,
        type: db.type,
        filePath: tmpFile,
      }, 600_000);

      if (!result.success) {
        throw new InternalServerErrorException(result.error || 'Import failed');
      }

      return { success: true };
    } finally {
      // Cleanup temp file
      try { await fs.rm(tmpDir, { recursive: true }); } catch { /* ignore */ }
    }
  }
}
