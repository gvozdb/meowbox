import { Module } from '@nestjs/common';
import { MigrationController } from './migration.controller';
import { MigrationService } from './migration.service';
import { ProxyModule } from '../proxy/proxy.module';
import { SitesModule } from '../sites/sites.module';
import { ServicesModule } from '../services/services.module';
import { SiteNodeModule } from '../site-node/site-node.module';

@Module({
  imports: [ProxyModule, SitesModule, ServicesModule, SiteNodeModule],
  controllers: [MigrationController],
  providers: [MigrationService],
})
export class MigrationModule {}
