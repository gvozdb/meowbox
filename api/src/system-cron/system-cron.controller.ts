import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  CreateSystemCronJobDto,
  UpdateSystemCronJobDto,
} from './system-cron.dto';
import { SystemCronService } from './system-cron.service';

interface JwtUser {
  id: string;
  role: string;
}

@Controller('system-cron')
export class SystemCronController {
  constructor(private readonly service: SystemCronService) {}

  @Get()
  async findAll() {
    const jobs = await this.service.findAll();
    return { success: true, data: jobs };
  }

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async create(
    @Body() dto: CreateSystemCronJobDto,
    @CurrentUser() user?: JwtUser,
  ) {
    const job = await this.service.create(dto, user!.role);
    return { success: true, data: job };
  }

  @Put(':id')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSystemCronJobDto,
    @CurrentUser() user?: JwtUser,
  ) {
    const job = await this.service.update(id, dto, user!.role);
    return { success: true, data: job };
  }

  @Delete(':id')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async delete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    await this.service.delete(id, user!.role);
    return { success: true };
  }

  @Post(':id/toggle')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async toggleStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const job = await this.service.toggleStatus(id, user!.role);
    return { success: true, data: job };
  }
}
