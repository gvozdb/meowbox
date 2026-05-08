import { Module } from '@nestjs/common';
import { VpnController } from './vpn.controller';
import { VpnService } from './vpn.service';
import { VpnRegistry } from './vpn.registry';
import { XrayRealityProvider } from './providers/xray-reality.provider';
import { AmneziaWgProvider } from './providers/amnezia-wg.provider';
import { GatewayModule } from '../gateway/gateway.module';
import { VpnSniCron } from './vpn.cron';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [GatewayModule, NotificationsModule],
  controllers: [VpnController],
  providers: [
    VpnService,
    VpnRegistry,
    XrayRealityProvider,
    AmneziaWgProvider,
    VpnSniCron,
  ],
  exports: [VpnService],
})
export class VpnModule {}
