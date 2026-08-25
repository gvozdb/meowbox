import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  InternalServerErrorException,
  BadRequestException,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { DatabaseType } from '../common/enums';
import { randomBytes } from 'crypto';
import { hashPassword } from '../common/crypto/argon2.helper';
import { encryptJson, decryptJson } from '../common/crypto/credentials-cipher';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { CreateDatabaseDto, UpdateDatabaseDto } from './databases.dto';
import { DomainContextService } from '../sites/domain-context.service';
import { OperationsService } from '../operations/operations.service';
import { AdminerHandoffService } from '../adminer/adminer-handoff.service';
import { getDatabaseExportsDir } from './database-paths';

/**
 * Где агент создаёт ручные дампы БД для скачивания (db:export → /var/meowbox/exports/...).
 * Должен совпадать с DB_EXPORTS_DIR в agent/src/config.ts (default `/var/meowbox/exports`).
 */
/**
 * TTL для забытых файлов экспорта. Если юзер нажал «Экспорт», но не скачал
 * (или скачивание оборвалось), файл должен сам уехать в /dev/null через сутки.
 */
const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;
const EXPORT_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface DbListOptions {
  siteId: string;
  domainId: string;
  userId: string;
  role: string;
  type?: string;
  search?: string;
  page?: number;
  perPage?: number;
}

interface GlobalDbListOptions {
  userId: string;
  role: string;
  type?: string;
  search?: string;
  page?: number;
  perPage?: number;
}

