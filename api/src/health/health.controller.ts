import {
  Controller,
  ForbiddenException,
  Get,
  GoneException,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
} from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { HealthService } from './health.service';

@Controller('health')
@Roles('ADMIN', 'MANAGER')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('release')
  @Public()
  @Roles()
  async getReleaseHealth(@Req() request: { ip?: string; socket?: { remoteAddress?: string } }) {
    const address = request.ip || request.socket?.remoteAddress || '';
    if (
      address !== '::1'
      && address !== '127.0.0.1'
      && address !== '::ffff:127.0.0.1'
      && !address.startsWith('127.')
    ) {
      throw new ForbiddenException('Release health endpoint is loopback-only');
    }
    return {
      success: true,
      data: await this.healthService.getReleaseHealth(),
    };
  }

  @Get()
  async getAll(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const data = await this.healthService.getAllSitesHealth(userId, role);
    return { success: true, data };
  }

  @Get(':siteId/pings')
  getLegacyPingHistory() {
    throw new GoneException(
      'Use /health/:siteId/domains/:domainId/pings',
    );
  }

  @Get(':siteId/domains/:domainId/pings')
  async getPingHistory(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
    @Query('hours') hoursStr?: string,
  ) {
    const hours = Math.min(Math.max(parseInt(hoursStr || '24', 10) || 24, 1), 168);
    const data = await this.healthService.getSitePingHistory(
      siteId,
      domainId,
      userId,
      role,
      hours,
    );
    return { success: true, data };
  }
}
