import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { NotificationDispatcherService } from './notification-dispatcher.service';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationDispatcherService],
  exports: [NotificationsService, NotificationDispatcherService],
})
export class NotificationsModule {}
