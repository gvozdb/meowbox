import {
  Inject,
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
  forwardRef,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SiteType, SiteStatus, DatabaseType, SslStatus } from '../common/enums';
import { randomBytes } from 'crypto';
import { hashPassword } from '../common/crypto/argon2.helper';
import { encryptJson } from '../common/crypto/credentials-cipher';
import { encryptSshPassword, decryptSshPassword } from '../common/crypto/ssh-cipher';
import { encryptCmsPassword, decryptCmsPassword } from '../common/crypto/cms-cipher';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { AgentGateway } from '../gateway/agent.gateway';
import { ConfigService } from '@nestjs/config';
import { CreateSiteDto, UpdateSiteDto, UpdateModxVersionDto, DuplicateSiteDto } from './sites.dto';
import {
  stringifyStringArray,
  stringifySiteAliases,
  aliasDomains,
  SiteAliasParsed,
} from '../common/json-array';
import {
  mapSite,
  mapSsl,
  jsonArrayContains,
} from '../common/sqlite-mappers';
import { PanelSettingsService } from '../panel-settings/panel-settings.service';
import { isReservedSiteName } from '../common/validators/site-names';
import { siteNginxOverrides, initialCustomConfigFor, type SiteNginxColumns } from '@meowbox/shared';

/**
 * Собирает payload для socket-события `nginx:create-config`.
 *
 * Принимает Site из Prisma + опциональный SslCertificate (если null/undefined —
 * отключённое SSL). Гарантирует что settings и customConfig попадут в агент,
 * иначе агент использует свои дефолты (что тоже ок, но менее предсказуемо).
 */
function buildNginxCreateConfigPayload(
  site: {
    name: string;
    type: string;
    domain: string;
    aliases: string | unknown[];
    rootPath: string;
    filesRelPath: string | null;
    phpVersion: string | null;
    appPort: number | null;
    systemUser: string | null;
    httpsRedirect: boolean;
    nginxCustomConfig?: string | null;
  } & SiteNginxColumns,
  sslActive: boolean,
  ssl?: { certPath?: string | null; keyPath?: string | null } | null,
): Record<string, unknown> {
  const aliases = Array.isArray(site.aliases)
    ? site.aliases
    : (() => {
        try { return JSON.parse(site.aliases || '[]'); } catch { return []; }
      })();
  return {
    siteName: site.name,
    siteType: site.type,
    domain: site.domain,
    aliases,
    rootPath: site.rootPath,
    filesRelPath: site.filesRelPath ?? 'www',
    phpVersion: site.phpVersion ?? undefined,
    phpEnabled: !!site.phpVersion,
    appPort: site.appPort ?? undefined,
    systemUser: site.systemUser ?? undefined,
    sslEnabled: sslActive,
    certPath: sslActive ? ssl?.certPath ?? undefined : undefined,
    keyPath: sslActive ? ssl?.keyPath ?? undefined : undefined,
    httpsRedirect: site.httpsRedirect,
    settings: siteNginxOverrides(site),
    customConfig: site.nginxCustomConfig ?? undefined,
  };
}

// Для MODX оба модуля (PHP + БД) включаются автоматически, вне зависимости от флагов в DTO.
const MODX_TYPES: string[] = ['MODX_REVO', 'MODX_3'];

interface SiteListOptions {
  userId: string;
  role: string;
  page?: number;
  perPage?: number;
  type?: string;
  status?: string;
  search?: string;
}

/** Решение: нужен ли PHP-FPM пул для этого сайта? */
function shouldEnablePhp(type: string, dto: { phpEnabled?: boolean; phpVersion?: string }): boolean {
  if (MODX_TYPES.includes(type)) return true;
  return !!(dto.phpEnabled && dto.phpVersion);
}

/** Решение: надо ли создать пользовательскую БД для этого сайта? */
function shouldEnableDb(type: string, dto: { dbEnabled?: boolean }): boolean {
  if (MODX_TYPES.includes(type)) return true;
  return !!dto.dbEnabled;
}

@Injectable()
export class SitesService implements OnModuleInit {
  private readonly logger = new Logger('SitesService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
    private readonly config: ConfigService,
    private readonly panelSettings: PanelSettingsService,
    @Inject(forwardRef(() => AgentGateway))
    private readonly gateway: AgentGateway,
  ) {}

  /**
   * Миграция nginx/PHP-FPM артефактов со старой схемы (имя файла = домен) на
   * новую (имя файла = Site.name / Linux-юзер, неизменяемый якорь). Миграция
   * нужна, потому что раньше при смене главного домена мы пересоздавали
   * nginx-конфиг и PHP-FPM pool — теперь домен больше не в путях, смена
   * домена меняет только `server_name` внутри конфига.
   *
   * Логика:
   *   1) Для каждого сайта спрашиваем у агента, есть ли файл `{name}.conf`.
   *   2) Если нет — сайт ещё на старой схеме: пересобираем nginx-config +
   *      PHP-FPM pool под новую схему (handler'ы сами удаляют legacy-файлы,
   *      если `siteName !== domain`).
   *   3) Если есть — уже мигрирован, пропускаем.
   *
   * Вызывается ОДИН раз при старте API. Если агент офлайн — молча выходим,
   * миграция подхватится при следующем рестарте.
   */
  async onModuleInit(): Promise<void> {
    // Подписываемся на событие подключения агента — миграции запустятся,
    // как только агент будет онлайн (и снова при reconnect, что важно после
    // вынужденных рестартов агента/сети). Раньше миграции крутились через
    // setTimeout(5s); если агент в этот момент офлайн — миграция тихо
    // пропускалась НАВСЕГДА (до перезапуска API). Из-за этого, например,
    // на части серверов так и не настроились per-user CLI-шимы PHP.
    this.agentRelay.onAgentConnect(() => {
      this.migrateArtifactsToSiteNameSchema().catch((err) => {
        this.logger.warn(
          `Artifact migration skipped: ${(err as Error).message}`,
        );
      });
      this.migratePhpCliShimsForAllSites().catch((err) => {
        this.logger.warn(
          `PHP CLI shim migration skipped: ${(err as Error).message}`,
        );
      });
    });
  }

  /**
   * Public-обёртка для ручного перезапуска миграции PHP-шимов. Используется
   * админ-эндпоинтом `POST /api/admin/php-shim/resync` (вместе с Makefile-
   * таргетом `make php-shim-resync`) для случая, когда автоматическая
   * миграция не отработала (агент был офлайн / упал на полпути).
   */
  async resyncPhpCliShims(): Promise<{ ok: number; fail: number; total: number }> {
    return this.runPhpCliShimsForAllSites();
  }

  /**
   * Однопроходная миграция: проставляет per-user CLI-шим (`php` в SSH/SFTP)
   * для всех уже существующих в БД сайтов с активным PHP. Идемпотентна —
   * можно гонять много раз, шим перезаписывается на нужную версию.
   *
   * Вызывается ОДИН раз при старте API (в onModuleInit). Если агент офлайн —
   * молча скипаем, подхватится при следующем рестарте API.
   */
  private async migratePhpCliShimsForAllSites(): Promise<void> {
    await this.runPhpCliShimsForAllSites();
  }

