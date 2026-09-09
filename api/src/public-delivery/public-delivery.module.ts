import { Module } from '@nestjs/common';
import { FederationModule } from '../federation/federation.module';
import { PanelSettingsModule } from '../panel-settings/panel-settings.module';
import { PublicDeliveryOriginService } from './public-delivery-origin.service';

@Module({
  imports: [FederationModule, PanelSettingsModule],
  providers: [PublicDeliveryOriginService],
  exports: [PublicDeliveryOriginService, FederationModule],
})
export class PublicDeliveryModule {}
