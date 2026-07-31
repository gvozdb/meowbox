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
import { randomBytes, randomUUID } from 'crypto';
import { hashPassword } from '../common/crypto/argon2.helper';
import { encryptJson } from '../common/crypto/credentials-cipher';
import { encryptSshPassword, decryptSshPassword } from '../common/crypto/ssh-cipher';
import { encryptCmsPassword, decryptCmsPassword } from '../common/crypto/cms-cipher';
import { PrismaService } from '../common/prisma.service';
import { safeErrorMessage } from '@meowbox/shared';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { AgentGateway } from '../gateway/agent.gateway';
import { ConfigService } from '@nestjs/config';
import {
  CreateSiteRequestDto,
  UpdateSiteContainerDto,
  DuplicateSiteDto,
  DeleteSiteOptionsDto,
} from './sites.dto';
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
import { initialCustomConfigFor } from '@meowbox/shared';
import {
  buildMultiDomainNginxPayload,
  isNginxUsableSsl,
  serializeSiteDomain,
  nginxZoneName,
  type RawSiteForNginx,
} from './site-domains.helper';
import { SiteDomainsService } from './site-domains.service';
import {
  canonicalizeHostname,
  normalizeFilesRelPath,
  runtimeKeyForDomain,
  validateEnvVars,
} from './domain-validation';
import { OperationsService } from '../operations/operations.service';
import { SiteDuplicateService } from './site-duplicate.service';
import {
  createHostnameClaims,
  HOSTNAME_REGISTRY_LOCK,
  rethrowHostnameClaimConflict,
} from './hostname-registry';

/**
 * include-фрагмент: все основные домены сайта с их SSL-сертификатами,
 * отсортированные по position. Достаточно для `buildMultiDomainNginxPayload`
 * (тип `RawSiteForNginx`) и для сериализации `domains` в REST-ответах.
 */
const DOMAINS_WITH_SSL = {
  domains: {
    orderBy: { position: 'asc' as const },
    include: { sslCertificate: true },
  },
} satisfies Prisma.SiteInclude;

// Для MODX оба модуля (PHP + БД) включаются автоматически, вне зависимости от флагов в DTO.
const MODX_TYPES: string[] = ['MODX_REVO', 'MODX_3'];

interface SiteListOptions {
  userId: string;
  role: string;
  page?: number;
  perPage?: number;
  preset?: string;
  status?: string;
  search?: string;
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
    private readonly siteDomains: SiteDomainsService,
    private readonly operations: OperationsService,
    private readonly duplicateService: SiteDuplicateService,
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
      this.migratePhpCliShimsForAllSites().catch((err) => {
        this.logger.warn(
          `PHP CLI shim migration skipped: ${safeErrorMessage(err)}`,
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
        systemUser: { not: null },
        domains: {
          some: {
            isPrimary: true,
            phpVersion: { not: null },
          },
        },
      },
      select: {
        id: true,
        name: true,
        systemUser: true,
        rootPath: true,
        domains: {
          where: { isPrimary: true },
          select: { phpVersion: true },
          take: 1,
        },
      },
    });

    if (sites.length === 0) {
      this.logger.log('PHP shim migration: no PHP-enabled sites found');
      return { ok: 0, fail: 0, total: 0 };
    }

    let ok = 0;
    let fail = 0;
    for (const s of sites) {
      const phpVersion = s.domains[0]?.phpVersion;
      if (!phpVersion || !s.systemUser) continue;
      try {
        const res = await this.agentRelay.emitToAgent<{ success: boolean; error?: string }>(
          'user:setup-php-shim',
          {
            username: s.systemUser,
            homeDir: s.rootPath,
            phpVersion,
          },
          20_000,
        );
        if (res?.success) {
          ok++;
        } else {
          fail++;
          this.logger.warn(
            `PHP shim migration: "${s.name}" failed — ${safeErrorMessage(
              res?.error,
              'unknown',
              800,
            )}`,
          );
        }
      } catch (err) {
        fail++;
        this.logger.warn(
          `PHP shim migration: "${s.name}" error — ${safeErrorMessage(err)}`,
        );
      }
    }

