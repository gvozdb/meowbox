import { Module } from '@nestjs/common';

import { PrismaService } from '../common/prisma.service';

import { IpAllowlistController } from './ip-allowlist.controller';
import { IpAllowlistGuard } from './ip-allowlist.guard';
import { IpAllowlistService } from './ip-allowlist.service';

@Module({
  controllers: [IpAllowlistController],
  providers: [IpAllowlistService, IpAllowlistGuard, PrismaService],
  exports: [IpAllowlistService, IpAllowlistGuard],
})
export class AdminSecurityModule {}
