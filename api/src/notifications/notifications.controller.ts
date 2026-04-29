import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { NotificationsService } from './notifications.service';
import { CreateNotificationSettingDto } from './notifications.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';

interface JwtUser {
  id: string;
  role: string;
}

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  async findByUser(@CurrentUser() user?: JwtUser) {
    const settings = await this.notificationsService.findByUser(user!.id);
    return { success: true, data: settings };
  }

  @Post()
  async createOrUpdate(
    @Body() dto: CreateNotificationSettingDto,
    @CurrentUser() user?: JwtUser,
  ) {
    const setting = await this.notificationsService.createOrUpdate(dto, user!.id);
    return { success: true, data: setting };
  }

  @Delete(':id')
  async delete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    await this.notificationsService.delete(id, user!.id, user!.role);
    return { success: true };
  }

  @Post(':id/test')
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  async testNotification(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const result = await this.notificationsService.testNotification(id, user!.id, user!.role);
    return { success: true, data: result };
  }
}
