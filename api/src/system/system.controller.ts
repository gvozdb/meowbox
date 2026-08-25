import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
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

  @Post('updates/check')
  @HttpCode(HttpStatus.ACCEPTED)
  async checkUpdates(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const data = await this.systemService.enqueueCheckUpdates(
      { userId, role },
      idempotencyKey,
    );
    return { success: true, data };
  }

  @Post('updates/install')
  @HttpCode(HttpStatus.ACCEPTED)
  // apt-install дорогой, блокирует apt-lock. Лимит 2/5мин.
  @Throttle({ default: { limit: 2, ttl: 300_000 } })
  async installUpdates(
    @Body() body: InstallUpdatesDto,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const data = await this.systemService.enqueueInstallUpdates(
      body.packages,
      { userId, role },
      idempotencyKey,
    );
    return { success: true, data };
  }

  @Post('updates/upgrade-all')
  @HttpCode(HttpStatus.ACCEPTED)
  // upgrade-all — самая тяжёлая операция. 1 запрос / 10 минут.
  @Throttle({ default: { limit: 1, ttl: 600_000 } })
  async upgradeAll(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const data = await this.systemService.enqueueUpgradeAll(
      { userId, role },
      idempotencyKey,
    );
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
