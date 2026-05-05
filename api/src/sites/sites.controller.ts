import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SitesService } from './sites.service';
import { ModxVersionsService } from './modx-versions.service';
import {
  CreateSiteDto,
  UpdateSiteDto,
  UpdateModxVersionDto,
  DuplicateSiteDto,
  DeleteSiteOptionsDto,
  ChangeSshPasswordDto,
  ChangeCmsAdminPasswordDto,
  UpdatePhpPoolConfigDto,
} from './sites.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums';

@Controller('sites')
export class SitesController {
  constructor(
    private readonly sitesService: SitesService,
    private readonly modxVersions: ModxVersionsService,
  ) {}

  /**
   * Актуальный список релизов MODX (Revo 2.x и MODX 3.x) — тянется из GitHub
   * и кешируется на час (см. ModxVersionsService). Путь статический, вне :id —
   * нужно объявить ДО любых @Get(':id/...') / @Get(':id'), иначе Nest матчит
   * 'modx-versions' как id.
   */
  @Get('modx-versions')
  async getModxVersions(@Query('refresh') refresh?: string) {
    const data = await this.modxVersions.getVersions(refresh === '1');
    return { success: true, data };
  }

  /**
   * POST /api/sites/php-shim/resync — ручной перезапуск настройки per-user
   * CLI-шимов PHP для всех сайтов. Используется если автоматическая миграция
   * (onModuleInit / onAgentConnect) не отработала — например, агент был
   * офлайн в нужный момент или сайт был импортирован старой версией панели,
   * где этого хука ещё не существовало.
   *
   * Симптом, при котором это нужно: `su - <siteUser>; php -v` показывает
   * не ту версию, что выбрана для сайта в FPM.
   *
   * Только ADMIN. Throttle 2/мин — операция тяжёлая (по сетевому RTT
   * на каждый сайт), повторных вызовов нам не нужно.
   */
  @Post('php-shim/resync')
  @Roles(UserRole.ADMIN)
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  async resyncPhpShims() {
    const result = await this.sitesService.resyncPhpCliShims();
    return { success: true, data: result };
  }

  @Get()
  async findAll(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
    @Query('page') page?: string,
    @Query('perPage') perPage?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    const result = await this.sitesService.findAll({
      userId,
      role,
      page: page ? parseInt(page, 10) : undefined,
      perPage: perPage ? parseInt(perPage, 10) : undefined,
      type,
      status,
      search,
    });

    return { success: true, data: result.sites, meta: result.meta };
  }

