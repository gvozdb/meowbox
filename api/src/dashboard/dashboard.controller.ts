import { Controller, Get } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
@Roles('ADMIN')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('summary')
  async getSummary(@CurrentUser('sub') userId: string) {
    const data = await this.dashboardService.getSummary(userId);
    return { success: true, data };
  }
}
