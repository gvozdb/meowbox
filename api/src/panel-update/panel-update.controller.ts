import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums';

import { PanelUpdateService } from './panel-update.service';

interface AuthCtx {
  id: string;
  role: string;
}

@Controller('admin/update')
export class PanelUpdateController {
  constructor(private readonly service: PanelUpdateService) {}

  /** GET /api/admin/update/status?refresh=1 — состояние + история + опц. чек latest. */
  @Get('status')
  @Roles(UserRole.ADMIN)
  async status(@Query('refresh') refresh?: string) {
    const data = await this.service.getStatus(refresh === '1' || refresh === 'true');
    return { success: true, data };
  }

  /**
   * GET /api/admin/update/version — лёгкий эндпоинт для сайдбара.
   * Возвращает только текущую и последнюю версию (без истории / state),
   * доступен любому залогиненному юзеру (ADMIN/USER).
   * `refresh=1` форсит запрос к GitHub API.
   */
  @Get('version')
  async version(@Query('refresh') refresh?: string) {
    const data = await this.service.getVersionSummary(refresh === '1' || refresh === 'true');
    return { success: true, data };
  }

  /**
   * GET /api/admin/update/tags — список последних релизов с GitHub.
   * Используется на /admin/updates и в массовом обновлении серверов.
   */
  @Get('tags')
  @Roles(UserRole.ADMIN)
  async tags(@Query('refresh') refresh?: string) {
    const data = await this.service.listReleaseTags(refresh === '1' || refresh === 'true');
    return { success: true, data };
  }

  /** POST /api/admin/update — запускает tools/update.sh в фоне. body: { version?: 'v1.4.2' | null }. */
  @Post()
  @Roles(UserRole.ADMIN)
  async trigger(
    @Body() body: { version?: string | null },
    @CurrentUser() user: AuthCtx,
  ) {
    const data = await this.service.triggerUpdate(body?.version ?? null, user.id, user.role);
    return { success: true, data };
  }

  /**
   * DELETE /api/admin/update/history/:id — удалить запись из истории.
   * История — append-only лог; ручное удаление нужно для чистки старых
   * fail-ов, после того как починили root cause.
   */
  @Delete('history/:id')
  @Roles(UserRole.ADMIN)
  async deleteHistory(@Param('id') id: string) {
    await this.service.deleteHistory(id);
    return { success: true, data: { id } };
  }
}
