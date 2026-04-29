import { Module } from '@nestjs/common';
import { PhpService } from './php.service';
import { PhpController } from './php.controller';

@Module({
  controllers: [PhpController],
  providers: [PhpService],
  exports: [PhpService],
})
export class PhpModule {}