  private async runPhpCliShimsForAllSites(): Promise<{ ok: number; fail: number; total: number }> {
    if (!this.agentRelay.isAgentConnected()) {
      this.logger.log('PHP shim migration: agent offline — skip');
      return { ok: 0, fail: 0, total: 0 };
    }

    const sites = await this.prisma.site.findMany({
      where: {
        status: { not: SiteStatus.DEPLOYING },
        phpVersion: { not: null },
        systemUser: { not: null },
      },
      select: { id: true, name: true, systemUser: true, rootPath: true, phpVersion: true },
    });

    if (sites.length === 0) {
      this.logger.log('PHP shim migration: no PHP-enabled sites found');
      return { ok: 0, fail: 0, total: 0 };
    }

    let ok = 0;
    let fail = 0;
    for (const s of sites) {
      try {
        const res = await this.agentRelay.emitToAgent<{ success: boolean; error?: string }>(
          'user:setup-php-shim',
          {
            username: s.systemUser,
            homeDir: s.rootPath,
            phpVersion: s.phpVersion,
          },
          20_000,
        );
        if (res?.success) {
          ok++;
        } else {
          fail++;
          this.logger.warn(
            `PHP shim migration: "${s.name}" failed — ${res?.error || 'unknown'}`,
          );
        }
      } catch (err) {
        fail++;
        this.logger.warn(
          `PHP shim migration: "${s.name}" error — ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `PHP shim migration done: ok=${ok} fail=${fail} total=${sites.length}`,
    );
    return { ok, fail, total: sites.length };
  }

  private async migrateArtifactsToSiteNameSchema(): Promise<void> {
    if (!this.agentRelay.isAgentConnected()) {
      this.logger.log('Migration: agent offline — skip (will retry on next start)');
      return;
    }

    const sites = await this.prisma.site.findMany({
      where: { status: { not: SiteStatus.DEPLOYING } },
      select: {
        id: true, name: true, domain: true, type: true,
        rootPath: true, filesRelPath: true, phpVersion: true,
        appPort: true, systemUser: true, httpsRedirect: true,
        aliases: true,
        sslCertificate: {
          select: { status: true, certPath: true, keyPath: true },
        },
      } as Prisma.SiteSelect,
    });

    let migrated = 0;
    let skipped = 0;

    for (const s of sites as Array<{
      id: string; name: string; domain: string; type: string;
      rootPath: string; filesRelPath: string | null; phpVersion: string | null;
      appPort: number | null; systemUser: string | null; httpsRedirect: boolean;
      aliases: string;
      sslCertificate: { status: string; certPath: string | null; keyPath: string | null } | null;
    }>) {
      if (s.name === s.domain) {
        // Для сайтов где name совпадает с domain (legacy — имя = домен)
        // путь не менялся, миграция не нужна.
        skipped++;
        continue;
      }

      // Проверяем: есть ли уже файл под новой схемой?
      const probe = await this.agentRelay.emitToAgent<string | null>(
        'nginx:read-config',
        { siteName: s.name },
        10_000,
      ).catch(() => null);

      if (probe && probe.success && probe.data) {
        // Уже мигрирован.
        skipped++;
        continue;
      }

      // Нужно мигрировать. Собираем параметры конфига.
      const ssl = s.sslCertificate;
      const sslActive = !!(ssl && ssl.status === SslStatus.ACTIVE && ssl.certPath && ssl.keyPath);

      try {
        this.logger.log(`Migrating artifacts for site "${s.name}" (${s.domain}) → siteName schema`);

        await this.agentRelay.emitToAgent(
          'nginx:create-config',
          buildNginxCreateConfigPayload(s, sslActive, ssl),
          30_000,
        );

        if (s.phpVersion) {
          await this.agentRelay.emitToAgent('php:create-pool', {
            siteName: s.name,
            domain: s.domain,
            phpVersion: s.phpVersion,
            user: s.systemUser,
            rootPath: s.rootPath,
            sslEnabled: sslActive,
            customConfig: null, // кастомные оверрайды ниже не нужны (они сохранены в БД, подтянутся в следующий edit)
          }, 30_000);

          // CLI-шим — заодно зальём при миграции legacy-артефактов.
          await this.applyPhpShim({
            username: s.systemUser,
            homeDir: s.rootPath,
            phpVersion: s.phpVersion,
          });
        }

        // Обновим path в БД — для UI-превью (file existence check).
        await this.prisma.site.update({
          where: { id: s.id },
          data: { nginxConfigPath: `/etc/nginx/sites-available/${s.name}.conf` },
        }).catch(() => { /* best-effort */ });

        migrated++;
      } catch (err) {
        this.logger.warn(
          `Artifact migration failed for "${s.name}": ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `Artifact migration done: migrated=${migrated} skipped=${skipped} total=${sites.length}`,
    );
  }

  /**
   * Получаем дефолты путей: сначала из panel-settings (KV), иначе .env SITES_BASE_PATH,
   * иначе /var/www. Относительный путь — из настроек (по умолчанию "www").
   */
  private async resolvePathDefaults(): Promise<{ basePath: string; relPath: string }> {
    const fromSettings = await this.panelSettings.getSiteDefaults();
    const envBase = this.config.get<string>('SITES_BASE_PATH');
    const basePath = fromSettings.sitesBasePath || envBase || '/var/www';
    const relPath = fromSettings.siteFilesRelativePath || 'www';
    return { basePath, relPath };
  }

  /**
   * Проверка, что выбранный движок БД установлен на сервере.
   * Источник правды — таблица ServerService (синхронизируется при заходе на /services).
   *
   * Маппинг dbType → ключ сервиса:
   *   MARIADB | MYSQL  → 'mariadb'   (один пакет mariadb-server обслуживает оба;
   *                                    MYSQL-вариант оставлен для обратной совместимости)
   *   POSTGRESQL       → 'postgresql'
   *
   * Если dbType не задан — проверяем, что хотя бы один DB-движок установлен
   * (агент потом сам сделает detect и выберет первый доступный).
   *
   * @throws ConflictException с понятным сообщением для UI.
   */
  private async assertDbEngineAvailable(dbType: string | null, siteType: string): Promise<void> {
    const installed = await this.prisma.serverService.findMany({
      where: { installed: true, serviceKey: { in: ['mariadb', 'postgresql'] } },
      select: { serviceKey: true },
    });
    const installedKeys = new Set(installed.map((r) => r.serviceKey));

    if (installedKeys.size === 0) {
      // Для MODX БД обязательна → нельзя создать сайт вообще без движка.
      // Для CUSTOM с dbEnabled=true — то же самое.
      const hint = MODX_TYPES.includes(siteType)
        ? `MODX (${siteType}) требует БД. Установи MariaDB или PostgreSQL на странице /services перед созданием сайта.`
        : 'Включена БД, но ни одного движка не установлено. Установи MariaDB или PostgreSQL на /services, либо отключи БД для этого сайта.';
      throw new ConflictException(hint);
    }

    if (!dbType) return; // движок будет выбран автодетектом из доступных

    const requiredKey =
      dbType === 'POSTGRESQL' ? 'postgresql'
      : (dbType === 'MARIADB' || dbType === 'MYSQL') ? 'mariadb'
      : null;

    if (!requiredKey) {
      throw new ConflictException(`Неизвестный тип БД: ${dbType}`);
    }

    if (!installedKeys.has(requiredKey)) {
      const niceName = requiredKey === 'mariadb' ? 'MariaDB / MySQL' : 'PostgreSQL';
      throw new ConflictException(
        `${niceName} не установлен на сервере. Установи его на странице /services или выбери другой движок.`,
      );
    }
  }

  private generatePassword(length: number): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_';
    const bytes = randomBytes(length);
    return Array.from(bytes, (b) => chars[b % chars.length]).join('');
  }

  /**
   * Best-effort: ставит/обновляет per-user CLI-шим, чтобы команда `php` в
   * SSH/SFTP-сессии юзера сайта вызывала ту же версию PHP, что и FPM-пул.
   *
   * Никогда не бросает — best-effort. Если агент не подключён или вернул ошибку,
   * просто пишем в лог. Шим — улучшение DX, не блокирует основной поток
   * (создание/смену версии).
   *
   * Передавай phpVersion=null если PHP на сайте отключён — шим вычистится.
   */
  private async applyPhpShim(params: {
    username: string | null | undefined;
    homeDir: string | null | undefined;
    phpVersion: string | null | undefined;
  }): Promise<void> {
    if (!params.username || !params.homeDir) return;
    if (!this.agentRelay.isAgentConnected()) return;

    try {
      const res = await this.agentRelay.emitToAgent<{ success: boolean; error?: string }>(
        'user:setup-php-shim',
        {
          username: params.username,
          homeDir: params.homeDir,
          phpVersion: params.phpVersion ?? null,
        },
        20_000,
      );
      if (!res || !res.success) {
        this.logger.warn(
          `PHP shim setup failed for "${params.username}" (php=${params.phpVersion ?? 'none'}): ${res?.error || 'unknown'}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `PHP shim emit error for "${params.username}": ${(err as Error).message}`,
      );
    }
  }

  async findAll(options: SiteListOptions) {
    const { userId, role, page = 1, perPage = 20, type, status, search } = options;
    const take = Math.min(perPage, 100);
    const skip = (page - 1) * take;

    const where: Prisma.SiteWhereInput = {};

    if (role !== 'ADMIN') {
      where.userId = userId;
    }

    if (type) where.type = type as SiteType;
    if (status) where.status = status as SiteStatus;
    if (search) {
      where.OR = [
        { name: { contains: search } },
        { domain: { contains: search } },
      ];
    }

    const [sites, total] = await Promise.all([
      this.prisma.site.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        omit: {
          sshPassword: true, sshPasswordEnc: true,
          cmsAdminPassword: true, cmsAdminPasswordEnc: true,
        },
        include: {
          sslCertificate: { select: { status: true, expiresAt: true } },
          _count: { select: { databases: true, backups: true } },
        },
      }),
      this.prisma.site.count({ where }),
    ]);

    return {
      sites: sites.map((s) => mapSite(s)),
      meta: {
        page,
        perPage: take,
        total,
        totalPages: Math.ceil(total / take),
      },
    };
  }

  async findById(id: string, userId?: string, role?: string) {
    const site = await this.prisma.site.findUnique({
      where: { id },
      omit: {
        sshPassword: true, sshPasswordEnc: true,
        cmsAdminPassword: true, cmsAdminPasswordEnc: true,
      },
      include: {
        sslCertificate: true,
        databases: {
          select: { id: true, name: true, type: true, sizeBytes: true },
        },
        _count: { select: { deployLogs: true, backups: true, cronJobs: true } },
      },
    });

    if (!site) {
      throw new NotFoundException('Site not found');
    }

    if (role && role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied to this site');
    }

    const mapped = mapSite(site) as unknown as Record<string, unknown>;
    if ((site as { sslCertificate?: unknown }).sslCertificate) {
      mapped.sslCertificate = mapSsl((site as { sslCertificate: unknown }).sslCertificate as never);
    }
    return mapped;
  }

  /** SSH/SFTP + CMS admin credentials — отдельный endpoint для безопасности. */
  async getSshCredentials(id: string, userId: string, role: string) {
    const site = await this.prisma.site.findUnique({
      where: { id },
      select: {
        id: true, userId: true, systemUser: true,
        sshPassword: true, sshPasswordEnc: true,
        rootPath: true,
        cmsAdminUser: true,
        cmsAdminPassword: true, cmsAdminPasswordEnc: true,
        domain: true, managerPath: true,
      },
    });

    if (!site) {
      throw new NotFoundException('Site not found');
    }

    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied to this site');
    }

    // Расшифровка с fallback на legacy plain (до прохода rekey-secrets миграции).
    const sshPlain = site.sshPasswordEnc
      ? this.tryDecryptSsh(site.sshPasswordEnc, id)
      : site.sshPassword;
    const cmsPlain = site.cmsAdminPasswordEnc
      ? this.tryDecryptCms(site.cmsAdminPasswordEnc, id)
      : site.cmsAdminPassword;

    return {
      username: site.systemUser,
      password: sshPlain,
      host: 'server',
      port: 22,
      homeDir: site.rootPath,
      cms: site.cmsAdminUser ? {
        user: site.cmsAdminUser,
        password: cmsPlain,
        url: `https://${site.domain}/${site.managerPath || 'manager'}/`,
      } : null,
    };
  }

  private tryDecryptSsh(enc: string, siteId: string): string | null {
    try {
      return decryptSshPassword(enc);
    } catch (e) {
      this.logger.error(`Failed to decrypt sshPassword for site ${siteId}: ${(e as Error).message}`);
      return null;
    }
  }

  private tryDecryptCms(enc: string, siteId: string): string | null {
    try {
      return decryptCmsPassword(enc);
    } catch (e) {
      this.logger.error(`Failed to decrypt cmsAdminPassword for site ${siteId}: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Смена SSH-пароля для пользователя сайта.
   * Если `newPassword` не передан — генерируем криптостойкий пароль.
   */
  async changeSshPassword(
    id: string,
    userId: string,
    role: string,
    newPassword?: string,
  ): Promise<{ password: string }> {
    const site = await this.prisma.site.findUnique({
      where: { id },
      select: { id: true, userId: true, systemUser: true, name: true },
    });

    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    if (!site.systemUser) {
      throw new ConflictException('Site has no system user (legacy site without SSH)');
    }

    // Валидация пароля, если задан вручную.
    let password: string;
    if (newPassword && newPassword.length > 0) {
      if (newPassword.length < 12) {
        throw new ConflictException('SSH-пароль должен быть не короче 12 символов');
      }
      if (newPassword.length > 128) {
        throw new ConflictException('SSH-пароль слишком длинный (макс. 128)');
      }
      // Запрещаем \0, перевод строки и прочую служебку.
      // eslint-disable-next-line no-control-regex
      if (/[\x00-\x1f\x7f]/.test(newPassword)) {
        throw new ConflictException('SSH-пароль содержит управляющие символы');
      }
      password = newPassword;
    } else {
      password = randomBytes(16).toString('base64url');
    }

    // Применяем на уровне OS через агент.
    const agentResult = await this.agentRelay.emitToAgent<{ success: boolean; error?: string }>(
      'user:set-password',
      { username: site.systemUser, password },
    );
    if (!agentResult.success) {
      throw new InternalServerErrorException(
        `Failed to set SSH password: ${agentResult.error || 'unknown agent error'}`,
      );
    }

    // Сохраняем в БД зашифрованным — old plain поле обнуляем.
    await this.prisma.site.update({
      where: { id },
      data: { sshPasswordEnc: encryptSshPassword(password), sshPassword: null },
    });

    this.logger.log(`SSH password changed for site "${site.name}"`);
    return { password };
  }

  /**
   * Смена пароля админа MODX (Revo / 3). Использует bootstrap MODX_API_MODE
   * на агенте — нативный механизм MODX гарантирует совместимый hash (соль,
   * стратегия pbkdf2/sha1) для любой версии установленного ядра.
   *
   * Если password пустой — генерим случайный 16-байтный base64url.
   * Возвращает фактически применённый пароль (как и changeSshPassword).
   *
   * Требования:
   *   - Сайт типа MODX_REVO или MODX_3
   *   - У сайта прописан cmsAdminUser (мы не угадываем имя)
   */
  async changeCmsAdminPassword(
    id: string,
    userId: string,
    role: string,
    newPassword?: string,
  ): Promise<{ password: string }> {
    const site = await this.prisma.site.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        name: true,
        type: true,
        rootPath: true,
        filesRelPath: true,
        phpVersion: true,
        systemUser: true,
        cmsAdminUser: true,
      },
    });

    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    if (site.type !== SiteType.MODX_REVO && site.type !== SiteType.MODX_3) {
      throw new ConflictException('Сайт не на MODX — менять админский пароль нечего');
    }
    if (!site.cmsAdminUser) {
      throw new ConflictException(
        'У сайта не указан логин MODX-админа в БД панели — заполни сначала имя пользователя',
      );
    }

    // Валидация / генерация пароля. Дублируем DTO-проверку — defense in depth
    // (DTO не сработает, если контроллер кто-то будет дёргать в обход).
    let password: string;
    if (newPassword && newPassword.length > 0) {
      if (newPassword.length < 8) {
        throw new ConflictException('Пароль MODX-админа должен быть не короче 8 символов');
      }
      if (newPassword.length > 128) {
        throw new ConflictException('Пароль MODX-админа слишком длинный (макс. 128)');
      }
      // eslint-disable-next-line no-control-regex
      if (/[\x00-\x1f\x7f]/.test(newPassword)) {
        throw new ConflictException('Пароль содержит управляющие символы');
      }
      password = newPassword;
    } else {
      password = randomBytes(16).toString('base64url');
    }

    const agentResult = await this.agentRelay.emitToAgent<{ success: boolean; error?: string; message?: string }>(
      'modx:change-admin-password',
      {
        rootPath: site.rootPath,
        filesRelPath: site.filesRelPath ?? 'www',
        phpVersion: site.phpVersion ?? undefined,
        systemUser: site.systemUser ?? undefined,
        username: site.cmsAdminUser,
        password,
        // Семантика 1:1 с оригинальным changeAdminPass.php: юзера нет →
        // создать sudo, есть → сменить пароль. Без флагов.
      },
    );

    if (!agentResult.success) {
      throw new InternalServerErrorException(
        `Не удалось сменить пароль MODX-админа: ${agentResult.error || 'unknown agent error'}`,
      );
    }

    await this.prisma.site.update({
      where: { id },
      data: { cmsAdminPasswordEnc: encryptCmsPassword(password), cmsAdminPassword: null },
    });

    this.logger.log(`MODX admin password changed for site "${site.name}" (user "${site.cmsAdminUser}")`);
    return { password };
  }

  /**
   * Обновление версии установленного MODX-сайта.
   * Работает для MODX_REVO (через ZIP overlay) и MODX_3 (через composer require).
   */
  async updateModxVersion(
    id: string,
    userId: string,
    role: string,
    dto: UpdateModxVersionDto,
  ): Promise<{ version: string; previousVersion: string | null }> {
    const site = await this.prisma.site.findUnique({
      where: { id },
      select: {
        id: true, userId: true, name: true, type: true, domain: true,
        rootPath: true, filesRelPath: true, phpVersion: true, systemUser: true,
        managerPath: true, connectorsPath: true, modxVersion: true,
      },
    });

    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    if (site.type !== 'MODX_REVO' && site.type !== 'MODX_3') {
      throw new ConflictException('Обновление поддерживается только для MODX-сайтов');
    }
    // Тот же номер версии разрешён — это reinstall/перезапись файлов ядра.

    // Простая проверка: нельзя мигрировать между мажорами через upgrade.
    const isMajor2 = dto.targetVersion.startsWith('2.');
    const isMajor3 = dto.targetVersion.startsWith('3.');
    if (site.type === 'MODX_REVO' && !isMajor2) {
      throw new ConflictException(
        'Сайт MODX_REVO (2.x) можно апгрейдить только на версии 2.x. Для перехода на 3.x пересоздай сайт.',
      );
    }
    if (site.type === 'MODX_3' && !isMajor3) {
      throw new ConflictException(
        'Сайт MODX_3 можно апгрейдить только на версии 3.x.',
      );
    }

    const previousVersion = site.modxVersion;
    this.logger.log(
      `Updating MODX version for "${site.name}": ${previousVersion || '(unknown)'} → ${dto.targetVersion}`,
    );

    const result = await this.agentRelay.emitToAgent<{ version?: string }>(
      'site:update-modx',
      {
        siteId: id,
        siteType: site.type,
        rootPath: site.rootPath,
        filesRelPath: site.filesRelPath,
        phpVersion: site.phpVersion || '8.2',
        targetVersion: dto.targetVersion,
        domain: site.domain,
        systemUser: site.systemUser,
        managerPath: site.managerPath || 'manager',
        connectorsPath: site.connectorsPath || 'connectors',
      },
      900_000, // 15 минут — composer/download + setup
    );

    if (!result.success) {
      throw new InternalServerErrorException(
        `MODX update failed: ${result.error || 'unknown agent error'}`,
      );
    }

    const finalVersion = result.data?.version || dto.targetVersion;
    await this.prisma.site.update({
      where: { id },
      data: { modxVersion: finalVersion },
    });

    return { version: finalVersion, previousVersion };
  }

  /**
   * Нормализация прав и владельца файлов сайта.
   *
   * Что делает:
   *  - chown -R systemUser:systemUser rootPath
   *  - chmod -R u=rwX,g=rX,o-rwx wwwDir (X = exec только для каталогов
   *    и уже-исполняемых файлов; node_modules/.bin/* остаются исполняемыми)
   *  - для MODX-сайтов дополнительно даёт g+w на core/cache/export/packages
   *    и assets (PHP-FPM должен иметь возможность писать туда eventMap).
   *
   * Безопасно вызывать в любой момент. Используется как:
   *  - кнопка из UI на странице сайта (блок «Утилиты»)
   *  - fix-step для MODX Doctor'а (cache-foreign-owner / config-inc-unreadable)
   */
  async normalizeSitePermissions(
    id: string,
    userId: string,
    role: string,
  ): Promise<{ steps: Array<{ cmd: string; ok: boolean; error?: string }>; modxCorePath?: string }> {
    const site = await this.prisma.site.findUnique({
      where: { id },
      select: {
        id: true, userId: true, name: true, type: true,
        rootPath: true, filesRelPath: true, systemUser: true,
      },
    });
    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    if (!site.systemUser) {
      throw new ConflictException('У сайта нет systemUser — нечего нормализовать');
    }

    const result = await this.agentRelay.emitToAgent<{
      steps: Array<{ cmd: string; ok: boolean; error?: string }>;
      modxCorePath?: string;
    }>(
      'site:normalize-permissions',
      {
        rootPath: site.rootPath,
        filesRelPath: site.filesRelPath,
        systemUser: site.systemUser,
        siteType: site.type,
      },
      120_000, // chmod -R на крупных сайтах может занимать до минуты
    );

    if (!result.success) {
      throw new InternalServerErrorException(
        `Не удалось нормализовать права: ${result.error || 'unknown agent error'}`,
      );
    }

    return {
      steps: result.data?.steps || [],
      modxCorePath: result.data?.modxCorePath,
    };
  }

  /**
   * MODX Doctor — read-only диагностика типовых проблем MODX-сайтов.
   *
   * Проверки:
   *  - core/config/config.inc.php существует и читается
   *  - В core/cache нет файлов с чужим владельцем (фиксит проблему с
   *    нерегенерируемым eventMap → плагины не работают)
   *  - В web-root нет файлов с чужим владельцем (общая проверка)
   *  - setup/ не оставлен публично доступным
   *  - Версия MODX (info-only)
   *
   * Все проблемы (issues) возвращаются с уровнем (critical/warning/info)
   * и опциональным fix'ом (id действия, которое UI предлагает выполнить).
   */
  async runModxDoctor(id: string, userId: string, role: string) {
    const site = await this.prisma.site.findUnique({
      where: { id },
      select: {
        id: true, userId: true, type: true,
        rootPath: true, filesRelPath: true, systemUser: true,
        managerPath: true, connectorsPath: true,
      },
    });
    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    if (site.type !== 'MODX_REVO' && site.type !== 'MODX_3') {
      throw new ConflictException('Doctor доступен только для MODX-сайтов');
    }

    const result = await this.agentRelay.emitToAgent<{
      modxCorePath?: string;
      modxVersion?: string;
      modxConfigOk: boolean;
      issues: Array<{
        id: string;
        level: 'critical' | 'warning' | 'info';
        title: string;
        description: string;
        details?: string[];
        fix?: 'normalize-permissions' | 'cleanup-setup-dir' | null;
      }>;
    }>(
      'site:modx-doctor',
      {
        rootPath: site.rootPath,
        filesRelPath: site.filesRelPath,
        systemUser: site.systemUser,
        managerPath: site.managerPath || 'manager',
        connectorsPath: site.connectorsPath || 'connectors',
      },
      60_000,
    );

    if (!result.success) {
      throw new InternalServerErrorException(
        `Doctor failed: ${result.error || 'unknown agent error'}`,
      );
    }

    return result.data || { modxConfigOk: false, issues: [] };
  }

  /**
   * Удаление setup/ каталога сайта (fix для setup-dir-exposed Doctor'а).
   * Безопасно — каталог опциональный, после установки/апгрейда он не нужен.
   */
  async cleanupSetupDir(id: string, userId: string, role: string) {
    const site = await this.prisma.site.findUnique({
      where: { id },
      select: {
        id: true, userId: true, type: true,
        rootPath: true, filesRelPath: true,
      },
    });
    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    if (site.type !== 'MODX_REVO' && site.type !== 'MODX_3') {
      throw new ConflictException('Только для MODX-сайтов');
    }

    const result = await this.agentRelay.emitToAgent<{ removed: boolean; path?: string; reason?: string }>(
      'site:cleanup-setup-dir',
      {
        rootPath: site.rootPath,
        filesRelPath: site.filesRelPath,
      },
      30_000,
    );

    if (!result.success) {
      throw new InternalServerErrorException(
        `Не удалось удалить setup/: ${result.error || 'unknown agent error'}`,
      );
    }
    return result.data || { removed: false };
  }

  async create(dto: CreateSiteDto, userId: string) {
    // Нормализация флагов модулей.
    const phpEnabled = shouldEnablePhp(dto.type, dto);
    const dbEnabled = shouldEnableDb(dto.type, dto);
    const sslEnabled = !!dto.sslEnabled;
    const httpsRedirect = dto.httpsRedirect !== false; // по умолчанию true

    // Валидация: PHP без версии — ошибка
    if (phpEnabled && !dto.phpVersion) {
      // Для MODX версия по умолчанию — 8.2 (если не передана)
      if (MODX_TYPES.includes(dto.type)) {
        dto.phpVersion = dto.phpVersion || '8.2';
      } else {
        throw new ConflictException('phpVersion is required when PHP is enabled');
      }
    }

    // Валидация движка БД — если БД нужна, движок должен быть установлен.
    // Не вызываем агент: используем синхронизированную табличку ServerService.
    // Юзер увидит чёткий 400 ещё до создания записи и провижининга.
    if (dbEnabled) {
      await this.assertDbEngineAvailable(dto.dbType ?? null, dto.type);
    }

    // Конфликт по домену — сначала в нашей БД
    const existingDomain = await this.prisma.site.findFirst({
      where: {
        OR: [
          { domain: dto.domain },
          { aliases: jsonArrayContains(dto.domain) },
        ],
      },
      select: { id: true, name: true },
    });

    if (existingDomain) {
      throw new ConflictException(
        `Domain ${dto.domain} is already used by site "${existingDomain.name}"`,
      );
    }

    // Конфликт по алиасам нового сайта — тоже проверяем в БД ДО передачи в агент
    const requestedAliases = aliasDomains(dto.aliases);
    for (const ad of requestedAliases) {
      const conflict = await this.prisma.site.findFirst({
        where: {
          OR: [
            { domain: ad },
            { aliases: jsonArrayContains(ad) },
          ],
        },
        select: { name: true },
      });
      if (conflict) {
        throw new ConflictException(
          `Алиас "${ad}" уже используется сайтом "${conflict.name}"`,
        );
      }
    }

    // Конфликт на уровне nginx — даже если в нашей БД домена нет, он может
    // обслуживаться ручным конфигом в /etc/nginx/sites-enabled. Подцепишь
    // такой домен — certbot webroot будет терять challenge-файлы на чужом root.
    await this.ensureDomainFreeInNginx([dto.domain, ...requestedAliases]);

    // Уникальность имени
    const existingName = await this.prisma.site.findUnique({
      where: { name: dto.name },
      select: { id: true },
    });

    if (existingName) {
      throw new ConflictException(`Site name "${dto.name}" is already taken`);
    }

    // Имя сайта уже провалидировано DTO (start with letter, [a-z0-9_-], max 32 chars).
    // Используем как есть: и как Linux-юзер, и как имя БД, и как имя БД-юзера.
    const safeName = dto.name;
    // Путь nginx-конфига якорится на Site.name — не меняется при смене домена.
    const nginxConfigPath = `/etc/nginx/sites-available/${safeName}.conf`;

    if (isReservedSiteName(safeName)) {
      throw new ConflictException(`Name "${safeName}" is reserved by the system`);
    }
    // Защита от клеша со существующими Linux-юзерами (не относящимися к сайтам).
    // Дополнительно агент проверяет — тут лишь ранняя валидация на уровне API.
    const systemUser = safeName;

    // Пути — из panel-settings (KV) + fallback на .env/дефолт.
    // DTO может явно перебить: rootPath (полный homedir) и filesRelPath
    // (web-root внутри homedir). Без override — собираем дефолтные.
    const { basePath, relPath } = await this.resolvePathDefaults();
    const rootPath = dto.rootPath?.trim() || `${basePath}/${safeName}`;
    const filesRelPath = dto.filesRelPath?.trim() || relPath;
    const sshPassword = randomBytes(16).toString('base64url');
    const sshPasswordEnc = encryptSshPassword(sshPassword);

    // Атомарность: Site + SslCertificate создаются в одной транзакции. До
    // этого падение между двумя вызовами оставляло сайт без SSL-placeholder'а —
    // UI показывал "нет SSL-записи" и операции ssl:* ломались.
    const aliasList = aliasDomains(dto.aliases);
    const [site] = await this.prisma.$transaction([
      this.prisma.site.create({
        data: {
          name: dto.name,
          displayName: dto.displayName?.trim() || null,
          domain: dto.domain,
          aliases: stringifySiteAliases(dto.aliases || []),
          type: dto.type as SiteType,
          status: SiteStatus.DEPLOYING,
          phpVersion: phpEnabled ? (dto.phpVersion || '8.2') : null,
          gitRepository: dto.gitRepository || null,
          deployBranch: dto.deployBranch || 'main',
          appPort: dto.appPort || null,
          envVars: JSON.stringify(dto.envVars || {}),
          rootPath,
          filesRelPath,
          nginxConfigPath,
          systemUser,
          sshPasswordEnc,
          dbEnabled,
          httpsRedirect,
          // Стартовый кастом-блок для CMS — кладётся в БД при создании,
          // оттуда же агент записывает в `/etc/nginx/meowbox/{name}/95-custom.conf`.
          // Юзер дальше редактирует через UI; панель не трогает.
          nginxCustomConfig: initialCustomConfigFor(dto.type),
          userId,
        },
      }),
    ]);

    // SslCertificate создаётся во второй транзакции, т.к. зависит от siteId.
    // Если эта часть упадёт — cleanup удалит сайт (см. runProvisioningAsync
    // error handler).
    await this.prisma.sslCertificate.create({
      data: {
        siteId: site.id,
        domains: stringifyStringArray([dto.domain, ...aliasList]),
        status: 'NONE',
        issuer: '',
      },
    }).catch(async (err) => {
      // Rollback: сайта без SSL быть не должно. Удаляем site и пробрасываем.
      await this.prisma.site.delete({ where: { id: site.id } }).catch(() => {});
      throw err;
    });

    // =========================================================================
    // Провижининг: запускаем в фоне, клиент подписывается на WS-лог
    // по siteId и получает события 'site:provision:log' / 'site:provision:done'.
    // Сам HTTP-ответ отдаём сразу, без ожидания 5+ минут на composer/MODX-setup.
    // =========================================================================
    this.runProvisioningAsync(site.id, dto, {
      systemUser,
      rootPath,
      filesRelPath,
      sshPassword,
      phpEnabled,
      dbEnabled,
      sslEnabled,
      httpsRedirect,
      safeName,
    }).catch((err) => {
      // Неперехваченные ошибки уже логируются внутри runProvisioningAsync,
      // здесь — на случай неожиданных throw.
      this.logger.error(
        `Unhandled provisioning failure for "${dto.name}": ${(err as Error).message}`,
      );
    });

    return this.findById(site.id);
  }

  // ===========================================================================
  // Дублирование сайта
  // ===========================================================================

  /**
   * Создать копию существующего сайта под новым `name` и `domain`.
   * Копирует файлы (rsync `www/`), БД (dump+restore), опционально BackupConfigs
   * и CronJobs. SSL/aliases НЕ копируются — новый домен, нужен свежий сертификат
   * и отдельная настройка алиасов.
   *
   * Возвращает свежесозданный сайт сразу (status=DEPLOYING), провижининг идёт
   * в фоне. Фронт подписывается на `site:provision:log` по siteId как обычно.
   */
  async duplicate(
    sourceId: string,
    dto: DuplicateSiteDto,
    userId: string,
    role: string,
  ) {
    // 1) Получаем источник (с проверкой доступа).
    const source = await this.findById(sourceId, userId, role);
    if (!source) throw new NotFoundException('Source site not found');

    // 2) Проверяем уникальность нового имени и домена.
    const conflictName = await this.prisma.site.findUnique({ where: { name: dto.name } });
    if (conflictName) {
      throw new ConflictException(`Site name "${dto.name}" is already taken`);
    }
    const conflictDomain = await this.prisma.site.findFirst({
      where: {
        OR: [
          { domain: dto.domain },
          { aliases: jsonArrayContains(dto.domain) },
        ],
      },
    });
    if (conflictDomain) {
      throw new ConflictException(`Domain ${dto.domain} is already in use`);
    }

    // 3) Reserved-check и nginx-check.
    if (isReservedSiteName(dto.name)) {
      throw new ConflictException(`Name "${dto.name}" is reserved by the system`);
    }
    await this.ensureDomainFreeInNginx([dto.domain]);

    // 4) Генерим пути, пароль.
    const safeName = dto.name;
    const systemUser = safeName;
    const { basePath, relPath } = await this.resolvePathDefaults();
    const rootPath = `${basePath}/${safeName}`;
    const filesRelPath = (source as { filesRelPath?: string | null }).filesRelPath || relPath;
    const nginxConfigPath = `/etc/nginx/sites-available/${safeName}.conf`;
    const sshPassword = randomBytes(16).toString('base64url');
    const sshPasswordEnc = encryptSshPassword(sshPassword);

    // 5) Собираем загружаемый source — phpVersion, type, httpsRedirect.
    const sourceFull = await this.prisma.site.findUnique({
      where: { id: sourceId },
      include: { databases: true },
    });
    if (!sourceFull) throw new NotFoundException('Source site not found');

    // 6) Создаём новую запись. Алиасы не копируем (конфликт бы получился).
    // Site создаётся первым, SSL-placeholder — сразу после, с rollback'ом при
    // ошибке (см. create() для обоснования).
    const site = await this.prisma.site.create({
      data: {
        name: dto.name,
        displayName: dto.displayName?.trim() || null,
        domain: dto.domain,
        aliases: '[]',
        type: sourceFull.type,
        status: SiteStatus.DEPLOYING,
        phpVersion: sourceFull.phpVersion,
        gitRepository: sourceFull.gitRepository,
        deployBranch: sourceFull.deployBranch,
        appPort: sourceFull.appPort,
        envVars: sourceFull.envVars || '{}',
        rootPath,
        filesRelPath,
        nginxConfigPath,
        systemUser,
        sshPasswordEnc,
        dbEnabled: sourceFull.dbEnabled,
        httpsRedirect: sourceFull.httpsRedirect,
        phpPoolCustom: sourceFull.phpPoolCustom,
        userId,
      },
    });

    // SSL-placeholder (NONE — выпускается отдельно руками)
    await this.prisma.sslCertificate.create({
      data: {
        siteId: site.id,
        domains: stringifyStringArray([dto.domain]),
        status: 'NONE',
        issuer: '',
      },
    }).catch(async (err) => {
      await this.prisma.site.delete({ where: { id: site.id } }).catch(() => {});
      throw err;
    });

    // 7) Запускаем фоновый провижининг дубликата.
    this.runDuplicateAsync(site.id, sourceFull, {
      newSiteId: site.id,
      newName: safeName,
      newDomain: dto.domain,
      newSystemUser: systemUser,
      newRootPath: rootPath,
      newFilesRelPath: filesRelPath,
      newSshPassword: sshPassword,
      copyBackupConfigs: !!dto.copyBackupConfigs,
      copyCronJobs: !!dto.copyCronJobs,
    }).catch((err) => {
      this.logger.error(
        `Unhandled duplicate failure for "${dto.name}": ${(err as Error).message}`,
      );
    });

    return this.findById(site.id);
  }

  /**
   * Фоновая часть дублирования: создание юзера, nginx, pool, rsync, копирование БД.
   */
  private async runDuplicateAsync(
    siteId: string,
    source: {
      id: string;
      name: string;
      domain: string;
      type: string;
      phpVersion: string | null;
      rootPath: string;
      filesRelPath: string | null;
      systemUser: string | null;
      httpsRedirect: boolean;
      phpPoolCustom: string | null;
      databases: Array<{ id: string; name: string; type: string; dbUser: string }>;
    },
    ctx: {
      newSiteId: string;
      newName: string;
      newDomain: string;
      newSystemUser: string;
      newRootPath: string;
      newFilesRelPath: string;
      newSshPassword: string;
      copyBackupConfigs: boolean;
      copyCronJobs: boolean;
    },
  ): Promise<void> {
    const log = (level: 'info' | 'warn' | 'error', line: string) => {
      this.gateway.emitSiteProvisionLog(siteId, level, line);
      if (level === 'error') this.logger.error(line);
      else if (level === 'warn') this.logger.warn(line);
      else this.logger.log(line);
    };
    const step = (title: string) => log('info', `▶ ${title}`);

    try {
      // 1) Linux-юзер. Прокидываем filesRelPath источника, чтобы у дубликата
      // на диске сразу была та же структура папок (нужно если у source
      // не дефолтный путь, например `www/public`).
      step(`Создание Linux-юзера "${ctx.newSystemUser}"`);
      const userRes = await this.agentRelay.emitToAgent('user:create', {
        username: ctx.newSystemUser,
        homeDir: ctx.newRootPath,
        password: ctx.newSshPassword,
        filesRelPath: (source as { filesRelPath?: string | null }).filesRelPath || undefined,
      });
      if (!userRes.success) throw new Error(`User create failed: ${userRes.error}`);
      log('info', `✓ Linux-юзер "${ctx.newSystemUser}" создан`);

      const phpEnabled = !!source.phpVersion;

      // 2) Nginx — собираем payload из source (для nginx-настроек) + override-ов
      // переименования (siteName/domain/rootPath/etc).
      // Перед созданием конфига регенерим meowbox-zones.conf — в нём должна
      // появиться зона `site_<newName>`, иначе nginx -t упадёт.
      await this.regenerateGlobalZones();
      step(`Nginx-конфиг для ${ctx.newDomain}`);
      const baseDup = buildNginxCreateConfigPayload(
        { ...source, aliases: '[]' } as unknown as Parameters<typeof buildNginxCreateConfigPayload>[0],
        false,
        null,
      );
      const nginxRes = await this.agentRelay.emitToAgent('nginx:create-config', {
        ...baseDup,
        siteName: ctx.newName,
        domain: ctx.newDomain,
        rootPath: ctx.newRootPath,
        filesRelPath: ctx.newFilesRelPath,
        systemUser: ctx.newSystemUser,
        appPort: null,
        sslEnabled: false,
      });
      if (!nginxRes.success) throw new Error(`Nginx failed: ${nginxRes.error}`);
      log('info', `✓ Nginx-конфиг создан`);

      // 3) PHP-FPM pool.
      if (phpEnabled) {
        step(`PHP-FPM пул (PHP ${source.phpVersion})`);
        const phpRes = await this.agentRelay.emitToAgent('php:create-pool', {
          siteName: ctx.newName,
          domain: ctx.newDomain,
          phpVersion: source.phpVersion as string,
          user: ctx.newSystemUser,
          rootPath: ctx.newRootPath,
          sslEnabled: false,
          customConfig: source.phpPoolCustom,
        });
        if (!phpRes.success) throw new Error(`PHP pool failed: ${phpRes.error}`);
        log('info', `✓ PHP-FPM пул создан`);

        // Per-user CLI-шим под скопированную версию PHP.
        await this.applyPhpShim({
          username: ctx.newSystemUser,
          homeDir: ctx.newRootPath,
          phpVersion: source.phpVersion,
        });
      }

      // 4) Копирование файлов (rsync source/www → new/www).
      step(`Копирование файлов сайта (rsync ${source.rootPath} → ${ctx.newRootPath})`);
      const copyRes = await this.agentRelay.emitToAgent('site:copy-files', {
        srcRoot: source.rootPath,
        dstRoot: ctx.newRootPath,
        dstUser: ctx.newSystemUser,
        relPath: ctx.newFilesRelPath,
      }, 600_000);
      if (!copyRes.success) {
        log('warn', `! Копирование файлов не удалось: ${copyRes.error}`);
      } else {
        log('info', `✓ Файлы сайта скопированы`);
      }

      // 5) Копирование БД.
      if (source.databases.length > 0) {
        const sourceDb = source.databases[0];
        const dbSafeName = ctx.newName.replace(/-/g, '_').substring(0, 64);
        const newDbUser = dbSafeName.substring(0, 32);
        const newDbPass = randomBytes(16).toString('base64url');
        const newDbPassHash = await hashPassword(newDbPass);
        const newDbPassEnc = encryptJson({ password: newDbPass });

        step(`Создание БД "${dbSafeName}" (${sourceDb.type})`);
        const dbCreateRes = await this.agentRelay.emitToAgent('db:create', {
          name: dbSafeName,
          type: sourceDb.type,
          dbUser: newDbUser,
          password: newDbPass,
        });
        if (!dbCreateRes.success) {
          log('warn', `! Создание БД не удалось: ${dbCreateRes.error}`);
        } else {
          log('info', `✓ БД "${dbSafeName}" создана`);
          await this.prisma.database.create({
            data: {
              name: dbSafeName,
              type: sourceDb.type as DatabaseType,
              dbUser: newDbUser,
              dbPasswordHash: newDbPassHash,
              dbPasswordEnc: newDbPassEnc,
              siteId: ctx.newSiteId,
            },
          });

          step(`Копирование данных БД "${sourceDb.name}" → "${dbSafeName}"`);
          const dbCopyRes = await this.agentRelay.emitToAgent('db:copy', {
            srcName: sourceDb.name,
            dstName: dbSafeName,
            type: sourceDb.type,
          }, 900_000);
          if (!dbCopyRes.success) {
            log('warn', `! Копирование данных БД: ${dbCopyRes.error}`);
          } else {
            log('info', `✓ Данные БД скопированы`);
          }
        }
      }

      // 6) BackupConfigs.
      if (ctx.copyBackupConfigs) {
        const configs = await this.prisma.backupConfig.findMany({
          where: { siteId: source.id },
        });
        if (configs.length > 0) {
          step(`Копирование настроек бэкапов (${configs.length})`);
          for (const c of configs) {
            const { id: _id, createdAt: _ca, updatedAt: _ua, siteId: _sid, ...rest } = c as unknown as Record<string, unknown> & { id: string; createdAt: Date; updatedAt: Date; siteId: string };
            void _id; void _ca; void _ua; void _sid;
            await this.prisma.backupConfig.create({
              data: {
                ...(rest as Prisma.BackupConfigUncheckedCreateInput),
                siteId: ctx.newSiteId,
              },
            }).catch((e) => {
              log('warn', `! Backup config skip: ${(e as Error).message}`);
            });
          }
          log('info', `✓ Настройки бэкапов скопированы`);
        }
      }

      // 7) CronJobs.
      if (ctx.copyCronJobs) {
        const crons = await this.prisma.cronJob.findMany({
          where: { siteId: source.id },
        });
        if (crons.length > 0) {
          step(`Копирование cron-задач (${crons.length})`);
          for (const c of crons) {
            const { id: _id, createdAt: _ca, updatedAt: _ua, siteId: _sid, lastRunAt: _lra, lastRunStatus: _lrs, lastRunOutput: _lro, ...rest } = c as unknown as Record<string, unknown> & {
              id: string; createdAt: Date; updatedAt: Date; siteId: string;
              lastRunAt: Date | null; lastRunStatus: string | null; lastRunOutput: string | null;
            };
            void _id; void _ca; void _ua; void _sid; void _lra; void _lrs; void _lro;
            await this.prisma.cronJob.create({
              data: {
                ...(rest as Prisma.CronJobUncheckedCreateInput),
                siteId: ctx.newSiteId,
              },
            }).catch((e) => {
              log('warn', `! Cron skip: ${(e as Error).message}`);
            });
          }
          log('info', `✓ Cron-задачи скопированы`);
        }
      }

      await this.prisma.site.update({
        where: { id: siteId },
        data: { status: SiteStatus.RUNNING, errorMessage: null },
      });
      log('info', `✓ Сайт "${ctx.newName}" успешно дублирован`);
      this.regenerateGlobalZones().catch(() => {});
      this.gateway.emitSiteProvisionDone(siteId, 'RUNNING');
    } catch (err) {
      const msg = (err as Error).message || 'unknown error';
      log('error', `✗ Дублирование провалилось: ${msg}`);
      await this.prisma.site.update({
        where: { id: siteId },
        data: { status: SiteStatus.ERROR, errorMessage: msg.substring(0, 2000) },
      }).catch(() => {});
      // Rollback: такой же сценарий, как в create() — сносим артефакты,
      // чтобы можно было попробовать ещё раз без конфликтов.
      await this.cleanupProvisioningArtifacts(siteId, {
        systemUser: ctx.newSystemUser,
        rootPath: ctx.newRootPath,
        safeName: ctx.newName,
        domain: ctx.newDomain,
        phpVersion: source.phpVersion ?? undefined,
        log,
      });
      this.gateway.emitSiteProvisionDone(siteId, 'ERROR', msg);
    }
  }

  /**
   * Фоновая часть создания сайта: системный юзер, nginx, FPM, БД, установка CMS, SSL.
   * Все шаги стримятся во фронт через WS: `site:provision:log` для каждой строки
   * и `site:provision:done` в конце (со статусом RUNNING / ERROR).
   */
  private async runProvisioningAsync(
    siteId: string,
    dto: CreateSiteDto,
    ctx: {
      systemUser: string;
      rootPath: string;
      filesRelPath: string;
      sshPassword: string;
      phpEnabled: boolean;
      dbEnabled: boolean;
      sslEnabled: boolean;
      httpsRedirect: boolean;
      safeName: string;
    },
  ): Promise<void> {
    const {
      systemUser, rootPath, filesRelPath, sshPassword,
      phpEnabled, dbEnabled, sslEnabled, httpsRedirect, safeName,
    } = ctx;

    const log = (level: 'info' | 'warn' | 'error', line: string) => {
      this.gateway.emitSiteProvisionLog(siteId, level, line);
      if (level === 'error') this.logger.error(line);
      else if (level === 'warn') this.logger.warn(line);
      else this.logger.log(line);
    };

    const step = (title: string) => {
      log('info', `▶ ${title}`);
    };

    try {
      // 0. Системный Linux-юзер (per-site isolation).
      // Прокидываем filesRelPath, чтобы агент сразу создал нужную вложенную
      // структуру (например `www/public` для front-controller паттернов),
      // а не только дефолтную `www/`.
      step(`Создание Linux-юзера "${systemUser}"`);
      const userResult = await this.agentRelay.emitToAgent('user:create', {
        username: systemUser,
        homeDir: rootPath,
        password: sshPassword,
        filesRelPath,
      });
      if (!userResult.success) {
        throw new Error(`System user creation failed: ${userResult.error}`);
      }
      log('info', `✓ Linux-юзер "${systemUser}" создан`);

      // Нормализуем алиасы для агента — всегда объекты {domain,redirect}.
      const aliasesForAgent: SiteAliasParsed[] = (dto.aliases || []).map((a) =>
        typeof a === 'string'
          ? { domain: a, redirect: false }
          : { domain: a.domain, redirect: a.redirect === true },
      );

      // 1. Nginx-конфиг — первая установка сайта.
      // customConfig инициализируется CMS-стартовым шаблоном (initialCustomConfigFor):
      // дальше юзер редактирует 95-custom.conf через UI; панель его не перетирает.
      // ВАЖНО: сперва регенерим meowbox-zones.conf, чтобы в нём была объявлена
      // shared-зона `site_<safeName>` для нового сайта. Иначе nginx -t упадёт
      // при первом включении конфига сайта с ошибкой
      // "zero size shared memory zone site_<safeName>".
      await this.regenerateGlobalZones();
      step(`Nginx: конфиг для ${dto.domain}`);
      const nginxResult = await this.agentRelay.emitToAgent('nginx:create-config', {
        siteName: safeName,
        siteType: dto.type,
        domain: dto.domain,
        aliases: aliasesForAgent,
        rootPath,
        filesRelPath,
        phpVersion: phpEnabled ? (dto.phpVersion || '8.2') : undefined,
        phpEnabled,
        appPort: dto.appPort,
        systemUser,
        sslEnabled,
        httpsRedirect,
        // settings опускаем — все поля БД пока null → агент возьмёт дефолты.
        customConfig: initialCustomConfigFor(dto.type),
      });
      if (!nginxResult.success) {
        throw new Error(`Nginx config creation failed: ${nginxResult.error}`);
      }
      log('info', `✓ Nginx-конфиг создан и перезагружен`);

      // 2. PHP-FPM pool (если PHP включён)
      if (phpEnabled) {
        step(`PHP-FPM пул (PHP ${dto.phpVersion || '8.2'})`);
        const phpResult = await this.agentRelay.emitToAgent('php:create-pool', {
          siteName: safeName,
          domain: dto.domain,
          phpVersion: dto.phpVersion || '8.2',
          user: systemUser,
          rootPath,
          // session.cookie_secure зависит от схемы: без SSL кука c Secure не
          // сохраняется в браузере и админка MODX/любой PHP-сайт зациклит
          // редирект на форму логина.
          sslEnabled,
          // На этапе провижининга custom-оверрайдов ещё нет (сайт только что
          // создан), но пробрасываем для консистентности.
          customConfig: null,
        });
        if (!phpResult.success) {
          throw new Error(`PHP-FPM pool creation failed: ${phpResult.error}`);
        }
        log('info', `✓ PHP-FPM пул создан`);

        // Per-user CLI-шим: `php` в SSH/SFTP юзера сайта = та же версия, что у FPM.
        await this.applyPhpShim({
          username: systemUser,
          homeDir: rootPath,
          phpVersion: dto.phpVersion || '8.2',
        });
        log('info', `✓ CLI-шим: php → /usr/bin/php${dto.phpVersion || '8.2'}`);
      }

      // 3. БД (если dbEnabled)
      let dbName: string | undefined;
      let dbUser: string | undefined;
      let dbPassword: string | undefined;
      let dbType: string | undefined;

      if (dbEnabled) {
        try {
          // Определяем движок: если dto указал — используем; иначе detect на агенте.
          let targetType: 'MARIADB' | 'MYSQL' | 'POSTGRESQL' | null = null;
          if (dto.dbType) {
            targetType = dto.dbType as 'MARIADB' | 'MYSQL' | 'POSTGRESQL';
          } else {
            const detectResult = await this.agentRelay.emitToAgent<{
              available: string[];
              preferred: string | null;
            }>('db:detect', {});
            if (detectResult.success && detectResult.data?.preferred) {
              targetType = detectResult.data.preferred as 'MARIADB' | 'MYSQL' | 'POSTGRESQL';
            }
          }

          if (!targetType) {
            log('warn', '! Ни одного движка БД не доступно, пропускаем создание БД');
          } else {
            // Имя БД/юзера БД = системное имя сайта (без префиксов db_/u_).
            // В MySQL/MariaDB дефисы в именах — допустимы только в backticks,
            // а в PG имена case-insensitive без "кавычек", поэтому заменяем "-" → "_".
            const dbSafeName = safeName.replace(/-/g, '_');
            dbName = (dto.dbName || dbSafeName).substring(0, 64);
            dbUser = (dto.dbUser || dbSafeName).substring(0, 32);
            dbPassword = dto.dbPassword || randomBytes(16).toString('base64url');
            step(`Создание ${targetType}-БД "${dbName}" / юзер "${dbUser}"`);
            dbType = targetType;

            const dbPasswordHash = await hashPassword(dbPassword);
            const dbPasswordEnc = encryptJson({ password: dbPassword });

            const prismaDbType =
              targetType === 'MARIADB' ? DatabaseType.MARIADB :
              targetType === 'MYSQL' ? DatabaseType.MYSQL :
              DatabaseType.POSTGRESQL;

            const dbRecord = await this.prisma.database.upsert({
              where: { name: dbName },
              update: {
                type: prismaDbType,
                dbUser,
                dbPasswordHash,
                dbPasswordEnc,
                siteId,
              },
              create: {
                name: dbName,
                type: prismaDbType,
                dbUser,
                dbPasswordHash,
                dbPasswordEnc,
                siteId,
              },
            });

            const dbResult = await this.agentRelay.emitToAgent('db:create', {
              name: dbName,
              type: dbType,
              dbUser,
              password: dbPassword,
            });

            if (!dbResult.success) {
              log('warn', `! Создание БД не удалось: ${dbResult.error}`);
              await this.prisma.database.delete({ where: { id: dbRecord.id } }).catch(() => {});
              dbName = undefined;
            } else {
              log('info', `✓ Создана ${targetType}-БД "${dbName}"`);
            }
          }
        } catch (dbErr) {
          log('warn', `! Ошибка при настройке БД: ${(dbErr as Error).message}`);
          dbName = undefined;
        }
      }

      // 4. Установка файлов сайта (MODX загрузка / CUSTOM скелет)
      if (!dto.skipInstall) {
        const adminUser = MODX_TYPES.includes(dto.type)
          ? (dto.cmsAdminUser || systemUser)
          : undefined;
        const adminPassword = MODX_TYPES.includes(dto.type)
          ? (dto.cmsAdminPassword || this.generatePassword(16))
          : undefined;
        const managerPath = dto.managerPath || 'manager';
        const connectorsPath = dto.connectorsPath || 'connectors';

        if (adminPassword) {
          await this.prisma.site.update({
            where: { id: siteId },
            data: {
              cmsAdminUser: adminUser,
              cmsAdminPasswordEnc: encryptCmsPassword(adminPassword),
              managerPath,
              connectorsPath,
            },
          });
        }

        if (MODX_TYPES.includes(dto.type)) {
          step(`Установка ${dto.type === 'MODX_3' ? 'MODX 3' : 'MODX Revolution'} ${dto.modxVersion || '(latest)'} — это может занять несколько минут`);
        } else {
          step(`Развёртывание файлов сайта`);
        }

        const installResult = await this.agentRelay.emitToAgent<{
          version?: string;
        }>('site:install', {
          siteId,
          siteType: dto.type,
          rootPath,
          filesRelPath,
          domain: dto.domain,
          phpVersion: phpEnabled ? (dto.phpVersion || '8.2') : undefined,
          modxVersion: dto.modxVersion,
          phpEnabled,
          appPort: dto.appPort,
          dbName,
          dbUser,
          dbPassword,
          dbType,
          adminUser,
          adminPassword,
          adminEmail: `admin@${dto.domain}`,
          systemUser,
          managerPath,
          connectorsPath,
        }, 1_200_000); // 20 минут: composer create-project + cli-install.php + setup

        if (!installResult.success) {
          // Для MODX (и любого другого CMS-типа в будущем) пустые файлы +
          // незаполненная БД = ERROR, не RUNNING. Раньше тут логировали
          // warn и шли дальше через SSL → status RUNNING — пользователь
          // видел "Сайт создан успешно" с пустым корнем сайта.
          // Для CUSTOM (просто скелет публичной директории) install не
          // должен падать в принципе — но если упал, тоже считаем ошибкой.
          throw new Error(`Установка файлов: ${installResult.error || 'неизвестная ошибка'}`);
        }
        log('info', `✓ Файлы сайта установлены`);

        // Сохраняем версию MODX (агент возвращает её через data.version).
        if (MODX_TYPES.includes(dto.type)) {
          const installedVersion = installResult.data?.version || dto.modxVersion;
          if (installedVersion) {
            await this.prisma.site.update({
              where: { id: siteId },
              data: { modxVersion: installedVersion },
            });
          }
        }

        // Сразу после установки триггерим первое измерение размера БД,
        // чтобы в UI не висел "0 байт" до ближайшего крона (30 минут).
        if (dbName && dbType && installResult.success) {
          try {
            const sizeRes = await this.agentRelay.emitToAgent<{ sizeBytes: number }>(
              'db:size',
              { name: dbName, type: dbType },
              30_000,
            );
            if (sizeRes.success && sizeRes.data?.sizeBytes !== undefined) {
              await this.prisma.database.updateMany({
                where: { name: dbName, siteId },
                data: { sizeBytes: BigInt(sizeRes.data.sizeBytes) },
              });
              log('info', `✓ Размер БД: ${sizeRes.data.sizeBytes} байт`);
            }
          } catch {
            /* не критично — через 30 мин обновит крон */
          }
        }
      } else {
        log('info', `⊘ Установка файлов пропущена (режим миграции)`);
      }

      // 5. SSL (Let's Encrypt) — если включён и домен публичный.
      // SAN включает основной домен + ВСЕ алиасы (включая redirect=true).
      // TLS-handshake идёт до ответа nginx, и без серта на алиасе браузер
      // показывает cert mismatch раньше, чем мы можем отдать 301-редирект.
      if (sslEnabled) {
        try {
          step(`Выпуск SSL Let's Encrypt для ${dto.domain}`);
          // Контракт `ssl:issue` (см. agent/src/ssl/ssl.manager.ts::IssueSslParams):
          //   { domain, domains, rootPath, filesRelPath?, email? }
          // Раньше тут летел сломанный payload (`aliases` вместо `domains`,
          // без rootPath/filesRelPath) — серт во время провижининга не выпускался.
          const sanAliases = aliasesForAgent.map((a) => a.domain);
          const sslResult = await this.agentRelay.emitToAgent('ssl:issue', {
            domain: dto.domain,
            domains: [dto.domain, ...sanAliases],
            rootPath,
            filesRelPath,
            email: `admin@${dto.domain}`,
          }, 180_000);
          if (!sslResult.success) {
            log('warn', `! SSL не выпущен: ${sslResult.error}`);
          } else {
            log('info', `✓ SSL выпущен`);
            // После выпуска SSL PHP-FPM pool нужно пересоздать, чтобы
            // cookie_secure включился и сессии работали по HTTPS.
            if (phpEnabled) {
              try {
                await this.agentRelay.emitToAgent('php:create-pool', {
                  siteName: safeName,
                  domain: dto.domain,
                  phpVersion: dto.phpVersion || '8.2',
                  user: systemUser,
                  rootPath,
                  sslEnabled: true,
                  customConfig: null,
                });
                log('info', `✓ PHP-FPM пул обновлён под HTTPS`);
              } catch (phpErr) {
                log('warn', `! PHP-FPM reload после SSL: ${(phpErr as Error).message}`);
              }
            }
          }
        } catch (sslErr) {
          log('warn', `! Ошибка SSL: ${(sslErr as Error).message}`);
        }
      }

      await this.prisma.site.update({
        where: { id: siteId },
        data: { status: SiteStatus.RUNNING, errorMessage: null },
      });

      log('info', `✓ Сайт "${dto.name}" создан успешно`);
      // Регенерация глобальных rate-limit zones (limit_req_zone на каждый сайт).
      this.regenerateGlobalZones().catch(() => {});
      this.gateway.emitSiteProvisionDone(siteId, 'RUNNING');
    } catch (err) {
      const msg = (err as Error).message || 'unknown error';
      log('error', `✗ Создание сайта провалилось: ${msg}`);

      await this.prisma.site.update({
        where: { id: siteId },
        data: { status: SiteStatus.ERROR, errorMessage: msg.substring(0, 2000) },
      }).catch(() => {});

      // ROLLBACK: best-effort чистка частично созданных артефактов. Идемпотентно —
      // каждый шаг обёрнут в .catch(), чтобы одна ошибка не ломала остальные.
      // До этого частично созданные юзеры/конфиги/pool'ы оставались на диске,
      // и повторное создание сайта падало на конфликте.
      await this.cleanupProvisioningArtifacts(siteId, {
        systemUser,
        rootPath,
        safeName,
        domain: dto.domain,
        phpVersion: dto.phpVersion,
        log,
      });

      this.gateway.emitSiteProvisionDone(siteId, 'ERROR', msg);
    }
  }

  /**
   * Rollback: сносит всё, что мог успеть создать провижининг, до того как
   * упал. Безопасно вызывать повторно (каждая операция идемпотентна на уровне
   * агента). После вызова БД остаётся в состоянии ERROR (не удаляется — фронт
   * показывает ошибку и кнопку "удалить" / "пересоздать").
   */
  private async cleanupProvisioningArtifacts(
    siteId: string,
    ctx: {
      systemUser: string;
      rootPath: string;
      safeName: string;
      domain: string;
      phpVersion?: string;
      log: (level: 'info' | 'warn' | 'error', line: string) => void;
    },
  ): Promise<void> {
    if (!this.agentRelay.isAgentConnected()) return;

    const { systemUser, rootPath, safeName, domain, phpVersion, log } = ctx;
    const tryAgent = async (event: string, payload: Record<string, unknown>) => {
      try {
        await this.agentRelay.emitToAgent(event, payload);
      } catch (e) {
        log('warn', `cleanup: ${event} failed: ${(e as Error).message}`);
      }
    };

    log('info', '▶ Откат частично созданных артефактов…');
    await tryAgent('nginx:remove-config', { siteName: safeName, domain });
    if (phpVersion) {
      await tryAgent('php:remove-pool', { siteName: safeName, domain, phpVersion });
    }
    await tryAgent('site:remove-files', { rootPath });
    await tryAgent('user:delete', { username: systemUser });
    log('info', '✓ Откат завершён (артефакты удалены, запись в БД сохранена со статусом ERROR)');
  }

  async update(id: string, dto: UpdateSiteDto, userId: string, role: string) {
    const site = await this.findById(id, userId, role);

    // Сюда складываем все домены, которые надо проверить на уровне nginx
    // (их конфиг НЕ принадлежит текущему сайту). Важно: текущий сайт занимает
    // свой собственный server_name в /etc/nginx/sites-enabled/<domain>.conf —
    // мимо него нас сканер и так не пустит. Поэтому проверяем только
    // новые домены (те, которых до этого не было у сайта).
    const nginxCheckDomains: string[] = [];

    if (dto.domain && dto.domain !== site.domain) {
      const conflict = await this.prisma.site.findFirst({
        where: {
          id: { not: id },
          OR: [
            { domain: dto.domain },
            { aliases: jsonArrayContains(dto.domain) },
          ],
        },
      });

      if (conflict) {
        throw new ConflictException(`Domain ${dto.domain} is already in use`);
      }
      nginxCheckDomains.push(dto.domain);
    }

    // Конфликт по алиасам: новый алиас не должен пересекаться с domain/alias
    // другого сайта. Используем текстовый substring-matching — он покрывает
    // оба формата (старый string[] и новый [{domain,redirect}]).
    if (dto.aliases !== undefined) {
      const newDomains = aliasDomains(dto.aliases);
      const oldDomains = new Set(
        aliasDomains((site as { aliases?: unknown }).aliases as never),
      );
      for (const d of newDomains) {
        const conflict = await this.prisma.site.findFirst({
          where: {
            id: { not: id },
            OR: [
              { domain: d },
              { aliases: jsonArrayContains(d) },
            ],
          },
          select: { name: true },
        });
        if (conflict) {
          throw new ConflictException(
            `Алиас "${d}" уже используется сайтом "${conflict.name}"`,
          );
        }
        // Добавляем в nginx-check только если это ДЕЙСТВИТЕЛЬНО новый домен —
        // иначе ложный алерт на конфиг этого же сайта.
        if (!oldDomains.has(d)) nginxCheckDomains.push(d);
      }
    }

    if (nginxCheckDomains.length > 0) {
      await this.ensureDomainFreeInNginx(nginxCheckDomains, site.domain as string);
    }

    const updatedRaw = await this.prisma.site.update({
      where: { id },
      omit: { sshPassword: true, sshPasswordEnc: true, cmsAdminPassword: true, cmsAdminPasswordEnc: true },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.domain !== undefined && { domain: dto.domain }),
        ...(dto.aliases !== undefined && { aliases: stringifySiteAliases(dto.aliases) }),
        ...(dto.phpVersion !== undefined && { phpVersion: dto.phpVersion }),
        ...(dto.httpsRedirect !== undefined && { httpsRedirect: dto.httpsRedirect }),
        ...(dto.gitRepository !== undefined && { gitRepository: dto.gitRepository }),
        ...(dto.deployBranch !== undefined && { deployBranch: dto.deployBranch }),
        ...(dto.appPort !== undefined && { appPort: dto.appPort }),
        ...(dto.envVars !== undefined && { envVars: JSON.stringify(dto.envVars) }),
        // backupExcludes/backupExcludeTables: лимиты применяем тут, до записи
        // в БД, чтобы исключить злоупотребления. Каждая строка ≤ 4096
        // символов, до 200 строк (макс ~800KB на поле в SQLite JSON).
        ...(dto.backupExcludes !== undefined && {
          backupExcludes: dto.backupExcludes.length > 0
            ? JSON.stringify(
                dto.backupExcludes
                  .map((s) => String(s).trim().slice(0, 4096))
                  .filter(Boolean)
                  .slice(0, 200),
              )
            : null,
        }),
        ...(dto.backupExcludeTables !== undefined && {
          backupExcludeTables: dto.backupExcludeTables.length > 0
            ? JSON.stringify(
                dto.backupExcludeTables
                  .map((s) => String(s).trim().slice(0, 4096))
                  .filter(Boolean)
                  .slice(0, 200),
              )
            : null,
        }),
        // filesRelPath — где лежат файлы относительно rootPath. Меняем строкой
        // в БД; физически папки на диске панель НЕ переносит (на совести
        // админа). Регенерация nginx + (при наличии PHP) php-fpm pool ниже.
        ...(dto.filesRelPath !== undefined && { filesRelPath: dto.filesRelPath.trim() }),
      },
    });
    const updated = mapSite(updatedRaw);

