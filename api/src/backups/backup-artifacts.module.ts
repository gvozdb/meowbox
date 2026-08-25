import { Module } from '@nestjs/common';
import { StorageLocationsModule } from '../storage-locations/storage-locations.module';
import { TransfersModule } from '../transfers/transfers.module';
import { BackupArtifactCleanupService } from './backup-artifact-cleanup.service';
import { BackupExportsController } from './backup-exports.controller';
import { BackupExportsService } from './backup-exports.service';

@Module({
  imports: [
    StorageLocationsModule,
    TransfersModule,
  ],
  controllers: [BackupExportsController],
  providers: [BackupExportsService, BackupArtifactCleanupService],
  exports: [BackupExportsService, BackupArtifactCleanupService],
})
export class BackupArtifactsModule {}
