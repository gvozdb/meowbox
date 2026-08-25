import { Module } from '@nestjs/common';
import { DatabasesService } from './databases.service';
import { DatabasesController } from './databases.controller';
import { DatabaseCatalogController } from './database-catalog.controller';
import { SitesModule } from '../sites/sites.module';
import { AdminerModule } from '../adminer/adminer.module';
import { DatabaseOperationsService } from './database-operations.service';
import { TransfersModule } from '../transfers/transfers.module';

@Module({
  imports: [SitesModule, AdminerModule, TransfersModule],
  controllers: [DatabasesController, DatabaseCatalogController],
  providers: [DatabasesService, DatabaseOperationsService],
  exports: [DatabasesService, DatabaseOperationsService],
})
export class DatabasesModule {}