    this.logger.log(
      `PHP shim migration done: ok=${ok} fail=${fail} total=${sites.length}`,
    );
    return { ok, fail, total: sites.length };
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
   * Случайная строка из [a-z], длина `length`. Используется для генерации
   * дефолтного префикса таблиц MODX (`[a-z]{7}_`) — лучше дефолтного `modx_`
   * с точки зрения скрытия движка и снижения шанса коллизии с другими БД,
   * если случайно подцепят чужую.
   */
  private generateRandomLower(length: number): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz';
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
          `PHP shim setup failed for "${params.username}" (php=${params.phpVersion ?? 'none'}): ${safeErrorMessage(
            res?.error,
            'unknown',
            800,
          )}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `PHP shim emit error for "${params.username}": ${safeErrorMessage(err)}`,
      );
    }
  }

  async findAll(options: SiteListOptions) {
    const {
      userId,
      role,
      page = 1,
      perPage = 20,
      preset,
      status,
      search,
    } = options;
    const take = Math.min(perPage, 100);
    const skip = (page - 1) * take;

    const where: Prisma.SiteWhereInput = {};

    if (role !== 'ADMIN') {
      where.userId = userId;
    }

    if (preset) {
      where.domains = { some: { preset } };
    }
    if (status) where.status = status as SiteStatus;
    if (search) {
      where.OR = [
        { name: { contains: search } },
        { displayName: { contains: search } },
        {
          domains: {
            some: {
              OR: [
                { domain: { contains: search } },
                { aliases: { contains: search } },
              ],
            },
          },
        },
      ];
    }

    const [sites, total] = await Promise.all([
      this.prisma.site.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        omit: { sshPasswordEnc: true },
        include: {
          ...DOMAINS_WITH_SSL,
          _count: { select: { databases: true, backups: true } },
        },
      }),
      this.prisma.site.count({ where }),
    ]);

    return {
      sites: sites.map((s) => this.serializeSite(s)),
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
      omit: { sshPasswordEnc: true },
      include: {
        ...DOMAINS_WITH_SSL,
        databases: {
          select: {
            id: true,
            siteDomainId: true,
            purpose: true,
            name: true,
            type: true,
            sizeBytes: true,
          },
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

    return this.serializeSite(site);
  }

  /**
   * Нормализует Site (Prisma) в REST-форму. Добавляет:
   *  - `domains: SiteDomain[]` — все основные домены с их SSL (serializeSiteDomain);
   *  - legacy `sslCertificate` — сертификат ГЛАВНОГО домена (обратная
   *    совместимость со старым single-domain клиентом / кодом).
   *
   * Принимает запись, загруженную с `include: DOMAINS_WITH_SSL`.
   */
  private serializeSite(site: unknown): Record<string, unknown> {
    const s = site as Record<string, unknown>;
    const mapped = mapSite(
      s as Parameters<typeof mapSite>[0],
    ) as unknown as Record<string, unknown>;
    delete mapped.aliases;
    delete mapped.envVars;
    delete mapped.sshPasswordEnc;
    const rawDomains = Array.isArray(s.domains)
      ? (s.domains as Array<Record<string, unknown>>)
      : [];
    mapped.domains = rawDomains.map((d) =>
      serializeSiteDomain({
        ...(d as unknown as Parameters<typeof serializeSiteDomain>[0]),
        siteId: s.id as string,
      }),
    );
    const primary = rawDomains.find((d) => d.isPrimary === true);
    mapped.primaryDomain = primary
      ? serializeSiteDomain({
          ...(primary as unknown as Parameters<typeof serializeSiteDomain>[0]),
          siteId: s.id as string,
        })
      : null;
    const presetCounts: Record<string, number> = {};
    for (const domain of rawDomains) {
      const preset = typeof domain.preset === 'string' ? domain.preset : 'CUSTOM';
      presetCounts[preset] = (presetCounts[preset] || 0) + 1;
    }
    mapped.presetCounts = presetCounts;
    return mapped;
  }

  /** Site-level SSH/SFTP credentials. CMS credentials are domain-scoped. */
  async getSshCredentials(id: string, userId: string, role: string) {
    const site = await this.prisma.site.findUnique({
      where: { id },
      select: {
        id: true, userId: true, systemUser: true,
        sshPasswordEnc: true,
        rootPath: true,
      },
    });

    if (!site) {
      throw new NotFoundException('Site not found');
    }

    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied to this site');
    }

    const sshPlain = site.sshPasswordEnc ? this.tryDecryptSsh(site.sshPasswordEnc, id) : null;
    return {
      username: site.systemUser,
      password: sshPlain,
      host: 'server',
      port: 22,
      homeDir: site.rootPath,
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

    await this.prisma.site.update({
      where: { id },
      data: { sshPasswordEnc: encryptSshPassword(password) },
    });

    this.logger.log(`SSH password changed for site "${site.name}"`);
    return { password };
  }

  async create(
    dto: CreateSiteRequestDto,
    userId: string,
    idempotencyKey?: string,
    options: { allowImportReservation?: boolean } = {},
  ) {
    const reservationDomains = dto.domains.filter(
      (domain) => domain.skipInstall === true,
    );
    if (reservationDomains.length > 0) {
      if (!options.allowImportReservation) {
        throw new ForbiddenException(
          'skipInstall is reserved for authenticated server-to-server migration',
        );
      }
      if (reservationDomains.length !== dto.domains.length) {
        throw new ConflictException(
          'Migration reservation must include every domain application',
        );
      }
    }
    const operation = await this.operations.begin({
      idempotencyKey,
      type: 'SITE_CREATE',
      globalLockKey: HOSTNAME_REGISTRY_LOCK,
      userId,
      request: dto,
    });
    if (operation.replayed) {
      const site = operation.siteId
        ? await this.findById(operation.siteId, userId, 'ADMIN').catch(
            () => null,
          )
        : null;
      return {
        ...(site && typeof site === 'object' ? site : {}),
        operationId: operation.id,
        operationStatus: operation.status,
      };
    }

    await this.operations.start(operation.id, 'reserve');
    try {
      return await this.createDomainCentricSite(dto, userId, operation.id);
    } catch (error) {
      await this.operations.fail(operation.id, error);
      throw error;
    }
  }

  private async createDomainCentricSite(
    dto: CreateSiteRequestDto,
    userId: string,
    operationId: string,
  ) {
    if (isReservedSiteName(dto.name)) {
      throw new ConflictException(`Name "${dto.name}" is reserved by the system`);
    }
    const existingName = await this.prisma.site.findUnique({
      where: { name: dto.name },
      select: { id: true },
    });
    if (existingName) {
      throw new ConflictException(`Site name "${dto.name}" is already taken`);
    }

    const occupied = new Set<string>();
    const domains = dto.domains.map((input, position) => {
      let domain: string;
      let filesRelPath: string;
      let envVars: Record<string, string>;
      try {
        domain = canonicalizeHostname(input.domain);
        filesRelPath = normalizeFilesRelPath(input.filesRelPath);
        envVars = validateEnvVars(input.envVars);
      } catch (error) {
        throw new ConflictException((error as Error).message);
      }
      const aliases = (input.aliases || []).map((alias) => {
        const raw = typeof alias === 'string' ? alias : alias.domain;
        const canonical = canonicalizeHostname(raw);
        return {
          domain: canonical,
          redirect: typeof alias === 'string' ? false : alias.redirect === true,
        };
      });
      for (const hostname of [domain, ...aliases.map((alias) => alias.domain)]) {
        if (occupied.has(hostname)) {
          throw new ConflictException(
            `Hostname "${hostname}" is duplicated in the request`,
          );
        }
        occupied.add(hostname);
      }
      if (
        (input.preset === SiteType.MODX_REVO ||
          input.preset === SiteType.MODX_3) &&
        input.dbType === DatabaseType.POSTGRESQL
      ) {
        throw new ConflictException('MODX requires MariaDB or MySQL');
      }
      const id = randomUUID();
      return {
        id,
        position,
        input,
        domain,
        aliases,
        filesRelPath,
        envVars,
        runtimeKey: position === 0 ? dto.name : runtimeKeyForDomain(id),
      };
    });

    for (const hostname of occupied) {
      const conflict = await this.prisma.siteDomain.findFirst({
        where: {
          OR: [
            { domain: hostname },
            { aliases: jsonArrayContains(hostname) },
          ],
        },
        include: { site: { select: { name: true } } },
      });
      if (conflict) {
        throw new ConflictException(
          `Hostname "${hostname}" is already used by site "${conflict.site.name}"`,
        );
      }
    }
    await this.ensureDomainFreeInNginx([...occupied]);

    const { basePath } = await this.resolvePathDefaults();
    const rootPath = `${basePath}/${dto.name}`;
    const systemUser = dto.name;
    const nginxConfigPath = `/etc/nginx/sites-available/${dto.name}.conf`;
    const sshPassword = randomBytes(16).toString('base64url');
    const sshPasswordEnc = encryptSshPassword(sshPassword);

    const site = await this.prisma.$transaction(async (tx) => {
      const created = await tx.site.create({
        data: {
          name: dto.name,
          displayName: dto.displayName?.trim() || null,
          status: SiteStatus.DEPLOYING,
          errorMessage: null,
          rootPath,
          nginxConfigPath,
          systemUser,
          sshPasswordEnc,
          metadata: dto.metadata ? JSON.stringify(dto.metadata) : null,
          userId,
        },
      });

      for (const domain of domains) {
        const isModx =
          domain.input.preset === SiteType.MODX_REVO ||
          domain.input.preset === SiteType.MODX_3;
        const storedAliases = stringifySiteAliases(domain.aliases);
        await tx.siteDomain.create({
          data: {
            id: domain.id,
            siteId: created.id,
            domain: domain.domain,
            aliases: storedAliases,
            isPrimary: domain.position === 0,
            position: domain.position,
            preset: domain.input.preset,
            appStatus: 'PROVISIONING',
            appErrorMessage: null,
            filesRelPath: domain.filesRelPath,
            phpVersion: isModx
              ? domain.input.phpVersion || '8.2'
              : domain.input.phpVersion || null,
            phpPoolCustom: domain.input.phpPoolCustom?.trim() || null,
            runtimeKey: domain.runtimeKey,
            gitRepository: domain.input.gitRepository?.trim() || null,
            deployBranch: domain.input.deployBranch?.trim() || 'main',
            envVars: JSON.stringify(domain.envVars),
            cmsAdminUser: isModx
              ? domain.input.cmsAdminUser?.trim() || systemUser
              : null,
            managerPath: isModx
              ? domain.input.managerPath?.trim() || 'manager'
              : null,
            connectorsPath: isModx
              ? domain.input.connectorsPath?.trim() || 'connectors'
              : null,
            cmsTablePrefix: isModx
              ? domain.input.cmsTablePrefix || `${this.generateRandomLower(7)}_`
              : null,
            modxVersion: isModx ? domain.input.modxVersion || null : null,
            appPort: null,
            httpsRedirect: domain.input.httpsRedirect !== false,
            nginxCustomConfig: initialCustomConfigFor(domain.input.preset),
          },
        });
        await createHostnameClaims(tx, {
          siteDomainId: domain.id,
          domain: domain.domain,
          aliases: storedAliases,
        });
        await tx.sslCertificate.create({
          data: {
            siteId: created.id,
            domainId: domain.id,
            domains: stringifyStringArray([
              domain.domain,
              ...domain.aliases.map((alias) => alias.domain),
            ]),
            status: SslStatus.NONE,
            issuer: '',
          },
        });
      }
      await this.operations.attachCreatedSiteScope(tx, operationId, {
        siteId: created.id,
      });
      return created;
    }).catch(rethrowHostnameClaimConflict);
    const domainOperations: Array<{
      id: string;
      input: CreateSiteRequestDto['domains'][number];
      operationId: string;
    }> = [];
    try {
      for (const domain of domains) {
        const child = await this.operations.begin({
          idempotencyKey: `${operationId}:${domain.id}`,
          type: 'DOMAIN_PROVISION',
          siteId: site.id,
          siteDomainId: domain.id,
          parentOperationId: operationId,
          userId,
          request: {
            siteDomainId: domain.id,
            preset: domain.input.preset,
          },
        });
        if (!child.replayed) {
          await this.operations.start(child.id, 'waiting-for-container');
        }
        domainOperations.push({
          id: domain.id,
          input: domain.input,
          operationId: child.id,
        });
      }
    } catch (error) {
      const message = safeErrorMessage(
        error,
        'Failed to reserve domain operations',
      );
      await Promise.all(
        domainOperations.map((domain) =>
          this.operations.fail(domain.operationId, error).catch(() => undefined),
        ),
      );
      await this.prisma.$transaction([
        this.prisma.site.update({
          where: { id: site.id },
          data: { status: SiteStatus.ERROR, errorMessage: message },
        }),
        this.prisma.siteDomain.updateMany({
          where: { siteId: site.id, appStatus: 'PROVISIONING' },
          data: { appStatus: 'ERROR', appErrorMessage: message },
        }),
      ]);
      throw error;
    }
    await this.operations.step(operationId, 'create-container', 10);

    this.runInitialContainerProvisioning(
      site.id,
      {
        siteName: dto.name,
        systemUser,
        rootPath,
        sshPassword,
        domains: domainOperations,
      },
      operationId,
    ).catch((error) => {
      this.logger.error(
        `Unhandled initial provisioning failure for "${dto.name}": ${safeErrorMessage(
          error,
        )}`,
      );
    });

    const result = await this.findById(site.id);
    return {
      ...(result && typeof result === 'object' ? result : {}),
      operationId,
      operationStatus: 'RUNNING',
    };
  }

  private async runInitialContainerProvisioning(
    siteId: string,
    context: {
      siteName: string;
      systemUser: string;
      rootPath: string;
      sshPassword: string;
      domains: Array<{
        id: string;
        input: CreateSiteRequestDto['domains'][number];
        operationId: string;
      }>;
    },
    operationId: string,
  ): Promise<void> {
    const log = (level: 'info' | 'warn' | 'error', line: string) => {
      this.gateway.emitSiteProvisionLog(siteId, level, line);
      if (level === 'error') this.logger.error(line);
      else if (level === 'warn') this.logger.warn(line);
      else this.logger.log(line);
    };

    try {
      const user = await this.agentRelay.emitToAgent('user:create', {
        operationId,
        username: context.systemUser,
        homeDir: context.rootPath,
        password: context.sshPassword,
        filesRelPath: context.domains[0]?.input.filesRelPath,
      });
      if (!user.success) {
        throw new Error(`System user creation failed: ${user.error}`);
      }

      const importReservation = context.domains.every(
        (domain) => domain.input.skipInstall === true,
      );
      if (!importReservation) {
        await this.siteDomains.regenerateGlobalZones();
        await this.siteDomains.regenerateNginx(siteId);
      }

      let failures = 0;
      for (const [index, domain] of context.domains.entries()) {
        try {
          await this.operations.step(
            operationId,
            `provision-domain:${domain.id}`,
            20 + Math.floor((70 * index) / context.domains.length),
          );
          await this.operations.step(
            domain.operationId,
            'provision',
            5,
          );
          log('info', `▶ Provisioning ${domain.input.domain}`);
          await this.siteDomains.provisionDomainApplication(
            siteId,
            domain.id,
            domain.input,
            domain.operationId,
          );
          await this.operations.succeed(domain.operationId, {
            siteDomainId: domain.id,
          });
          log('info', `✓ ${domain.input.domain} is ready`);
        } catch (error) {
          failures += 1;
          const message = safeErrorMessage(error, 'Unknown error');
          await this.operations
            .fail(domain.operationId, error)
            .catch(() => undefined);
          await this.prisma.siteDomain.update({
            where: { id: domain.id },
            data: {
              appStatus: 'ERROR',
              appErrorMessage: message,
            },
          });
          log('error', `✗ ${domain.input.domain}: ${message}`);
        }
      }

      await this.prisma.site.update({
        where: { id: siteId },
        data: { status: SiteStatus.RUNNING, errorMessage: null },
      });
      if (failures > 0) {
        await this.operations.fail(
          operationId,
          new Error(`${failures} domain application(s) failed provisioning`),
        );
      } else {
        await this.operations.succeed(operationId, { siteId });
      }
      this.gateway.emitSiteProvisionDone(siteId, SiteStatus.RUNNING);
    } catch (error) {
      const message = safeErrorMessage(error, 'Unknown container error');
      await Promise.all(
        context.domains.map((domain) =>
          this.operations
            .fail(domain.operationId, error)
            .catch(() => undefined),
        ),
      );
      await this.prisma.site.update({
        where: { id: siteId },
        data: {
          status: SiteStatus.ERROR,
          errorMessage: message,
        },
      });
      await this.prisma.siteDomain.updateMany({
        where: { siteId, appStatus: 'PROVISIONING' },
        data: {
          appStatus: 'ERROR',
          appErrorMessage: message,
        },
      });
      await this.operations.fail(operationId, error);
      log('error', `✗ Site container provisioning failed: ${message}`);
      this.gateway.emitSiteProvisionDone(siteId, SiteStatus.ERROR, message);
    }
  }

  // ===========================================================================
  // Дублирование выбранного доменного приложения в новый Site
  // ===========================================================================

  async duplicate(
    sourceId: string,
    dto: DuplicateSiteDto,
    userId: string,
    role: string,
    idempotencyKey?: string,
  ) {
    const { basePath } = await this.resolvePathDefaults();
    const operation = await this.duplicateService.duplicate(
      sourceId,
      dto,
      userId,
      role,
      idempotencyKey,
      `${basePath}/${dto.name}`,
    );
    const site = operation.siteId
      ? await this.findById(operation.siteId, userId, role).catch(() => null)
      : null;
    return {
      ...(site && typeof site === 'object' ? site : {}),
      operationId: operation.operationId,
      operationStatus: operation.operationStatus,
    };
  }

  async update(
    id: string,
    dto: UpdateSiteContainerDto,
    userId: string,
    role: string,
  ) {
    return this.updateContainerSite(id, dto, userId, role);
  }

  private async updateContainerSite(
    id: string,
    dto: UpdateSiteContainerDto,
    userId: string,
    role: string,
  ) {
    const site = await this.prisma.site.findUnique({
      where: { id },
      select: { id: true, userId: true },
    });
    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    const normalizeList = (values: string[] | undefined) =>
      values === undefined
        ? undefined
        : values
            .map((value) => value.trim())
            .filter(Boolean)
            .slice(0, 200);

    await this.prisma.site.update({
      where: { id },
      data: {
        ...(dto.displayName !== undefined && {
          displayName: dto.displayName?.trim() || null,
        }),
        ...(dto.metadata !== undefined && {
          metadata: dto.metadata ? JSON.stringify(dto.metadata) : null,
        }),
        ...(dto.backupExcludes !== undefined && {
          backupExcludes: JSON.stringify(
            normalizeList(dto.backupExcludes) || [],
          ),
        }),
        ...(dto.backupExcludeTables !== undefined && {
          backupExcludeTables: JSON.stringify(
            normalizeList(dto.backupExcludeTables) || [],
          ),
        }),
      },
    });

    return this.findById(id, userId, role);
  }

  async controlSite(id: string, userId: string, role: string, action: 'start' | 'stop' | 'restart') {
    const site = await this.prisma.site.findUnique({
      where: { id },
      select: { id: true, userId: true, name: true },
    });

    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    if (!this.agentRelay.isAgentConnected()) {
      throw new InternalServerErrorException('Агент не подключён');
    }

    await this.applySiteNginxState(id, action === 'stop');

    const newStatus = action === 'stop' ? SiteStatus.STOPPED : SiteStatus.RUNNING;
    await this.prisma.site.update({
      where: { id },
      data: { status: newStatus, errorMessage: null },
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
    opts: DeleteSiteOptionsDto,
    idempotencyKey?: string,
  ) {
    return this.deleteContainerSite(
      id,
      userId,
      role,
      opts,
      idempotencyKey,
    );
  }

  private async deleteContainerSite(
    id: string,
    userId: string,
    role: string,
    opts: DeleteSiteOptionsDto,
    idempotencyKey?: string,
  ) {
    if (role !== 'ADMIN') {
      throw new ForbiddenException('Only administrators can delete sites');
    }

    const site = await this.prisma.site.findUnique({
      where: { id },
      include: {
        domains: {
          orderBy: { position: 'asc' },
          include: {
            sslCertificate: true,
            databases: true,
          },
        },
        backups: {
          select: {
            id: true,
            filePath: true,
            resticSnapshotId: true,
          },
        },
      },
    });
    if (!site) {
      throw new NotFoundException('Site not found');
    }
    if (site.userId !== userId && role !== 'ADMIN') {
      throw new ForbiddenException('Access denied');
    }
    if (
      opts.confirmSiteName !== site.name ||
      opts.confirmDataDeletion !== true
    ) {
      throw new ConflictException(
        'Site name and irreversible data-deletion confirmation are required',
      );
    }
    if (
      site.domains.some((domain) =>
        ['PROVISIONING', 'DEPLOYING', 'UPDATING'].includes(domain.appStatus),
      )
    ) {
      throw new ConflictException(
        'One or more domain applications are busy; retry after they finish',
      );
    }

    const physicalBackups = site.backups.filter(
      (backup) => backup.filePath || backup.resticSnapshotId,
    );
    if (physicalBackups.length > 0) {
      throw new ConflictException(
        `Site has ${physicalBackups.length} backup artifact(s); export or delete them explicitly before deleting the site`,
      );
    }
    if (!this.agentRelay.isAgentConnected()) {
      throw new ConflictException(
        'Agent is offline; destructive site deletion is unavailable',
      );
    }

    const operation = await this.operations.begin({
      idempotencyKey,
      type: 'SITE_DELETE',
      siteId: site.id,
      globalLockKey: HOSTNAME_REGISTRY_LOCK,
      userId,
      request: {
        confirmSiteName: site.name,
        confirmDataDeletion: true,
      },
    });
    if (operation.replayed) {
      return {
        operationId: operation.id,
        operationStatus: operation.status,
        result: operation.result,
      };
    }
    await this.operations.start(operation.id, 'snapshot');
    const deleteOperationId = operation.id;
    await this.prisma.siteDomain.updateMany({
      where: { siteId: site.id },
      data: {
        appStatus: 'UPDATING',
        appErrorMessage: null,
      },
    });

    try {
      for (const domain of site.domains) {
        const snapshot = await this.agentRelay.emitToAgent<{
          snapshotPath?: string;
        }>(
          'application:snapshot',
          {
            operationId: `${deleteOperationId}-${domain.id}`,
            siteName: site.name,
            siteDomainId: domain.id,
            runtimeKey: domain.runtimeKey,
            rootPath: site.rootPath,
            filesRelPath: domain.filesRelPath,
            databases: domain.databases.map((database) => ({
              name: database.name,
              type: database.type,
            })),
          },
          900_000,
        );
        if (!snapshot.success || !snapshot.data?.snapshotPath) {
          throw new Error(
            `Snapshot failed for ${domain.domain}: ${
              snapshot.error || 'no snapshot produced'
            }`,
          );
        }
      }

      await this.operations.step(operation.id, 'remove-runtime', 35);
      for (const domain of site.domains) {
        if (
          domain.sslCertificate &&
          domain.sslCertificate.status !== SslStatus.NONE
        ) {
          const revoked = await this.agentRelay.emitToAgent(
            'ssl:revoke',
            {
              operationId: `${deleteOperationId}-ssl-${domain.id}`,
              domain: domain.domain,
            },
            90_000,
          );
          if (!revoked.success) {
            throw new Error(
              `SSL revoke failed for ${domain.domain}: ${revoked.error}`,
            );
          }
        }
      }

      for (const domain of site.domains) {
        if (!domain.phpVersion) continue;
        const removed = await this.agentRelay.emitToAgent('php:remove-pool', {
          operationId: `${deleteOperationId}-php-${domain.id}`,
          siteDomainId: domain.id,
          runtimeKey: domain.runtimeKey,
          phpVersion: domain.phpVersion,
        });
        if (!removed.success) {
          throw new Error(
            `PHP pool removal failed for ${domain.domain}: ${removed.error}`,
          );
        }
      }

      for (const domain of site.domains) {
        for (const database of domain.databases) {
          const dropped = await this.agentRelay.emitToAgent('db:drop', {
            operationId: `${deleteOperationId}-db-${database.id}`,
            name: database.name,
            type: database.type,
            dbUser: database.dbUser,
          });
          if (!dropped.success) {
            throw new Error(
              `Database deletion failed for ${database.name}: ${dropped.error}`,
            );
          }
        }
      }

      const nginx = await this.agentRelay.emitToAgent(
        'nginx:remove-config',
        {
          operationId: `${deleteOperationId}-nginx`,
          siteName: site.name,
          domains: site.domains.map((domain) => domain.domain),
        },
      );
      if (!nginx.success) {
        throw new Error(`Nginx cleanup failed: ${nginx.error}`);
      }

      const files = await this.agentRelay.emitToAgent('site:remove-files', {
        operationId: `${deleteOperationId}-files`,
        rootPath: site.rootPath,
      });
      if (!files.success) {
        throw new Error(`Site files cleanup failed: ${files.error}`);
      }

      if (site.systemUser) {
        const user = await this.agentRelay.emitToAgent('user:delete', {
          operationId: `${deleteOperationId}-user`,
          username: site.systemUser,
        });
        if (!user.success) {
          throw new Error(`System user cleanup failed: ${user.error}`);
        }
      }

      await this.prisma.$transaction(async (tx) => {
        await tx.database.deleteMany({ where: { siteId: site.id } });
        await tx.site.delete({ where: { id: site.id } });
      });
      await this.regenerateGlobalZones();
      const result = { deletedSiteId: site.id, siteName: site.name };
      await this.operations.succeed(operation.id, result);
      return {
        operationId: operation.id,
        operationStatus: 'SUCCEEDED',
        result,
      };
    } catch (error) {
      const message = safeErrorMessage(error, 'Site deletion failed');
      await this.prisma.siteDomain
        .updateMany({
          where: { siteId: site.id },
          data: {
            appStatus: 'ERROR',
            appErrorMessage: message,
          },
        })
        .catch(() => undefined);
      await this.operations.fail(operation.id, error);
      throw new InternalServerErrorException(message);
    }
  }

  /**
   * Регенерирует глобальный `/etc/nginx/conf.d/meowbox-zones.conf` на агенте:
   * один `limit_req_zone` на КАЖДЫЙ основной домен (`SiteDomain`) среди всех
   * сайтов. Имя зоны — `nginxZoneName(domainId)` (то же, что в payload
   * `nginx:create-config`). Безопасно вызывать после create/delete/update.
   */
  private async regenerateGlobalZones(): Promise<void> {
    if (!this.agentRelay.isAgentConnected()) return;
    try {
      const domains = await this.prisma.siteDomain.findMany({
        select: {
          id: true,
          nginxRateLimitEnabled: true,
          nginxRateLimitRps: true,
        },
      });
      const zones = domains.map((d) => ({
        zoneName: nginxZoneName(d.id),
        rps: d.nginxRateLimitRps && d.nginxRateLimitRps > 0 ? d.nginxRateLimitRps : 30,
        enabled: d.nginxRateLimitEnabled !== false,
      }));
      await this.agentRelay.emitToAgent('nginx:write-global-zones', { zones });
    } catch (err) {
      this.logger.warn(`regenerateGlobalZones: ${safeErrorMessage(err)}`);
    }
  }

  private async applySiteNginxState(siteId: string, stopped: boolean): Promise<void> {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      include: DOMAINS_WITH_SSL,
    });
    if (!site) throw new NotFoundException('Site not found');
    await this.emitSiteNginxConfig(site as unknown as RawSiteForNginx & { status?: string }, stopped);
  }

  private async emitSiteNginxConfig(
    site: RawSiteForNginx & { status?: string },
    stoppedOverride?: boolean,
    timeoutMs?: number,
  ): Promise<void> {
    const stopped = stoppedOverride ?? site.status === SiteStatus.STOPPED;
    const event = stopped ? 'nginx:create-stopped-config' : 'nginx:create-config';
    const res = await this.agentRelay.emitToAgent<{ success?: boolean; error?: string }>(
      event,
      buildMultiDomainNginxPayload(site),
      timeoutMs,
    );
    const ack = res as unknown as { success?: boolean; error?: string };
    if (ack && ack.success === false) {
      throw new InternalServerErrorException(
        `${event} rejected by agent: ${ack.error || 'unknown'}`,
      );
    }
  }

  /**
   * Регенерирует nginx-конфиг сайта с учётом статуса. RUNNING/ERROR получают
   * обычный конфиг, STOPPED остаётся stopped-конфигом и не включается случайно
   * после изменения доменов/настроек.
   */
  private async regenerateSiteNginx(siteId: string): Promise<void> {
    if (!this.agentRelay.isAgentConnected()) return;
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      include: DOMAINS_WITH_SSL,
    });
    if (!site) return;
    await this.emitSiteNginxConfig(site as unknown as RawSiteForNginx & { status?: string });
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

  // ===========================================================================
  // PHP-FPM pool custom config (редактор пер-сайта, по аналогии с nginx-конфигом)
  // ===========================================================================

  /**
   * Возвращает редактируемый кусок pool-конфига (то, что пишет пользователь
   * в textarea) + текущий полностью сгенерированный pool-файл с диска агента
   * (read-only превью для ориентира).
   */
  async getPhpPoolConfig(id: string, userId: string, role: string) {
    void id;
    void userId;
    void role;
    throw new ConflictException(
      'Use /sites/:siteId/domains/:domainId/php-pool-config',
    );
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
    void id;
    void userId;
    void role;
    void customConfig;
    throw new ConflictException(
      'Use /sites/:siteId/domains/:domainId/php-pool-config',
    );
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
    await this.siteDomains.ensureDomainFreeInNginx(
      domains,
      ignoreOwnDomain,
    );
  }
}
