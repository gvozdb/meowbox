import { Body, Controller, Get, Param, Post, Put, ParseUUIDPipe } from '@nestjs/common';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums';

import { SitesNginxService, type NginxSettingsResponse } from './sites-nginx.service';
import { UpdateSiteNginxSettingsDto, UpdateSiteNginxCustomDto } from './sites.dto';

interface AuthCtx {
  id: string;
  role: string;
}

@Controller('sites')
export class SitesNginxController {
  constructor(private readonly service: SitesNginxService) {}

  /**
   * POST /sites/nginx/rebuild-all — массовая регенерация layered-конфигов.
   * Используется после миграции с монолитного формата на layered.
   * ВАЖНО: должен идти ПЕРЕД маршрутами с `:id`, иначе nest подумает что
   * "nginx" — это id сайта.
   */
  @Post('nginx/rebuild-all')
  @Roles(UserRole.ADMIN)
  async rebuildAll(@CurrentUser() user: AuthCtx) {
    const data = await this.service.regenerateAll(user.role);
    return { success: true, data };
  }

  @Get(':id/nginx/settings')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  async getSettings(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthCtx,
  ) {
    const data: NginxSettingsResponse = await this.service.getSettings(id, user.id, user.role);
    return { success: true, data };
  }

  @Put(':id/nginx/settings')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  async updateSettings(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateSiteNginxSettingsDto,
    @CurrentUser() user: AuthCtx,
  ) {
    const data: NginxSettingsResponse = await this.service.updateSettings(id, dto, user.id, user.role);
    return { success: true, data };
  }

  @Get(':id/nginx/custom')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  async getCustom(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthCtx,
  ) {
    const data = await this.service.getCustomConfig(id, user.id, user.role);
    return { success: true, data };
  }

  @Put(':id/nginx/custom')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  async updateCustom(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateSiteNginxCustomDto,
    @CurrentUser() user: AuthCtx,
  ) {
    const data = await this.service.updateCustomConfig(id, dto, user.id, user.role);
    return { success: true, data };
  }

  @Post(':id/nginx/test')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  async test(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthCtx,
  ) {
    const data = await this.service.testConfig(id, user.id, user.role);
    return { success: true, data };
  }

  @Post(':id/nginx/reload')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  async reload(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthCtx,
  ) {
    const data = await this.service.reload(id, user.id, user.role);
    return { success: true, data };
  }
}
