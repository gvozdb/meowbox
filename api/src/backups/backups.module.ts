import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BackupsService } from './backups.service';
import { BackupsController } from './backups.controller';
import { ResticCheckService } from './restic-check.service';
import { BackupExportsService } from './backup-exports.service';
import { BackupExportsController } from './backup-exports.controller';
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
  controllers: [BackupsController, BackupExportsController],
  providers: [BackupsService, ResticCheckService, BackupExportsService],
  exports: [BackupsService, ResticCheckService, BackupExportsService],
})
export class BackupsModule {}
