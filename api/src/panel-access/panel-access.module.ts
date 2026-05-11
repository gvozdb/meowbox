import { Module } from '@nestjs/common';
import { PanelAccessController } from './panel-access.controller';
import { PanelAccessService } from './panel-access.service';
import { PanelSettingsModule } from '../panel-settings/panel-settings.module';

@Module({
  imports: [PanelSettingsModule],
  controllers: [PanelAccessController],
  providers: [PanelAccessService],
  exports: [PanelAccessService],
})
export class PanelAccessModule {}
