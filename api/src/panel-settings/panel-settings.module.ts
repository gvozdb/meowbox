import { Module } from '@nestjs/common';
import { PanelSettingsService } from './panel-settings.service';
import { PanelSettingsController } from './panel-settings.controller';
import { ProxyModule } from '../proxy/proxy.module';

@Module({
  imports: [ProxyModule],
  controllers: [PanelSettingsController],
  providers: [PanelSettingsService],
  exports: [PanelSettingsService],
})
export class PanelSettingsModule {}
