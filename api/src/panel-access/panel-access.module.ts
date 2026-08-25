import { Module } from '@nestjs/common';
import { PanelAccessController } from './panel-access.controller';
import { PanelAccessService } from './panel-access.service';
import { PanelAccessCutoverTargetService } from './panel-access-cutover-target.service';
import { PanelAccessCutoverCoordinatorService } from './panel-access-cutover-coordinator.service';
import { PanelAccessCutoverController } from './panel-access-cutover.controller';
import { FederationModule } from '../federation/federation.module';
import { PanelSettingsModule } from '../panel-settings/panel-settings.module';

@Module({
  imports: [PanelSettingsModule, FederationModule],
  controllers: [PanelAccessController, PanelAccessCutoverController],
  providers: [
    PanelAccessService,
    PanelAccessCutoverTargetService,
    PanelAccessCutoverCoordinatorService,
  ],
  exports: [PanelAccessService, PanelAccessCutoverTargetService],
})
export class PanelAccessModule {}
