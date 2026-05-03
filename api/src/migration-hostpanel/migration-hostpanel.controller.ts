import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  CheckDomainDto,
  CheckNameDto,
  CreateSavedSourceDto,
  StartDiscoveryDto,
  StartProbeDto,
  StartRunDto,
  UpdatePlanItemDto,
} from './migration-hostpanel.dto';
import { MigrationHostpanelService } from './migration-hostpanel.service';

interface JwtUser {
  id: string;
  role: string;
}

@Controller('admin/migrate-hostpanel')
export class MigrationHostpanelController {
  constructor(private readonly service: MigrationHostpanelService) {}

  // ─── Saved source presets ─────────────────────────────────────────────
  // ВАЖНО: эти роуты обязаны идти раньше `:id`-параметризованных, иначе
  // Express-роутер примет /sources за /:id, ParseUUIDPipe выбросит 400.

  @Get('sources')
  async listSavedSources(@CurrentUser() user?: JwtUser) {
    const data = await this.service.listSavedSources(user!.role);
    return { success: true, data };
  }

  @Post('sources')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async createSavedSource(
    @Body() dto: CreateSavedSourceDto,
    @CurrentUser() user?: JwtUser,
  ) {
    const data = await this.service.createSavedSource(dto, user!.id, user!.role);
    return { success: true, data };
  }

  @Delete('sources/:id')
  async deleteSavedSource(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const data = await this.service.deleteSavedSource(id, user!.role);
    return { success: true, data };
  }

  // ─── List / Detail / Log ──────────────────────────────────────────────

  @Get()
  async findAll(@CurrentUser() user?: JwtUser) {
    const list = await this.service.findAll(user!.role);
    return { success: true, data: list };
  }

  @Get(':id')
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const data = await this.service.findOne(id, user!.role);
    return { success: true, data };
  }

  @Get(':id/log')
  async getLog(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const data = await this.service.getLog(id, user!.role);
    return { success: true, data };
  }

  // ─── Discovery ────────────────────────────────────────────────────────

  @Post('discover')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async startDiscovery(
    @Body() dto: StartDiscoveryDto,
    @CurrentUser() user?: JwtUser,
  ) {
    const result = await this.service.startDiscovery(dto, user!.id, user!.role);
    return { success: true, data: result };
  }

  /**
   * Phase 2 — оператор выбрал нужные сайты из shortlist'а и просит собрать
   * полный план (с du, размерами БД, парсингом nginx/config.xml). Принимает
   * itemIds (HostpanelMigrationItem.id), не sourceSiteIds. Запускает
   * deep probe в фоне; статус миграции SHORTLIST_READY → PROBING → READY.
   */
  @Post(':id/probe')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async startProbe(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StartProbeDto,
    @CurrentUser() user?: JwtUser,
  ) {
    const data = await this.service.startProbeSelected(id, dto, user!.role);
    return { success: true, data };
  }

  // ─── PlanItem ─────────────────────────────────────────────────────────

  @Patch(':id/items/:itemId')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async updateItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdatePlanItemDto,
    @CurrentUser() user?: JwtUser,
  ) {
    const item = await this.service.updatePlanItem(id, itemId, dto, user!.role);
    return { success: true, data: { id: item.id, status: item.status } };
  }

  @Post(':id/items/:itemId/skip')
  async skipItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const data = await this.service.skipItem(id, itemId, user!.role);
    return { success: true, data };
  }

  @Post(':id/items/:itemId/retry')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async retryItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const data = await this.service.retryItem(id, itemId, user!.role);
    return { success: true, data };
  }

  /**
   * Проверяет, можно ли сделать force-retry для FAILED-айтема: есть ли
   * leak'нутые артефакты с именем `plan.newName`, оставленные предыдущей
   * (обычно зависшей) попыткой ИМЕННО ЭТОЙ ЖЕ миграции, и нет ли занятого
   * имени активной (RUNNING) миграцией. Возвращает `{ canForceRetry: true,
   * leakSources: [...] }` или `{ canForceRetry: false, reason }`.
   */
  @Get(':id/items/:itemId/force-retry-check')
  async checkForceRetry(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const data = await this.service.checkForceRetry(id, itemId, user!.role);
    return { success: true, data };
  }

  /**
   * Force-retry: чистит leak'нутые артефакты на slave (Linux-юзер, БД,
   * nginx, php-fpm, ssl, cron) и заново ставит item в очередь. Использует
   * тот же `runItem`, что и обычный retry. Защита: дёргаем
   * `checkForceRetry` под капотом — если оно говорит «нельзя», эндпоинт
   * 409.
   */
  @Post(':id/items/:itemId/force-retry')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async forceRetry(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const data = await this.service.forceRetryItem(id, itemId, user!.role);
    return { success: true, data };
  }

  // ─── Validation helpers ───────────────────────────────────────────────

  @Get('check-name')
  async checkName(@Query() query: CheckNameDto, @CurrentUser() user?: JwtUser) {
    const data = await this.service.checkName(query.name, user!.role);
    return { success: true, data };
  }

  @Get('check-domain')
  async checkDomain(
    @Query() query: CheckDomainDto,
    @CurrentUser() user?: JwtUser,
  ) {
    const data = await this.service.checkDomain(query.domain, user!.role);
    return { success: true, data };
  }

  // ─── Run / Pause / Resume / Cancel ────────────────────────────────────

  @Post(':id/start')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async start(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StartRunDto,
    @CurrentUser() user?: JwtUser,
  ) {
    const data = await this.service.start(id, dto, user!.role);
    return { success: true, data };
  }

  @Post(':id/pause')
  async pause(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const data = await this.service.pause(id, user!.role);
    return { success: true, data };
  }

  @Post(':id/resume')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async resume(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const data = await this.service.resume(id, user!.role);
    return { success: true, data };
  }

  @Post(':id/cancel')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const data = await this.service.cancel(id, user!.role);
    return { success: true, data };
  }

  // Backward-compat: DELETE /:id тоже отменяет (раньше так было)
  @Delete(':id')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async cancelLegacy(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const data = await this.service.cancel(id, user!.role);
    return { success: true, data };
  }
}
