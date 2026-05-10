import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BackupsService } from './backups.service';
import { BackupsController } from './backups.controller';
import { ResticCheckService } from './restic-check.service';
import { BackupExportsService } from './backup-exports.service';
import { BackupExportsController } from './backup-exports.controller';
import { ServerPathBackupService } from './server-path-backup.service';
import { ServerPathBackupController } from './server-path-backup.controller';
import { PanelDataBackupService } from './panel-data-backup.service';
import { PanelDataBackupController } from './panel-data-backup.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { StorageLocationsModule } from '../storage-locations/storage-locations.module';
import { PanelSettingsModule } from '../panel-settings/panel-settings.module';

@Module({
  imports: [
    NotificationsModule,
    StorageLocationsModule,
    PanelSettingsModule,
    // JWT для подписи/проверки one-shot download-токенов в STREAM-экспорте.
    // Используем тот же ACCESS_SECRET что и для обычной auth.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      }),
    }),
  ],
  controllers: [
    BackupsController,
    BackupExportsController,
    ServerPathBackupController,
    PanelDataBackupController,
  ],
  providers: [
    BackupsService,
    ResticCheckService,
    BackupExportsService,
    ServerPathBackupService,
    PanelDataBackupService,
  ],
  exports: [
    BackupsService,
    ResticCheckService,
    BackupExportsService,
    ServerPathBackupService,
    PanelDataBackupService,
  ],
})
export class BackupsModule {}