    const domainChanged = !!(dto.domain && dto.domain !== site.domain);

    // Сменили главный домен → Let's Encrypt сертификат становится
    // невалидным (он выпущен на старый CN). nginx продолжит серверить этот
    // серт с новым server_name, браузеры будут ругаться. Правильный фикс:
    // сбросить SSL в NONE, почистить пути в nginx (sslEnabled=false) и
    // предложить админу выпустить новый серт вручную из UI (ну или импортнуть).
    if (domainChanged) {
      await this.prisma.sslCertificate.updateMany({
        where: { siteId: id, status: { not: SslStatus.NONE } },
        data: {
          status: SslStatus.NONE,
          certPath: null,
          keyPath: null,
          issuedAt: null,
          expiresAt: null,
          daysRemaining: null,
          issuer: '',
        },
      });
      // Старый LE-серт удалять не будем — админ может захотеть вернуть
      // старый домен. Пусть лежит в /etc/letsencrypt/live до явного revoke.
      this.logger.log(`SSL записи сброшены для сайта ${id} после смены домена`);
    }

    // Вытаскиваем SSL-статус, чтобы передать в nginx-шаблон (для ssl-блока)
    // и в PHP pool (для cookie_secure).
    const sslCert = await this.prisma.sslCertificate.findUnique({
      where: { siteId: id },
      select: { status: true, certPath: true, keyPath: true },
    });
    const sslActive = !!(sslCert && sslCert.status === 'ACTIVE' && sslCert.certPath && sslCert.keyPath);

