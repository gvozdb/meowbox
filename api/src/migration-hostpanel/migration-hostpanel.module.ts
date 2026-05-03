import { Module } from '@nestjs/common';

import { ServicesModule } from '../services/services.module';
import { MigrationHostpanelController } from './migration-hostpanel.controller';
import { MigrationHostpanelService } from './migration-hostpanel.service';

@Module({
  imports: [ServicesModule],
  controllers: [MigrationHostpanelController],
  providers: [MigrationHostpanelService],
  exports: [MigrationHostpanelService],
})
export class MigrationHostpanelModule {}
