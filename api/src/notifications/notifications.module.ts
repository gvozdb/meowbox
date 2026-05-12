import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { NotificationDispatcherService } from './notification-dispatcher.service';
import { NotificationDigestService } from './notification-digest.service';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationDispatcherService, NotificationDigestService],
  exports: [NotificationsService, NotificationDispatcherService, NotificationDigestService],
})
export class NotificationsModule {}
