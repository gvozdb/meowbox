import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { NotificationChannel } from '../common/enums';
import { PrismaService } from '../common/prisma.service';
import { CreateNotificationSettingDto } from './notifications.dto';
import { NotificationDispatcherService } from './notification-dispatcher.service';
import { parseStringArray, stringifyStringArray, parseJsonObject } from '../common/json-array';
import {
  normalizeTelegramConfig,
  publicTelegramConfig,
  readTelegramConfig,
  TelegramConfigValidationError,
} from './telegram-config';

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
    return rows.map((row) => this.mapSetting(row));
  }

  async createOrUpdate(dto: CreateNotificationSettingDto, userId: string) {
    const channel = dto.channel as NotificationChannel;
    const existing = await this.prisma.notificationSetting.findUnique({
      where: { userId_channel: { userId, channel } },
      select: {
        id: true,
        config: true,
        enabled: true,
        telegramNextUpdateId: true,
        telegramCommandsEnabledAt: true,
      },
    });
    const previousTelegramConfig = channel === NotificationChannel.TELEGRAM && existing
      ? readTelegramConfig(parseJsonObject(existing.config, {}))
      : null;
    let config = dto.config ?? {};
    if (channel === NotificationChannel.TELEGRAM) {
      try {
        config = normalizeTelegramConfig(
          config,
          existing ? parseJsonObject(existing.config, {}) : {},
        );
      } catch (error) {
        if (error instanceof TelegramConfigValidationError) {
          throw new BadRequestException(error.message);
        }
        throw error;
      }
      await this.assertUniqueCommandBot(config, existing?.id ?? null);
    }
    const telegramConfig = channel === NotificationChannel.TELEGRAM
      ? readTelegramConfig(config)
      : null;
    const commandsConfigured = telegramConfig?.commandsEnabled === true;
    const commandBotTokenHash = commandsConfigured
      ? createHash('sha256').update(telegramConfig.botToken).digest('hex')
      : null;
    const tokenChanged = previousTelegramConfig?.botToken !== telegramConfig?.botToken;
    const commandsJustEnabled = commandsConfigured
      && previousTelegramConfig?.commandsEnabled !== true;
    const channelJustEnabled = commandsConfigured
      && dto.enabled
      && existing?.enabled === false;
    const telegramNextUpdateId = commandsConfigured && !tokenChanged
      ? existing?.telegramNextUpdateId ?? null
      : null;
    const telegramCommandsEnabledAt = commandsConfigured
      ? tokenChanged || commandsJustEnabled || channelJustEnabled
        ? new Date()
        : existing?.telegramCommandsEnabledAt ?? new Date()
      : null;
    const clearLease = tokenChanged || !commandsConfigured || !dto.enabled;

    // Upsert based on unique constraint [userId, channel]
    let saved;
    try {
      saved = await this.prisma.notificationSetting.upsert({
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
          config: JSON.stringify(config),
          commandBotTokenHash,
          telegramNextUpdateId,
          telegramCommandsEnabledAt,
          telegramLeaseOwner: null,
          telegramLeaseExpiresAt: null,
        },
        update: {
          events: stringifyStringArray(dto.events),
          enabled: dto.enabled,
          config: JSON.stringify(config),
          commandBotTokenHash,
          telegramNextUpdateId,
          telegramCommandsEnabledAt,
          ...(clearLease
            ? { telegramLeaseOwner: null, telegramLeaseExpiresAt: null }
            : {}),
        },
      });
    } catch (error) {
      if (
        commandBotTokenHash
        && error instanceof Prisma.PrismaClientKnownRequestError
        && error.code === 'P2002'
      ) {
        throw new ConflictException(
          'This Telegram bot already handles commands for another panel user',
        );
      }
      throw error;
    }
    return this.mapSetting(saved);
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

  private async assertUniqueCommandBot(
    value: unknown,
    currentSettingId: string | null,
  ): Promise<void> {
    const config = readTelegramConfig(value);
    if (!config?.commandsEnabled) return;

    const rows = await this.prisma.notificationSetting.findMany({
      where: { channel: NotificationChannel.TELEGRAM },
      select: { id: true, config: true },
    });
    const duplicate = rows.some((row) => {
      if (row.id === currentSettingId) return false;
      const other = readTelegramConfig(parseJsonObject(row.config, {}));
      return other?.commandsEnabled === true && other.botToken === config.botToken;
    });
    if (duplicate) {
      throw new ConflictException(
        'This Telegram bot already handles commands for another panel user',
      );
    }
  }

  private mapSetting<T extends {
    channel: string;
    events: string;
    config: string;
    commandBotTokenHash?: string | null;
    telegramNextUpdateId?: string | null;
    telegramCommandsEnabledAt?: Date | null;
    telegramLeaseOwner?: string | null;
    telegramLeaseExpiresAt?: Date | null;
  }>(row: T) {
    const config = parseJsonObject<Record<string, unknown>>(row.config, {});
    const publicRow = { ...row } as Record<string, unknown>;
    delete publicRow.commandBotTokenHash;
    delete publicRow.telegramNextUpdateId;
    delete publicRow.telegramCommandsEnabledAt;
    delete publicRow.telegramLeaseOwner;
    delete publicRow.telegramLeaseExpiresAt;
    return {
      ...publicRow,
      events: parseStringArray(row.events),
      config: row.channel === NotificationChannel.TELEGRAM
        ? publicTelegramConfig(config)
        : config,
    };
  }
}
