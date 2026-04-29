import { Module } from '@nestjs/common';
import { SitesService } from './sites.service';
import { SitesController } from './sites.controller';
import { ModxVersionsService } from './modx-versions.service';
import { SitesNginxService } from './sites-nginx.service';
import { SitesNginxController } from './sites-nginx.controller';
import { PanelSettingsModule } from '../panel-settings/panel-settings.module';

@Module({
  imports: [PanelSettingsModule],
  controllers: [SitesController, SitesNginxController],
  providers: [SitesService, ModxVersionsService, SitesNginxService],
  exports: [SitesService],
})
export class SitesModule {}
