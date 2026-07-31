import { Module } from '@nestjs/common';
import { DeployService } from './deploy.service';
import { DeployController } from './deploy.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { SitesModule } from '../sites/sites.module';

@Module({
  imports: [NotificationsModule, SitesModule],
  controllers: [DeployController],
  providers: [DeployService],
  exports: [DeployService],
})
export class DeployModule {}
