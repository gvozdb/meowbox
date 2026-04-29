import { Module } from '@nestjs/common';
import { SslService } from './ssl.service';
import { SslController, SslOverviewController } from './ssl.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [SslController, SslOverviewController],
  providers: [SslService],
  exports: [SslService],
})
export class SslModule {}