    // Список алиасов изменился? (сравниваем стабильный JSON)
    const aliasesChanged =
      dto.aliases !== undefined &&
      stringifySiteAliases(dto.aliases) !==
        stringifySiteAliases((site as { aliases?: unknown }).aliases as never);

    // Сменился ли web-root внутри homedir (filesRelPath).
    const filesRelPathChanged =
      dto.filesRelPath !== undefined &&
      dto.filesRelPath.trim() !== ((site as { filesRelPath?: string | null }).filesRelPath || 'www');

    if ((domainChanged || aliasesChanged || filesRelPathChanged) && this.agentRelay.isAgentConnected()) {
      // Имена nginx/php-fpm артефактов якорятся на Site.name (safeName =
      // Linux-юзер), а НЕ на домене. Поэтому смена главного домена:
      //   • НЕ пересоздаёт pool-файл PHP-FPM (ни имя, ни сокет не зависят от домена)
      //   • НЕ переименовывает /etc/nginx/sites-available/{...}.conf — файл живёт
      //     под siteName. Ниже создаём конфиг идемпотентно (перезаписывается
      //     поверх), внутри обновляется только server_name.
      // Смена filesRelPath тоже требует регенерации (root в 00-server.conf
      // собирается из rootPath/filesRelPath).
      try {
        await this.agentRelay.emitToAgent(
          'nginx:create-config',
          buildNginxCreateConfigPayload(updated, sslActive, sslCert),
        );
      } catch (err) {
        this.logger.error(`Nginx reconfig failed: ${(err as Error).message}`);
      }
    }

