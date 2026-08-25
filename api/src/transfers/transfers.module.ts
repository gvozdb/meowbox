import { Module } from '@nestjs/common';
import { PublicDeliveryModule } from '../public-delivery/public-delivery.module';
import { TransferArtifactService } from './transfer-artifact.service';
import { TransferController } from './transfer.controller';
import { TransferSessionService } from './transfer-session.service';

@Module({
  imports: [PublicDeliveryModule],
  controllers: [TransferController],
  providers: [TransferSessionService, TransferArtifactService],
  exports: [TransferSessionService, TransferArtifactService, PublicDeliveryModule],
})
export class TransfersModule {}
