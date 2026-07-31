import { Module } from '@nestjs/common';
import { SiteNodeService } from './site-node.service';
import { SiteNodeController } from './site-node.controller';
import { SitesModule } from '../sites/sites.module';

@Module({
  imports: [SitesModule],
  controllers: [SiteNodeController],
  providers: [SiteNodeService],
  exports: [SiteNodeService],
})
export class SiteNodeModule {}
