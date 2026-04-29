import { Module } from '@nestjs/common';
import { ProxyController } from './proxy.controller';
import { ProxyService } from './proxy.service';
import { ProvisionService } from './provision.service';

@Module({
  controllers: [ProxyController],
  providers: [ProxyService, ProvisionService],
  exports: [ProxyService],
})
export class ProxyModule {}
