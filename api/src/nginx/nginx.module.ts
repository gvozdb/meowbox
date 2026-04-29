import { Module } from '@nestjs/common';
import { NginxService } from './nginx.service';
import { NginxController } from './nginx.controller';

@Module({
  controllers: [NginxController],
  providers: [NginxService],
  exports: [NginxService],
})
export class NginxModule {}
