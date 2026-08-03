import { Module } from '@nestjs/common';
import { BackupsService } from './backups.service';
import { BackupsController } from './backups.controller';
import { ResticCheckService } from './restic-check.service';
import { ServerPathBackupService } from './server-path-backup.service';
import { ServerPathBackupController } from './server-path-backup.controller';
import { PanelDataBackupService } from './panel-data-backup.service';
import { PanelDataBackupController } from './panel-data-backup.controller';
import { SiteBackupScheduleService } from './site-backup-schedule.service';
import { SiteBackupScheduleController } from './site-backup-schedule.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { StorageLocationsModule } from '../storage-locations/storage-locations.module';
import { PanelSettingsModule } from '../panel-settings/panel-settings.module';
import { SitesModule } from '../sites/sites.module';
import { BackupArtifactsModule } from './backup-artifacts.module';
import { ResticRepositoryRetentionService } from './restic-repository-retention.service';

@Module({
  imports: [
    NotificationsModule,
    StorageLocationsModule,
    PanelSettingsModule,
    SitesModule,
    BackupArtifactsModule,
  ],
  controllers: [
    BackupsController,
    ServerPathBackupController,
    PanelDataBackupController,
    SiteBackupScheduleController,
  ],
  providers: [
    BackupsService,
    ResticCheckService,
    ServerPathBackupService,
    PanelDataBackupService,
    ResticRepositoryRetentionService,
    SiteBackupScheduleService,
  ],
  exports: [
    BackupsService,
    ResticCheckService,
    BackupArtifactsModule,
    ServerPathBackupService,
    PanelDataBackupService,
    SiteBackupScheduleService,
  ],
})
export class BackupsModule {}