@Injectable()
export class DatabasesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('DatabasesService');
  private exportCleanupTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
    private readonly domainContext: DomainContextService,
    private readonly operations: OperationsService,
    private readonly adminerHandoffs: AdminerHandoffService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Стартовый прогон + периодический таймер. Если на диске лежат старые
    // дампы (например, после перезапуска API между export → download) —
    // они уедут в /dev/null. Дальше — каждые 6 часов.
    void this.cleanupStaleExports();
    this.exportCleanupTimer = setInterval(
      () => void this.cleanupStaleExports(),
      EXPORT_CLEANUP_INTERVAL_MS,
    );
    // Не блокируем shutdown процесса.
    this.exportCleanupTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.exportCleanupTimer) clearInterval(this.exportCleanupTimer);
  }

  private listPagination(page = 1, perPage = 20) {
    const safePage = Number.isInteger(page) && page > 0 ? page : 1;
    const take = Number.isInteger(perPage)
      ? Math.min(Math.max(perPage, 1), 100)
      : 20;
    return { page: safePage, take, skip: (safePage - 1) * take };
  }

  private buildListWhere(options: {
    type?: string;
    search?: string;
    siteDomainId?: string;
    ownerUserId?: string;
  }): Record<string, unknown> {
    const where: Record<string, unknown> = {};
    if (options.siteDomainId) where.siteDomainId = options.siteDomainId;
    if (options.ownerUserId) where.site = { userId: options.ownerUserId };
    if (options.type) {
      const types = options.type.split(',').map((value) => value.trim()).filter(Boolean);
      if (types.length === 1) where.type = types[0];
      else if (types.length > 1) where.type = { in: types };
    }
    if (options.search) where.name = { contains: options.search };
    return where;
  }

  /**
   * Удаляет .sql/.gz/etc файлы старше EXPORT_TTL_MS из DB_EXPORTS_DIR.
   * Идемпотентно. Не падает, если папки нет (агент мог ещё не создать).
   */
  private async cleanupStaleExports(): Promise<void> {
    const exportsDir = getDatabaseExportsDir();
    try {
      const entries = await fs.readdir(exportsDir).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return [] as string[];
        throw err;
      });
      const cutoff = Date.now() - EXPORT_TTL_MS;
      let removed = 0;
      for (const name of entries) {
        const full = path.join(exportsDir, name);
        try {
          const st = await fs.lstat(full);
          // Только обычные файлы — без рекурсии, без symlink-traversal.
          if (!st.isFile()) continue;
          if (st.mtimeMs > cutoff) continue;
          await fs.unlink(full);
          removed++;
        } catch (err) {
          this.logger.debug(
            `cleanupStaleExports: skip ${full}: ${(err as Error).message}`,
          );
        }
      }
      if (removed > 0) {
        this.logger.log(`Cleaned up ${removed} stale DB export(s) from ${exportsDir}`);
      }
    } catch (err) {
      this.logger.warn(`cleanupStaleExports failed: ${(err as Error).message}`);
    }
  }

  async findAll(options: DbListOptions) {
    const {
      userId,
      role,
      type,
      search,
      siteId,
      domainId,
      page = 1,
      perPage = 20,
    } = options;
    await this.domainContext.requireOwnedSiteDomain(
      siteId,
      domainId,
      userId,
      role,
    );
    const pagination = this.listPagination(page, perPage);
    const where = this.buildListWhere({ type, search, siteDomainId: domainId });

    const [databases, total] = await Promise.all([
      this.prisma.database.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: pagination.take,
        skip: pagination.skip,
        include: {
          site: { select: { id: true, name: true } },
          siteDomain: {
            select: { id: true, domain: true, preset: true },
          },
        },
      }),
      this.prisma.database.count({ where }),
    ]);

    return {
      databases,
      meta: {
        page: pagination.page,
        perPage: pagination.take,
        total,
        totalPages: Math.ceil(total / pagination.take),
      },
    };
  }

  async findAllAcrossSites(options: GlobalDbListOptions) {
    const {
      userId,
      role,
      type,
      search,
      page = 1,
      perPage = 20,
    } = options;
    const pagination = this.listPagination(page, perPage);
    const where = this.buildListWhere({
      type,
      search,
      ownerUserId: role === 'ADMIN' ? undefined : userId,
    });

    const [databases, total] = await Promise.all([
      this.prisma.database.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: pagination.take,
        skip: pagination.skip,
        include: {
          site: { select: { id: true, name: true } },
          siteDomain: {
            select: { id: true, domain: true, preset: true },
          },
        },
      }),
      this.prisma.database.count({ where }),
    ]);

    return {
      databases,
      meta: {
        page: pagination.page,
        perPage: pagination.take,
        total,
        totalPages: Math.ceil(total / pagination.take),
      },
    };
  }

  async findById(
    siteId: string,
    domainId: string,
    id: string,
    userId: string,
    role: string,
  ) {
    const db = await this.prisma.database.findUnique({
      where: { id },
      include: {
        site: { select: { id: true, name: true, userId: true } },
        siteDomain: { select: { id: true, siteId: true, domain: true, preset: true } },
      },
    });

    if (!db) throw new NotFoundException('Database not found');
    if (db.siteId !== siteId || db.siteDomainId !== domainId) {
      throw new NotFoundException('Database not found');
    }
    if (role !== 'ADMIN' && db.site?.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    return db;
  }

  async create(
    siteId: string,
    domainId: string,
    dto: CreateDatabaseDto,
    userId: string,
    role: string,
  ) {
    await this.assertCreateAllowed(siteId, domainId, dto, userId, role);
    const purpose = dto.purpose || 'AUXILIARY';

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
        siteId,
        siteDomainId: domainId,
        purpose,
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

  async assertCreateAllowed(
    siteId: string,
    domainId: string,
    dto: CreateDatabaseDto,
    userId: string,
    role: string,
  ): Promise<void> {
    await this.domainContext.requireOwnedSiteDomain(
      siteId,
      domainId,
      userId,
      role,
    );
    const purpose = dto.purpose || 'AUXILIARY';
    if (purpose === 'APP_PRIMARY') {
      const existingPrimary = await this.prisma.database.findFirst({
        where: { siteDomainId: domainId, purpose: 'APP_PRIMARY' },
        select: { id: true },
      });
      if (existingPrimary) {
        throw new ConflictException('Domain already has an APP_PRIMARY database');
      }
    }
    const existing = await this.prisma.database.findFirst({
      where: { name: dto.name, type: dto.type },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(`Database "${dto.name}" (${dto.type}) already exists`);
    }
    await this.assertEngineInstalled(dto.type);
  }

  async update(
    siteId: string,
    domainId: string,
    id: string,
    dto: UpdateDatabaseDto,
    userId: string,
    role: string,
    idempotencyKey?: string,
  ) {
    await this.findById(siteId, domainId, id, userId, role);
    const operation = await this.operations.begin({
      idempotencyKey,
      type: 'DATABASE_UPDATE',
      siteId,
      siteDomainId: domainId,
      databaseId: id,
      lockSite: false,
      userId,
      request: dto,
    });
    if (operation.replayed) {
      return this.findById(siteId, domainId, id, userId, role);
    }
    await this.operations.start(operation.id, 'validate');

    try {
      const db = await this.findById(siteId, domainId, id, userId, role);
      if (dto.purpose === 'AUXILIARY' && db.purpose === 'APP_PRIMARY') {
        if (
          db.siteDomain.preset === 'MODX_REVO' ||
          db.siteDomain.preset === 'MODX_3'
        ) {
          throw new ConflictException(
            'Managed MODX application must keep its APP_PRIMARY database',
          );
        }
      }
      if (dto.purpose === 'APP_PRIMARY' && db.purpose !== 'APP_PRIMARY') {
        const existingPrimary = await this.prisma.database.findFirst({
          where: {
            siteDomainId: domainId,
            purpose: 'APP_PRIMARY',
            id: { not: id },
          },
          select: { id: true },
        });
        if (existingPrimary) {
          throw new ConflictException(
            'Domain already has an APP_PRIMARY database',
          );
        }
      }

      const updated = await this.prisma.database.update({
        where: { id },
        data: {
          ...(dto.purpose !== undefined && { purpose: dto.purpose }),
        },
      });
      await this.operations.succeed(operation.id, { databaseId: id });
      return updated;
    } catch (error) {
      await this.operations.fail(operation.id, error).catch(() => undefined);
      throw error;
    }
  }

  async resetPassword(siteId: string, domainId: string, id: string, userId: string, role: string) {
    const db = await this.findById(siteId, domainId, id, userId, role);

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

  /**
   * Возвращает плейн-пароль БД для UI-просмотра.
   *
   * Использование: оператору регулярно нужно подсмотреть/скопировать пароль БД
   * (в config сайта, в SSH-туннеле и т.п.). Reset каждый раз — лишнее
   * (ломает существующие connection-строки). Поэтому даём прочитать
   * сохранённый зашифрованный пароль.
   *
   * Безопасность:
   *   - Только admin (enforced на контроллере @Roles('ADMIN')).
   *   - Дополнительно — ownership-чек через findById (admin и так проходит).
   *   - Throttle на контроллере, чтобы перебор по id-ам был дорогим.
   *   - Если в БД хранится только legacy-хэш без enc — кидаем BadRequest
   *     с подсказкой сделать reset (тот же путь, что и Adminer SSO).
   */
  async revealPassword(siteId: string, domainId: string, id: string, userId: string, role: string): Promise<{
    name: string;
    dbUser: string;
    password: string;
  }> {
    const db = await this.findById(siteId, domainId, id, userId, role);
    const password = this.getPlainPassword(db);
    return {
      name: db.name,
      dbUser: db.dbUser,
      password,
    };
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
  getPlainPassword(db: { dbPasswordEnc: string | null; name: string }): string {
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

  async createAdminerTicket(siteId: string, domainId: string, id: string, userId: string, role: string) {
    const db = await this.findById(siteId, domainId, id, userId, role);
    const password = this.getPlainPassword(db);

    const driverByType: Record<string, 'server' | 'pgsql'> = {
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

    return this.adminerHandoffs.create({
      purpose: 'ADMINER',
      resourceKind: 'DATABASE',
      resourceId: db.id,
      actor: { userId, role },
      credentials: {
      driver,
      host: '127.0.0.1',
      port: portByType[db.type],
      socket: null,
      user: db.dbUser,
      pass: password,
      database: db.name,
      },
    });
  }

}
