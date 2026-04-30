import { Module } from '@nestjs/common';
import { ProxyController } from './proxy.controller';
import { ProxyService } from './proxy.service';
import { ProvisionService } from './provision.service';
import { ProxyAuditService } from './proxy-audit.service';
import { ProxyHealthcheckService } from './proxy-healthcheck.service';
import { PrismaService } from '../common/prisma.service';

@Module({
  controllers: [ProxyController],
  providers: [
    ProxyService,
    ProvisionService,
    ProxyAuditService,
    ProxyHealthcheckService,
    PrismaService,
  ],
  exports: [ProxyService, ProxyAuditService],
})
export class ProxyModule {}
