import { Controller, Get, Param, Query } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { HealthService } from './health.service';

@Controller('health')
@Roles('ADMIN', 'MANAGER')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  async getAll(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const data = await this.healthService.getAllSitesHealth(userId, role);
    return { success: true, data };
  }

  @Get(':siteId/pings')
  async getPingHistory(
    @Param('siteId') siteId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
    @Query('hours') hoursStr?: string,
  ) {
    const hours = Math.min(Math.max(parseInt(hoursStr || '24', 10) || 24, 1), 168);
    const data = await this.healthService.getSitePingHistory(siteId, userId, role, hours);
    return { success: true, data };
  }
}
