import { Module } from '@nestjs/common';

import { SystemCronController } from './system-cron.controller';
import { SystemCronService } from './system-cron.service';

@Module({
  controllers: [SystemCronController],
  providers: [SystemCronService],
  exports: [SystemCronService],
})
export class SystemCronModule {}
