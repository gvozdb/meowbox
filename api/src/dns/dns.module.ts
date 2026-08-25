import { Module } from '@nestjs/common';
import { DnsController } from './dns.controller';
import { DnsService } from './dns.service';
import { DnsOperationsService } from './dns-operations.service';

@Module({
  controllers: [DnsController],
  providers: [DnsService, DnsOperationsService],
  exports: [DnsService],
})
export class DnsModule {}
