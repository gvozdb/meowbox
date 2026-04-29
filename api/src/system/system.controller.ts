import { Controller, Get, Post, Body } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../common/decorators/roles.decorator';
import { SystemService } from './system.service';
import { InstallUpdatesDto } from './system.dto';

@Controller('system')
@Roles('ADMIN')
export class SystemController {
  constructor(private readonly systemService: SystemService) {}

  @Get('metrics')
  async getMetrics() {
    const data = await this.systemService.getMetrics();
    return { success: true, data };
  }

  @Get('status')
  async getStatus() {
    const data = await this.systemService.getStatus();
    return { success: true, data };
  }

  @Get('updates/check')
  async checkUpdates() {
    const data = await this.systemService.checkUpdates();
    return { success: true, data };
  }

  @Post('updates/install')
  // apt-install дорогой, блокирует apt-lock. Лимит 2/5мин.
  @Throttle({ default: { limit: 2, ttl: 300_000 } })
  async installUpdates(@Body() body: InstallUpdatesDto) {
    const data = await this.systemService.installUpdates(body.packages);
    return { success: true, data };
  }

  @Post('updates/upgrade-all')
  // upgrade-all — самая тяжёлая операция. 1 запрос / 10 минут.
  @Throttle({ default: { limit: 1, ttl: 600_000 } })
  async upgradeAll() {
    const data = await this.systemService.upgradeAll();
    return { success: true, data };
  }

  @Get('versions')
  async getVersions() {
    const data = await this.systemService.getVersions();
    return { success: true, data };
  }

  @Post('self-update')
  // git pull + tsc + pm2 restart — дорого. 1 запрос / 10 минут.
  @Throttle({ default: { limit: 1, ttl: 600_000 } })
  async selfUpdate() {
    const data = await this.systemService.selfUpdate();
    return { success: true, data };
  }
}
