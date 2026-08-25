import { Module } from '@nestjs/common';
import { VpnController } from './vpn.controller';
import { VpnService } from './vpn.service';
import { VpnRegistry } from './vpn.registry';
import { XrayRealityProvider } from './providers/xray-reality.provider';
import { AmneziaWgProvider } from './providers/amnezia-wg.provider';
import { GatewayModule } from '../gateway/gateway.module';
import { VpnSniCron } from './vpn.cron';
import { NotificationsModule } from '../notifications/notifications.module';
import { PublicDeliveryModule } from '../public-delivery/public-delivery.module';
import { FederatedVpnFragmentController } from './federated-vpn-fragment.controller';
import { FederatedVpnFragmentService } from './federated-vpn-fragment.service';
import {
  FederatedVpnSubscriptionController,
} from './federated-vpn-subscription.controller';
import { PublicFederatedVpnSubscriptionController } from './public-federated-vpn-subscription.controller';
import { FederatedVpnSubscriptionService } from './federated-vpn-subscription.service';

@Module({
  imports: [GatewayModule, NotificationsModule, PublicDeliveryModule],
  controllers: [
    VpnController,
    FederatedVpnFragmentController,
    FederatedVpnSubscriptionController,
    PublicFederatedVpnSubscriptionController,
  ],
  providers: [
    VpnService,
    VpnRegistry,
    XrayRealityProvider,
    AmneziaWgProvider,
    VpnSniCron,
    FederatedVpnFragmentService,
    FederatedVpnSubscriptionService,
  ],
  exports: [VpnService],
})
export class VpnModule {}
