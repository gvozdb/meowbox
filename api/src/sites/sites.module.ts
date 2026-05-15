import { Module } from '@nestjs/common';
import { SitesService } from './sites.service';
import { SitesController } from './sites.controller';
import { ModxVersionsService } from './modx-versions.service';
import { SitesNginxService } from './sites-nginx.service';
import { SitesNginxController } from './sites-nginx.controller';
import { SiteDomainsService } from './site-domains.service';
import { SiteDomainsController } from './site-domains.controller';
import { PanelSettingsModule } from '../panel-settings/panel-settings.module';

@Module({
  imports: [PanelSettingsModule],
  controllers: [SitesController, SitesNginxController, SiteDomainsController],
  providers: [SitesService, ModxVersionsService, SitesNginxService, SiteDomainsService],
  exports: [SitesService, SiteDomainsService],
})
export class SitesModule {}