    // Если филипперемен сменился, а на сайте есть PHP — пересоздаём пул.
    // Кастомный php_admin_value/open_basedir в phpPoolCustom может содержать
    // абсолютный путь с filesRelPath; перегенерация подставит свежий путь.
    if (filesRelPathChanged && updated.phpVersion && this.agentRelay.isAgentConnected()) {
      try {
        await this.agentRelay.emitToAgent('php:create-pool', {
          siteName: updated.name,
          domain: updated.domain,
          phpVersion: updated.phpVersion,
          user: updated.systemUser,
          rootPath: updated.rootPath,
          sslEnabled: sslActive,
          customConfig: (updated as { phpPoolCustom?: string | null }).phpPoolCustom ?? null,
        });
      } catch (err) {
        this.logger.error(`PHP-FPM pool regen failed after filesRelPath change: ${(err as Error).message}`);
      }
    }

    if (
      dto.phpVersion &&
      dto.phpVersion !== site.phpVersion &&
      this.agentRelay.isAgentConnected()
    ) {
      try {
        if (site.phpVersion) {
          await this.agentRelay.emitToAgent('php:remove-pool', {
            siteName: updated.name,
            domain: updated.domain,
            phpVersion: site.phpVersion,
          });
        }
        await this.agentRelay.emitToAgent('php:create-pool', {
          siteName: updated.name,
          domain: updated.domain,
          phpVersion: dto.phpVersion,
          user: updated.systemUser,
          rootPath: updated.rootPath,
          sslEnabled: sslActive,
          // Сохраняем кастомные оверрайды при смене PHP-версии — иначе
          // пользовательская настройка теряется после первого же переключения.
          customConfig: (updated as { phpPoolCustom?: string | null }).phpPoolCustom ?? null,
        });
        if (!dto.domain || dto.domain === site.domain) {
          // PHP-версия меняет путь к сокету (в имени сокета — phpVersion),
          // поэтому nginx-конфиг тоже нужно перегенерить (fastcgi_pass).
          // Файл якорится на siteName — create-config идемпотентно перезаписывает.
          await this.agentRelay.emitToAgent(
            'nginx:create-config',
            buildNginxCreateConfigPayload(updated, sslActive, sslCert),
          );
        }
        this.logger.log(`PHP version changed: ${site.phpVersion} → ${dto.phpVersion} for site "${updated.name}"`);

        // Per-user CLI-шим: команда `php` в SSH/SFTP-сессии юзера → новая версия.
        await this.applyPhpShim({
          username: updated.systemUser,
          homeDir: updated.rootPath,
          phpVersion: dto.phpVersion,
        });

        // Critical: vendor/composer/platform_check.php зашивает PHP_VERSION_ID
        // той версии, под которой прошла установка. При смене PHP на другую
        // major/minor сайт падает с фаталом. Регенерируем autoload под новую версию.
        // Запускаем с логом через site:install:log → фронт увидит в обычном
        // provision-лог канале (если подписан по siteId).
        try {
          const regen = await this.agentRelay.emitToAgent<unknown>(
            'site:php-regenerate-composer',
            {
              siteId: id,
              domain: updated.domain,
              rootPath: updated.rootPath,
              filesRelPath: updated.filesRelPath,
              phpVersion: dto.phpVersion,
            },
            200_000,
          );
          if (!regen.success) {
            this.logger.warn(
              `Composer autoload regenerate failed for "${updated.name}" after PHP ${site.phpVersion}→${dto.phpVersion}: ${regen.error}`,
            );
          }
        } catch (regenErr) {
          this.logger.warn(
            `Composer autoload regenerate error for "${updated.name}": ${(regenErr as Error).message}`,
          );
        }
      } catch (err) {
        this.logger.error(`PHP version change failed: ${(err as Error).message}`);
      }
    }

