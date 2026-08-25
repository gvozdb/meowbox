import { Module } from '@nestjs/common';
import { FirewallService } from './firewall.service';
import { FirewallController } from './firewall.controller';
import { FirewallOperationsService } from './firewall-operations.service';

@Module({
  controllers: [FirewallController],
  providers: [FirewallService, FirewallOperationsService],
  exports: [FirewallService],
})
export class FirewallModule {}
