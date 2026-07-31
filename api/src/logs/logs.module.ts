import { Module } from '@nestjs/common';
import { LogsService } from './logs.service';
import { LogsController, LogsCentralController } from './logs.controller';
import { SitesModule } from '../sites/sites.module';

@Module({
  imports: [SitesModule],
  controllers: [LogsController, LogsCentralController],
  providers: [LogsService],
  exports: [LogsService],
})
export class LogsModule {}