    return updated;
  }

  async controlSite(id: string, userId: string, role: string, action: 'start' | 'stop' | 'restart') {
    const site = await this.prisma.site.findUnique({
      where: { id },
      select: { id: true, userId: true, name: true, domain: true, type: true, phpVersion: true, appPort: true, rootPath: true },
    });

    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    // С новой архитектурой site-control работает так:
    //  - если есть PHP — рестартуем FPM (или просто reload при stop тоже, потому что
    //    полностью остановить один сайт без остановки чужих нельзя через systemd);
    //  - для CUSTOM без PHP — просто reload nginx.
    if (site.phpVersion) {
      const phpVersion = site.phpVersion || '8.2';
      await this.agentRelay.emitToAgent('php:restart', { phpVersion });
    } else {
      await this.agentRelay.emitToAgent('nginx:reload', {});
    }

    const newStatus = action === 'stop' ? SiteStatus.STOPPED : SiteStatus.RUNNING;
    await this.prisma.site.update({
      where: { id },
      data: { status: newStatus },
    });

    this.logger.log(`Site "${site.name}" ${action} completed`);
  }

  async updateStatus(id: string, status: SiteStatus) {
    return this.prisma.site.update({
      where: { id },
      data: { status },
    });
  }

  async delete(
    id: string,
    userId: string,
    role: string,
    opts: {
      removeSslCertificate?: boolean;
      removeBackupsLocal?: boolean;
      removeBackupsRestic?: boolean;
      removeBackupsRemote?: boolean;
      removeDatabases?: boolean;
      removeFiles?: boolean;
      removeSystemUser?: boolean;
      removeNginxConfig?: boolean;
      removePhpPool?: boolean;
    } = {},
  ) {
    // Дефолты: всё true. Если вызвали без опций — поведение как раньше.
    const flags = {
      removeSslCertificate: opts.removeSslCertificate !== false,
      removeBackupsLocal: opts.removeBackupsLocal !== false,
      removeBackupsRestic: opts.removeBackupsRestic !== false,
      removeBackupsRemote: opts.removeBackupsRemote !== false,
      removeDatabases: opts.removeDatabases !== false,
      removeFiles: opts.removeFiles !== false,
      removeSystemUser: opts.removeSystemUser !== false,
      removeNginxConfig: opts.removeNginxConfig !== false,
      removePhpPool: opts.removePhpPool !== false,
    };

    const site = await this.findById(id, userId, role);

    const databases = await this.prisma.database.findMany({
      where: { siteId: id },
      select: { id: true, name: true, type: true, dbUser: true },
    });

    // SSL-сертификат (если был выпущен) — надо revoke + удалить из certbot,
    // иначе /etc/letsencrypt/live/DOMAIN/ остаётся сиротой, и через 90 дней
    // certbot на renew шумит в логи, а конфиг renewal/DOMAIN.conf — оркестратор.
    const ssl = await this.prisma.sslCertificate.findUnique({
      where: { siteId: id },
      select: { status: true },
    });

    // Все бэкапы сайта — включая удалённые копии (Yandex Disk, Mail.ru, restic).
    // Если не вычистить, они остаются висеть в хранилищах и жрут место/квоту.
    // storageLocation нужен для resticPassword и конфига remote storage.
    const backups = await this.prisma.backup.findMany({
      where: { siteId: id },
      include: { storageLocation: true },
    });

    if (this.agentRelay.isAgentConnected()) {
      try {
        // 1) SSL revoke.
        if (flags.removeSslCertificate && ssl && ssl.status !== 'NONE') {
          await this.agentRelay.emitToAgent('ssl:revoke', {
            domain: site.domain as string,
          }, 90_000).catch((err) => {
            this.logger.warn(`SSL revoke failed for "${site.domain}": ${(err as Error).message}`);
          });
        }

        // 2) Бэкапы — каждый тип включается своим флагом, можно оставить
        // на диске/в облаке даже если сайт удаляется.
        for (const b of backups) {
          try {
            if (b.engine === 'RESTIC' && b.resticSnapshotId && b.storageLocation?.resticPassword) {
              if (!flags.removeBackupsRestic) continue;
              const cfg = this.safeParseJsonObject(b.storageLocation.config);
              await this.agentRelay.emitToAgent('restic:delete-snapshot', {
                siteName: site.name,
                snapshotId: b.resticSnapshotId,
                storage: {
                  type: b.storageLocation.type,
                  config: cfg,
                  password: b.storageLocation.resticPassword,
                },
              }, 300_000).catch((err) => {
                this.logger.warn(`Restic snapshot delete failed (${b.id}): ${(err as Error).message}`);
              });
              continue;
            }
            if (b.storageType === 'LOCAL' && b.filePath) {
              if (!flags.removeBackupsLocal) continue;
              await this.agentRelay.emitToAgent('backup:delete-file', {
                filePath: b.filePath,
              }).catch((err) => {
                this.logger.warn(`Local backup file delete failed (${b.id}): ${(err as Error).message}`);
              });
              continue;
            }
            if (
              (b.storageType === 'YANDEX_DISK' || b.storageType === 'CLOUD_MAIL_RU') &&
              b.filePath && b.storageLocation
            ) {
              if (!flags.removeBackupsRemote) continue;
              const cfg = this.safeParseJsonObject(b.storageLocation.config);
              await this.agentRelay.emitToAgent('backup:delete-remote', {
                filePath: b.filePath,
                storageConfig: cfg,
              }, 60_000).catch((err) => {
                this.logger.warn(`Remote backup delete failed (${b.id}): ${(err as Error).message}`);
              });
              continue;
            }
          } catch (err) {
            this.logger.warn(`Backup cleanup error for ${b.id}: ${(err as Error).message}`);
          }
        }

        // 3) БД.
        if (flags.removeDatabases) {
          for (const db of databases) {
            await this.agentRelay.emitToAgent('db:drop', {
              name: db.name,
              type: db.type,
              dbUser: db.dbUser,
            }).catch((err) => {
              this.logger.warn(`DB drop failed for "${db.name}": ${(err as Error).message}`);
            });
          }
        }

        // 4) Nginx конфиг. Передаём и siteName, и domain — агент снесёт оба
        // варианта (новый и legacy), если они существуют.
        if (flags.removeNginxConfig) {
          await this.agentRelay.emitToAgent('nginx:remove-config', {
            siteName: site.name,
            domain: site.domain,
          });
        }

        // 5) PHP-FPM пул (оба варианта — новый по siteName, legacy по domain).
        if (flags.removePhpPool && site.phpVersion) {
          await this.agentRelay.emitToAgent('php:remove-pool', {
            siteName: site.name,
            domain: site.domain as string,
            phpVersion: site.phpVersion as string,
          });
        }

        // 6) Файлы сайта.
        if (flags.removeFiles && site.rootPath) {
          await this.agentRelay.emitToAgent('site:remove-files', {
            rootPath: site.rootPath,
          }).catch((err) => {
            this.logger.warn(`Site files cleanup failed: ${(err as Error).message}`);
          });
        }

        // 7) Linux-пользователь сайта.
        if (flags.removeSystemUser && site.systemUser) {
          await this.agentRelay.emitToAgent('user:delete', {
            username: site.systemUser,
          }).catch((err) => {
            this.logger.warn(`System user cleanup failed: ${(err as Error).message}`);
          });
        }

        this.logger.log(
          `Site "${site.name}" cleanup (flags=${JSON.stringify(flags)}, ssl=${ssl?.status || 'none'}, backups=${backups.length})`,
        );
      } catch (err) {
        this.logger.error(`Cleanup failed for "${site.name}": ${(err as Error).message}`);
      }
    }

    // Если БД не дропали в агенте (keep-флаг), всё равно удаляем записи DB
    // из мет-таблицы панели — иначе останутся осиротевшие записи, тянущие
    // пароли. Пользователь всё равно просил «удалить сайт».
    if (databases.length > 0) {
      await this.prisma.database.deleteMany({
        where: { id: { in: databases.map((d) => d.id) } },
      });
    }

    await this.prisma.site.delete({ where: { id } });

    // После удаления сайта — пересобираем zones-файл (без его записи).
    await this.regenerateGlobalZones().catch(() => {});
  }

  /**
   * Регенерирует глобальный `/etc/nginx/conf.d/meowbox-zones.conf` на агенте:
   * один `limit_req_zone` на сайт + legacy zone `site_limit` для backwards-compat.
   * Безопасно вызывать после create/delete/update сайта или при изменении
   * rate-limit настроек.
   */
  private async regenerateGlobalZones(): Promise<void> {
    if (!this.agentRelay.isAgentConnected()) return;
    try {
      const sites = await this.prisma.site.findMany({
        select: {
          name: true,
          nginxRateLimitEnabled: true,
          nginxRateLimitRps: true,
        },
      });
      const zones = sites.map((s) => ({
        siteName: s.name,
        rps: s.nginxRateLimitRps && s.nginxRateLimitRps > 0 ? s.nginxRateLimitRps : 30,
        enabled: s.nginxRateLimitEnabled !== false,
      }));
      await this.agentRelay.emitToAgent('nginx:write-global-zones', { zones });
    } catch (err) {
      this.logger.warn(`regenerateGlobalZones: ${(err as Error).message}`);
    }
  }

  /**
   * Разбор JSON-строки config из StorageLocation в плоский Record<string,string>.
   * Нужен в delete(), чтобы передать креды remote-хранилища в агент.
   */
  private safeParseJsonObject(raw: string | null | undefined): Record<string, string> {
    if (!raw) return {};
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return v as Record<string, string>;
      }
    } catch { /* ignore */ }
    return {};
  }

  async getSiteMetrics(id: string, userId: string, role: string) {
    const site = await this.prisma.site.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        systemUser: true,
        rootPath: true,
        type: true,
        phpVersion: true,
        appPort: true,
        domain: true,
      },
    });

    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    if (!site.systemUser) {
      return { cpuPercent: 0, memoryBytes: 0, diskBytes: 0, requestCount: 0 };
    }

    const result = await this.agentRelay.emitToAgent('site:metrics', {
      systemUser: site.systemUser,
      rootPath: site.rootPath,
      siteType: site.type,
      phpVersion: site.phpVersion,
      appPort: site.appPort,
      domain: site.domain,
    });

    if (!result.success) {
      return { cpuPercent: 0, memoryBytes: 0, diskBytes: 0, requestCount: 0 };
    }

    return result.data;
  }

  // ===========================================================================
  // PHP-FPM pool custom config (редактор пер-сайта, по аналогии с nginx-конфигом)
  // ===========================================================================

  /**
   * Возвращает редактируемый кусок pool-конфига (то, что пишет пользователь
   * в textarea) + текущий полностью сгенерированный pool-файл с диска агента
   * (read-only превью для ориентира).
   */
  async getPhpPoolConfig(id: string, userId: string, role: string) {
    const site = await this.prisma.site.findUnique({ where: { id } });
    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    if (!site.phpVersion) {
      throw new ConflictException('У сайта не настроен PHP — редактировать нечего');
    }

    const rendered = await this.agentRelay.emitToAgent<string | null>(
      'php:read-pool',
      { siteName: site.name, domain: site.domain, phpVersion: site.phpVersion },
    );

    return {
      custom: (site as { phpPoolCustom?: string | null }).phpPoolCustom ?? '',
      rendered: rendered.success ? (rendered.data ?? null) : null,
      phpVersion: site.phpVersion,
    };
  }

  /**
   * Сохраняет кастомный фрагмент + триггерит пересборку pool на агенте.
   * Пустая/пробельная строка считается сбросом — очищает поле в БД.
   * Агент валидирует новый конфиг: при ошибке `systemctl restart php*-fpm`
   * мы откатываемся к предыдущему содержимому и возвращаем 500.
   */
  async updatePhpPoolConfig(
    id: string,
    userId: string,
    role: string,
    customConfig: string,
  ) {
    const site = await this.prisma.site.findUnique({ where: { id } });
    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    if (!site.phpVersion) {
      throw new ConflictException('У сайта не настроен PHP — редактировать нечего');
    }

    // Панель от рута — никаких whitelist'ов и нянек. Что юзер написал, то и
    // уходит в pool-конфиг. Если сломает — агент откатит на предыдущую версию,
    // т.к. systemctl restart php-fpm упадёт и мы вернём 500 (см. ниже).
    const clean = (customConfig || '').trim();

    const dbValue = clean.length > 0 ? clean : null;

    await this.prisma.site.update({
      where: { id },
      data: { phpPoolCustom: dbValue },
    });

    if (this.agentRelay.isAgentConnected()) {
      // Найдём активный SSL для правильного cookie_secure.
      const ssl = await this.prisma.sslCertificate.findFirst({
        where: { siteId: id, status: 'ACTIVE' },
      });
      const sslActive = !!ssl;

      const phpResult = await this.agentRelay.emitToAgent('php:create-pool', {
        siteName: site.name,
        domain: site.domain,
        phpVersion: site.phpVersion,
        user: site.systemUser,
        rootPath: site.rootPath,
        sslEnabled: sslActive,
        customConfig: dbValue,
      });
      if (!phpResult.success) {
        // Откатим БД — чтобы не оставлять валидный DB-стейт с невалидным файлом
        await this.prisma.site.update({
          where: { id },
          data: { phpPoolCustom: (site as { phpPoolCustom?: string | null }).phpPoolCustom ?? null },
        });
        throw new InternalServerErrorException(
          `Не удалось применить PHP-конфиг: ${phpResult.error}`,
        );
      }
    }

    return { custom: dbValue ?? '' };
  }

  /**
   * Проверить, что домены не используются каким-либо nginx-конфигом ВНЕ meowbox
   * (например, ручной файл в /etc/nginx/sites-enabled). При конфликте агент
   * вернёт список файлов, где встретился server_name; бросаем 409.
   *
   * `ignoreOwnDomain` — если домен сайта сам по себе, его собственный конфиг
   * <domain>.conf, естественно, найдётся. Исключаем его по имени файла.
   */
  private async ensureDomainFreeInNginx(
    domains: string[],
    ignoreOwnDomain?: string,
  ): Promise<void> {
    if (!this.agentRelay.isAgentConnected()) {
      // Агент офлайн — пропускаем nginx-level check: проверка БД уже прошла,
      // а ронять создание сайта из-за недоступного агента жестоко.
      return;
    }
    const ignoreFiles = new Set<string>();
    if (ignoreOwnDomain) {
      ignoreFiles.add(`${ignoreOwnDomain}.conf`);
      ignoreFiles.add(ignoreOwnDomain);
    }
    for (const d of domains) {
      // Добавляем собственный конфиг сайта (если домен — новый primary,
      // его файла ещё нет, но на всякий случай).
      ignoreFiles.add(`${d}.conf`);
      ignoreFiles.add(d);

      let resp;
      try {
        resp = await this.agentRelay.emitToAgent<{
          hits: Array<{ file: string; line: string }>;
        }>('nginx:find-domain-usage', { domain: d }, 15_000);
      } catch {
        // timeout / agent offline — продолжаем без nginx-check
        continue;
      }
      const hits = resp.data?.hits || [];
      const external = hits.filter((h) => !ignoreFiles.has(h.file));
      if (external.length > 0) {
        const files = external.map((h) => h.file).join(', ');
        throw new ConflictException(
          `Домен "${d}" уже обслуживается nginx-конфигом: ${files}. ` +
            `Удали/перенастрой этот конфиг вручную перед добавлением домена в meowbox.`,
        );
      }
    }
  }
}
