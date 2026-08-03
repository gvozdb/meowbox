import { Module } from '@nestjs/common';
import { DatabasesService } from './databases.service';
import { DatabasesController } from './databases.controller';
import { DatabaseCatalogController } from './database-catalog.controller';
import { SitesModule } from '../sites/sites.module';

@Module({
  imports: [SitesModule],
  controllers: [DatabasesController, DatabaseCatalogController],
  providers: [DatabasesService],
  exports: [DatabasesService],
})
export class DatabasesModule {}
