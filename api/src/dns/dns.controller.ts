import {
  Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../common/decorators/roles.decorator';
import { DnsService } from './dns.service';
import {
  ApplyTemplateDto, CreateProviderDto, CreateRecordDto, LinkSiteDto, UpdateRecordDto,
} from './dns.dto';

@Controller('dns')
export class DnsController {
  constructor(private readonly service: DnsService) {}

  // ---- Providers ----

  @Get('providers')
  @Roles('ADMIN')
  async listProviders() {
    const data = await this.service.listProviders();
    return { success: true, data };
  }

  @Post('providers')
  @Roles('ADMIN')
  @Throttle({ medium: { ttl: 10000, limit: 50 } })
  async createProvider(@Body() dto: CreateProviderDto) {
    const data = await this.service.createProvider(dto);
    return { success: true, data };
  }

  @Delete('providers/:id')
  @Roles('ADMIN')
  @Throttle({ medium: { ttl: 10000, limit: 50 } })
  async deleteProvider(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.deleteProvider(id);
    return { success: true };
  }

  @Post('providers/:id/test')
  @Roles('ADMIN')
  @Throttle({ medium: { ttl: 10000, limit: 50 } })
  async testProvider(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.service.testProvider(id);
    return { success: true, data };
  }

  @Post('providers/:id/sync')
  @Roles('ADMIN')
  @Throttle({ medium: { ttl: 10000, limit: 50 } })
  async syncProvider(@Param('id', ParseUUIDPipe) id: string) {
    // Полный sync: зоны + записи всех зон. Раньше тут был только syncZones —
    // юзер видел зоны, но записи приходилось обновлять кнопкой "↻" в каждой.
    const data = await this.service.syncProviderFull(id);
    return { success: true, data };
  }

  // ---- Zones ----

  @Get('zones')
  @Roles('ADMIN')
  async listZones(@Query('accountId') accountId?: string, @Query('domain') domain?: string) {
    const data = await this.service.listAllZones({ accountId, domain });
    return { success: true, data };
  }

  @Get('zones/:id')
  @Roles('ADMIN')
  async getZone(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.service.getZone(id);
    return { success: true, data };
  }

  @Post('zones/:id/refresh')
  @Roles('ADMIN')
  @Throttle({ medium: { ttl: 10000, limit: 50 } })
  async refreshRecords(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.refreshRecords(id);
    return { success: true };
  }

  @Post('zones/:id/link-site')
  @Roles('ADMIN')
  async linkSite(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LinkSiteDto) {
    await this.service.linkSite(id, dto.siteId ?? null);
    return { success: true };
  }

  // ---- Records ----

  @Get('zones/:id/records')
  @Roles('ADMIN')
  async listRecords(@Param('id', ParseUUIDPipe) id: string) {
    const zone = await this.service.getZone(id);
    return { success: true, data: zone.records };
  }

  @Post('zones/:id/records')
  @Roles('ADMIN')
  @Throttle({ medium: { ttl: 10000, limit: 50 } })
  async createRecord(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateRecordDto,
  ) {
    const data = await this.service.createRecord(id, dto);
    return { success: true, data };
  }

  @Patch('zones/:id/records/:rid')
  @Roles('ADMIN')
  @Throttle({ medium: { ttl: 10000, limit: 50 } })
  async updateRecord(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('rid', ParseUUIDPipe) rid: string,
    @Body() dto: UpdateRecordDto,
  ) {
    await this.service.updateRecord(id, rid, dto);
    return { success: true };
  }

  @Delete('zones/:id/records/:rid')
  @Roles('ADMIN')
  @Throttle({ medium: { ttl: 10000, limit: 50 } })
  async deleteRecord(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('rid', ParseUUIDPipe) rid: string,
  ) {
    await this.service.deleteRecord(id, rid);
    return { success: true };
  }

  @Post('zones/:id/templates')
  @Roles('ADMIN')
  @Throttle({ medium: { ttl: 10000, limit: 50 } })
  async applyTemplate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApplyTemplateDto,
  ) {
    const data = await this.service.applyMailTemplate(id, dto);
    return { success: true, data };
  }

  // ---- Site DNS view ----
  // Используется на странице сайта (/sites/:id) — вкладка "DNS".
  // Возвращает все DNS-записи всех зон у всех провайдеров, чьи FQDN
  // совпадают с site.domain или одним из site.aliases.

  @Get('sites/:siteId')
  @Roles('ADMIN')
  async getSiteDnsView(@Param('siteId', ParseUUIDPipe) siteId: string) {
    const data = await this.service.getSiteDnsView(siteId);
    return { success: true, data };
  }

  @Post('sites/:siteId/relink')
  @Roles('ADMIN')
  @Throttle({ medium: { ttl: 10000, limit: 50 } })
  async relinkSite(@Param('siteId', ParseUUIDPipe) siteId: string) {
    // Чисто триггерит автолинк по доменам (без обращений к провайдерам).
    // Полезно после переименования сайта/смены домена.
    await this.service.autoLinkZonesToSites();
    const data = await this.service.getSiteDnsView(siteId);
    return { success: true, data };
  }
}
