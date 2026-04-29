import { Controller, Get, Param, Query, ParseUUIDPipe } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { StorageService } from './storage.service';

@Controller('storage')
@Roles('ADMIN', 'MANAGER')
export class StorageController {
  constructor(private readonly storageService: StorageService) {}

  @Get()
  async getAll(@CurrentUser('id') userId: string, @CurrentUser('role') role: string) {
    const sites = await this.storageService.getAllSitesStorage(userId, role);
    return { success: true, data: sites };
  }

  @Get('server')
  async getServerDisk() {
    const data = await this.storageService.getServerDisk();
    return { success: true, data };
  }

  @Get(':siteId/top-files')
  async getTopFiles(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const data = await this.storageService.getSiteTopFiles(siteId, userId, role);
    return { success: true, data };
  }

  @Get(':siteId/trend')
  async getTrend(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
    @Query('days') daysStr?: string,
  ) {
    const days = Math.min(Math.max(parseInt(daysStr || '30', 10) || 30, 1), 90);
    const data = await this.storageService.getTrend(siteId, userId, role, days);
    return { success: true, data };
  }
}
