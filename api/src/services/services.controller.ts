import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Patch,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums';
import { ServicesService } from './services.service';
import { EnableSiteServiceDto, ReconfigureSiteServiceDto, SERVICE_KEY_REGEX } from './services.dto';
import { BadRequestException } from '@nestjs/common';

function validateKey(key: string) {
  if (!SERVICE_KEY_REGEX.test(key)) {
    throw new BadRequestException('Invalid service key');
  }
}

@Controller()
export class ServicesController {
  constructor(private readonly services: ServicesService) {}

  // =====================================================================
  // Server level — /services
  // =====================================================================

  @Get('services')
  async listServer() {
    const data = await this.services.listServerServices();
    return { success: true, data };
  }

  @Get('services/:key')
  async getServer(@Param('key') key: string) {
    validateKey(key);
    const data = await this.services.getServerService(key);
    return { success: true, data };
  }

  @Post('services/:key/install')
  @Roles(UserRole.ADMIN)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async install(@Param('key') key: string) {
    validateKey(key);
    const data = await this.services.installServerService(key);
    return { success: true, data };
  }

  @Delete('services/:key')
  @Roles(UserRole.ADMIN)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async uninstall(@Param('key') key: string) {
    validateKey(key);
    await this.services.uninstallServerService(key);
    return { success: true };
  }

  // =====================================================================
  // Site level — /sites/:siteId/services
  // =====================================================================

  @Get('sites/:siteId/services')
  async listSite(@Param('siteId', ParseUUIDPipe) siteId: string) {
    const data = await this.services.listSiteServices(siteId);
    return { success: true, data };
  }

  @Get('sites/:siteId/services/:key')
  async getSite(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('key') key: string,
  ) {
    validateKey(key);
    const data = await this.services.getSiteService(siteId, key);
    return { success: true, data };
  }

  @Post('sites/:siteId/services/:key/enable')
  @Roles(UserRole.ADMIN)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async enable(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('key') key: string,
    @Body() dto: EnableSiteServiceDto,
  ) {
    validateKey(key);
    const data = await this.services.enableSiteService(siteId, key, dto.config || {});
    return { success: true, data };
  }

  @Delete('sites/:siteId/services/:key')
  @Roles(UserRole.ADMIN)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async disable(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('key') key: string,
  ) {
    validateKey(key);
    await this.services.disableSiteService(siteId, key);
    return { success: true };
  }

  @Post('sites/:siteId/services/:key/start')
  @Roles(UserRole.ADMIN)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async start(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('key') key: string,
  ) {
    validateKey(key);
    const data = await this.services.startSiteService(siteId, key);
    return { success: true, data };
  }

  @Post('sites/:siteId/services/:key/stop')
  @Roles(UserRole.ADMIN)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async stop(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('key') key: string,
  ) {
    validateKey(key);
    const data = await this.services.stopSiteService(siteId, key);
    return { success: true, data };
  }

  @Patch('sites/:siteId/services/:key')
  @Roles(UserRole.ADMIN)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async reconfigure(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('key') key: string,
    @Body() dto: ReconfigureSiteServiceDto,
  ) {
    validateKey(key);
    const data = await this.services.reconfigureSiteService(siteId, key, dto.config);
    return { success: true, data };
  }

  @Post('sites/:siteId/services/manticore/adminer-ticket')
  @Roles(UserRole.ADMIN)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async manticoreAdminerTicket(@Param('siteId', ParseUUIDPipe) siteId: string) {
    const data = await this.services.createManticoreAdminerTicket(siteId);
    return { success: true, data };
  }

  @Get('sites/:siteId/services/:key/logs')
  async logs(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('key') key: string,
    @Query('lines') linesQ?: string,
  ) {
    validateKey(key);
    const lines = linesQ ? Math.max(10, Math.min(5000, parseInt(linesQ, 10) || 200)) : 200;
    const data = await this.services.getSiteServiceLogs(siteId, key, lines);
    return { success: true, data: { content: data } };
  }
}
