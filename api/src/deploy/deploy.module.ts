import { Module } from '@nestjs/common';
import { DeployService } from './deploy.service';
import { DeployController } from './deploy.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [DeployController],
  providers: [DeployService],
  exports: [DeployService],
})
export class DeployModule {}
