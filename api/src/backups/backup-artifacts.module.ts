import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { StorageLocationsModule } from '../storage-locations/storage-locations.module';
import { BackupArtifactCleanupService } from './backup-artifact-cleanup.service';
import { BackupExportsController } from './backup-exports.controller';
import { BackupExportsService } from './backup-exports.service';

@Module({
  imports: [
    StorageLocationsModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      }),
    }),
  ],
  controllers: [BackupExportsController],
  providers: [BackupExportsService, BackupArtifactCleanupService],
  exports: [BackupExportsService, BackupArtifactCleanupService],
})
export class BackupArtifactsModule {}
