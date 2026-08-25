import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PanelUpdateService } from './panel-update.service';
import { PanelUpdateController } from './panel-update.controller';
import { FederationModule } from '../federation/federation.module';
import { FederatedTargetUpdateController } from './federated-target-update.controller';

@Module({
  imports: [ConfigModule, FederationModule],
  controllers: [PanelUpdateController, FederatedTargetUpdateController],
  providers: [PanelUpdateService],
  exports: [PanelUpdateService],
})
export class PanelUpdateModule {}
