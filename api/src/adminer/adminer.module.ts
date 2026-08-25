import { Module } from '@nestjs/common';
import { PublicDeliveryModule } from '../public-delivery/public-delivery.module';
import { AdminerHandoffController } from './adminer-handoff.controller';
import { AdminerHandoffService } from './adminer-handoff.service';

@Module({
  imports: [PublicDeliveryModule],
  controllers: [AdminerHandoffController],
  providers: [AdminerHandoffService],
  exports: [AdminerHandoffService],
})
export class AdminerModule {}
