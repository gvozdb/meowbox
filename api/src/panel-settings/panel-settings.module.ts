import { Module } from '@nestjs/common';
import { PanelSettingsService } from './panel-settings.service';
import { PanelSettingsController } from './panel-settings.controller';

@Module({
  controllers: [PanelSettingsController],
  providers: [PanelSettingsService],
  exports: [PanelSettingsService],
})
export class PanelSettingsModule {}
