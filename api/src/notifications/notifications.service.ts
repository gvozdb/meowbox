import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { NotificationChannel } from '../common/enums';
import { PrismaService } from '../common/prisma.service';
import { CreateNotificationSettingDto } from './notifications.dto';
import { NotificationDispatcherService } from './notification-dispatcher.service';
import { parseStringArray, stringifyStringArray, parseJsonObject } from '../common/json-array';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: NotificationDispatcherService,
  ) {}

  async findByUser(userId: string) {
    const rows = await this.prisma.notificationSetting.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      ...r,
      events: parseStringArray(r.events),
      config: parseJsonObject(r.config, {}),
    }));
  }

  async createOrUpdate(dto: CreateNotificationSettingDto, userId: string) {
    const channel = dto.channel as NotificationChannel;

    // Upsert based on unique constraint [userId, channel]
    const saved = await this.prisma.notificationSetting.upsert({
      where: {
        userId_channel: {
          userId,
          channel,
        },
      },
      create: {
        userId,
        channel,
        events: stringifyStringArray(dto.events),
        enabled: dto.enabled,
        config: JSON.stringify(dto.config ?? {}),
      },
      update: {
        events: stringifyStringArray(dto.events),
        enabled: dto.enabled,
        config: JSON.stringify(dto.config ?? {}),
      },
    });
    return {
      ...saved,
      events: parseStringArray(saved.events),
      config: parseJsonObject(saved.config, {}),
    };
  }

  async delete(id: string, userId: string, role: string) {
    const setting = await this.prisma.notificationSetting.findUnique({
      where: { id },
    });

    if (!setting) throw new NotFoundException('Notification setting not found');
    if (role !== 'ADMIN' && setting.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    await this.prisma.notificationSetting.delete({ where: { id } });
  }

  async testNotification(id: string, userId: string, role: string) {
    const setting = await this.prisma.notificationSetting.findUnique({
      where: { id },
    });

    if (!setting) throw new NotFoundException('Notification setting not found');
    if (role !== 'ADMIN' && setting.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    await this.dispatcher.sendTest(
      setting.channel,
      parseJsonObject(setting.config, {}),
    );

    return {
      channel: setting.channel,
      message: 'Test notification sent successfully',
    };
  }
}
