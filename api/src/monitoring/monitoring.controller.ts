import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { MonitoringService } from './monitoring.service';

@Controller('monitoring')
@Roles('ADMIN')
export class MonitoringController {
  constructor(private readonly monitoringService: MonitoringService) {}

  @Get('current')
  getCurrent() {
    const data = this.monitoringService.getLatestMetrics();
    return { success: true, data };
  }

  @Get('history')
  async getHistory(@Query('range') range = '1h') {
    const allowed = ['1h', '6h', '24h', '7d', '30d'];
    const validRange = allowed.includes(range) ? range : '1h';
    const data = await this.monitoringService.getHistory(validRange);
    return { success: true, data };
  }
}
