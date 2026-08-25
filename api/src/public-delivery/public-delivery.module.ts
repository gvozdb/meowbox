import { Module } from '@nestjs/common';
import { FederationModule } from '../federation/federation.module';
import { PublicDeliveryOriginService } from './public-delivery-origin.service';

@Module({
  imports: [FederationModule],
  providers: [PublicDeliveryOriginService],
  exports: [PublicDeliveryOriginService, FederationModule],
})
export class PublicDeliveryModule {}
