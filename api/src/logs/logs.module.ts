import { Module } from '@nestjs/common';
import { LogsService } from './logs.service';
import { LogsController, LogsCentralController } from './logs.controller';

@Module({
  controllers: [LogsController, LogsCentralController],
  providers: [LogsService],
  exports: [LogsService],
})
export class LogsModule {}
