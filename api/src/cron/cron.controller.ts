import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CronService } from './cron.service';
import { CreateCronJobDto, UpdateCronJobDto } from './cron.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';

interface JwtUser {
  id: string;
  role: string;
}

@Controller()
export class CronController {
  constructor(private readonly cronService: CronService) {}

  @Get('sites/:siteId/cron-jobs')
  async findBySite(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const cronJobs = await this.cronService.findBySite(siteId, user!.id, user!.role);
    return { success: true, data: cronJobs };
  }

  @Post('cron-jobs')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async create(
    @Body() dto: CreateCronJobDto,
    @CurrentUser() user?: JwtUser,
  ) {
    const cronJob = await this.cronService.create(dto, user!.id, user!.role);
    return { success: true, data: cronJob };
  }

  @Put('cron-jobs/:id')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCronJobDto,
    @CurrentUser() user?: JwtUser,
  ) {
    const cronJob = await this.cronService.update(id, dto, user!.id, user!.role);
    return { success: true, data: cronJob };
  }

  @Delete('cron-jobs/:id')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async delete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    await this.cronService.delete(id, user!.id, user!.role);
    return { success: true };
  }

  @Post('cron-jobs/:id/toggle')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async toggleStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const cronJob = await this.cronService.toggleStatus(id, user!.id, user!.role);
    return { success: true, data: cronJob };
  }
}