  @Get(':id')
  async findById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const site = await this.sitesService.findById(id, userId, role);
    return { success: true, data: site };
  }

  // Создание сайта = useradd / chown / mkdir под root на агенте. Только ADMIN.
  // Rate limit: создание тяжёлая операция (агентские команды + provisioning),
  // 5 в минуту достаточно для нормальной работы и блокирует burst-DoS.
  @Post()
  @Roles(UserRole.ADMIN)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async create(
    @Body() dto: CreateSiteDto,
    @CurrentUser('sub') userId: string,
  ) {
    const site = await this.sitesService.create(dto, userId);
    return { success: true, data: site };
  }

  /**
   * Дублирование сайта: копия под новым name+domain. Копируется `www/`
   * (через rsync), БД (dump+restore), опционально — настройки бэкапов и cron.
   * SSL не копируется (выпускается отдельно для нового домена).
   */
  @Post(':id/duplicate')
  @Roles(UserRole.ADMIN)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async duplicate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DuplicateSiteDto,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const site = await this.sitesService.duplicate(id, dto, userId, role);
    return { success: true, data: site };
  }

  @Put(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSiteDto,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const site = await this.sitesService.update(id, dto, userId, role);
    return { success: true, data: site };
  }

  // start/stop/restart дёргают php-fpm + nginx — лимитируем чтобы не положить
  // системные сервисы каскадными перезапусками.
  @Post(':id/start')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async startSite(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    await this.sitesService.controlSite(id, userId, role, 'start');
    return { success: true, data: null };
  }

  @Post(':id/stop')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async stopSite(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    await this.sitesService.controlSite(id, userId, role, 'stop');
    return { success: true, data: null };
  }

  @Post(':id/restart')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async restartSite(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    await this.sitesService.controlSite(id, userId, role, 'restart');
    return { success: true, data: null };
  }

  // Возвращает plaintext SSH-пароль сайта — критично, оставляем только ADMIN.
  @Get(':id/ssh')
  @Roles(UserRole.ADMIN)
  async getSshCredentials(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const credentials = await this.sitesService.getSshCredentials(id, userId, role);
    return { success: true, data: credentials };
  }

  /**
   * Смена SSH-пароля пользователя сайта.
   * Body: `{ password?: string }` — если пусто, генерируется случайный.
   */
  @Post(':id/ssh-password')
  @Roles(UserRole.ADMIN)
  async changeSshPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ChangeSshPasswordDto,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const data = await this.sitesService.changeSshPassword(id, userId, role, body?.password);
    return { success: true, data };
  }

  /**
   * Смена пароля администратора MODX (Revo / 3). Под капотом — bootstrap
   * MODX_API_MODE на агенте + `$user->changePassword(...)`.
   * Body: `{ password?: string }` — если пусто, генерим случайный.
   */
  @Post(':id/cms-admin-password')
  @Roles(UserRole.ADMIN)
  async changeCmsAdminPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ChangeCmsAdminPasswordDto,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const data = await this.sitesService.changeCmsAdminPassword(id, userId, role, body?.password);
    return { success: true, data };
  }

  /**
   * Обновление версии MODX (для MODX_REVO / MODX_3).
   * Body: `{ targetVersion: "3.1.2-pl" }`
   */
  @Post(':id/update-modx')
  async updateModxVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateModxVersionDto,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const data = await this.sitesService.updateModxVersion(id, userId, role, dto);
    return { success: true, data };
  }

  /**
   * Нормализация прав/владельца файлов сайта.
   * Используется кнопкой "Нормализация прав" из UI и MODX Doctor'ом как
   * fix для проблемы root-owned кэша.
   *
   * Только ADMIN — операция системного уровня (chown -R / chmod -R на всё дерево).
   */
  @Post(':id/normalize-permissions')
  @Roles(UserRole.ADMIN)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async normalizePermissions(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const data = await this.sitesService.normalizeSitePermissions(id, userId, role);
    return { success: true, data };
  }

  /**
   * MODX Doctor — read-only диагностика типовых проблем MODX-сайтов.
   * Возвращает список issues с опциональным id действия для починки.
   */
  @Get(':id/modx-doctor')
  async modxDoctor(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const data = await this.sitesService.runModxDoctor(id, userId, role);
    return { success: true, data };
  }

  /**
   * Удаление setup/ каталога MODX-сайта (fix для doctor'а).
   */
  @Post(':id/cleanup-setup-dir')
  @Roles(UserRole.ADMIN)
  async cleanupSetupDir(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const data = await this.sitesService.cleanupSetupDir(id, userId, role);
    return { success: true, data };
  }

  @Get(':id/metrics')
  async getSiteMetrics(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const data = await this.sitesService.getSiteMetrics(id, userId, role);
    return { success: true, data };
  }

  /**
   * Редактируемый кусок php-fpm pool-конфига для сайта. Юзер пишет только
   * дополнительный INI-фрагмент; агент дописывает его в конец базового пула
   * при каждой перегенерации (смена PHP, выпуск SSL, ручное сохранение).
   */
  @Get(':id/php-pool-config')
  async getPhpPoolConfig(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const data = await this.sitesService.getPhpPoolConfig(id, userId, role);
    return { success: true, data };
  }

  @Put(':id/php-pool-config')
  async updatePhpPoolConfig(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdatePhpPoolConfigDto,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const data = await this.sitesService.updatePhpPoolConfig(
      id,
      userId,
      role,
      body?.custom ?? '',
    );
    return { success: true, data };
  }

  // Удаление сайта = userdel / rm -rf. Только ADMIN.
  @Delete(':id')
  @Roles(UserRole.ADMIN)
  async delete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
    // Опциональный body: DeleteSiteOptionsDto — все поля дефолт true (полное
    // удаление). Отдельными флагами можно оставить SSL/бэкапы/файлы.
    @Body() body: DeleteSiteOptionsDto = {},
  ) {
    await this.sitesService.delete(id, userId, role, {
      removeSslCertificate: body.removeSslCertificate !== false,
      removeBackupsLocal: body.removeBackupsLocal !== false,
      removeBackupsRestic: body.removeBackupsRestic !== false,
      removeBackupsRemote: body.removeBackupsRemote !== false,
      removeDatabases: body.removeDatabases !== false,
      removeFiles: body.removeFiles !== false,
      removeSystemUser: body.removeSystemUser !== false,
      removeNginxConfig: body.removeNginxConfig !== false,
      removePhpPool: body.removePhpPool !== false,
    });
    return { success: true, data: null };
  }
}
