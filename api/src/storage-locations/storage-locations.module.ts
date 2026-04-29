import { Module } from '@nestjs/common';
import { StorageLocationsService } from './storage-locations.service';
import { StorageLocationsController } from './storage-locations.controller';

@Module({
  controllers: [StorageLocationsController],
  providers: [StorageLocationsService],
  exports: [StorageLocationsService],
})
export class StorageLocationsModule {}
