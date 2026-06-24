import { Module } from '@nestjs/common';
import { MigrationController } from './migration.controller';
import { MigrationService } from './migration.service';
import { ProxyModule } from '../proxy/proxy.module';
import { SitesModule } from '../sites/sites.module';

@Module({
  imports: [ProxyModule, SitesModule],
  controllers: [MigrationController],
  providers: [MigrationService],
})
export class MigrationModule {}
