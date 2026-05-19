import { Module } from '@nestjs/common';
import { SiteNodeService } from './site-node.service';
import { SiteNodeController } from './site-node.controller';

@Module({
  controllers: [SiteNodeController],
  providers: [SiteNodeService],
  exports: [SiteNodeService],
})
export class SiteNodeModule {}
