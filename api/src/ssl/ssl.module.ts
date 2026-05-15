import { Module, forwardRef } from '@nestjs/common';
import { SslService } from './ssl.service';
import { SslController, SslOverviewController } from './ssl.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { SitesModule } from '../sites/sites.module';

@Module({
  imports: [NotificationsModule, forwardRef(() => SitesModule)],
  controllers: [SslController, SslOverviewController],
  providers: [SslService],
  exports: [SslService],
})
export class SslModule {}
