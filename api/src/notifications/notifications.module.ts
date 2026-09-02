import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { NotificationDispatcherService } from './notification-dispatcher.service';
import { NotificationDigestService } from './notification-digest.service';
import { DashboardOverviewModule } from '../dashboard/dashboard-overview.module';
import { TelegramClientService } from './telegram-client.service';
import { TelegramCommandsService } from './telegram-commands.service';

@Module({
  imports: [DashboardOverviewModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationDispatcherService,
    NotificationDigestService,
    TelegramClientService,
    TelegramCommandsService,
  ],
  exports: [NotificationsService, NotificationDispatcherService, NotificationDigestService],
})
export class NotificationsModule {}
