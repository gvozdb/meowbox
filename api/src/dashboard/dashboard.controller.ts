import { Controller, Get, Header } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { DashboardService } from './dashboard.service';
import { DashboardOverviewService } from './dashboard-overview.service';

@Controller('dashboard')
@Roles('ADMIN')
export class DashboardController {
  constructor(
    private readonly dashboardService: DashboardService,
    private readonly dashboardOverviewService: DashboardOverviewService,
  ) {}

  @Get('overview')
  @Roles('ADMIN', 'MANAGER')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Dashboard-Contract', '1')
  async getOverview(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const data = await this.dashboardOverviewService.getOverview(userId, role);
    return { success: true, data };
  }

  @Get('summary')
  async getSummary(@CurrentUser('sub') userId: string) {
    const data = await this.dashboardService.getSummary(userId);
    return { success: true, data };
  }
}
