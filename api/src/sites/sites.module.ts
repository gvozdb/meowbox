import { Module } from '@nestjs/common';
import { SitesService } from './sites.service';
import { SitesController } from './sites.controller';
import { ModxVersionsService } from './modx-versions.service';
import { SitesNginxService } from './sites-nginx.service';
import { SitesNginxController } from './sites-nginx.controller';
import { SiteDomainsService } from './site-domains.service';
import { SiteDomainsController } from './site-domains.controller';
import { PanelSettingsModule } from '../panel-settings/panel-settings.module';
import { DomainContextService } from './domain-context.service';
import { DomainApplicationsService } from './domain-applications.service';
import { SiteDuplicateService } from './site-duplicate.service';
import {
  DomainApplicationLoginController,
  DomainApplicationsController,
} from './domain-applications.controller';
import { BackupArtifactsModule } from '../backups/backup-artifacts.module';

@Module({
  imports: [PanelSettingsModule, BackupArtifactsModule],
  controllers: [
    SitesController,
    SitesNginxController,
    SiteDomainsController,
    DomainApplicationsController,
    DomainApplicationLoginController,
  ],
  providers: [
    SitesService,
    ModxVersionsService,
    SitesNginxService,
    SiteDomainsService,
    DomainContextService,
    DomainApplicationsService,
    SiteDuplicateService,
  ],
  exports: [
    SitesService,
    SiteDomainsService,
    DomainContextService,
    DomainApplicationsService,
  ],
})
export class SitesModule {}
