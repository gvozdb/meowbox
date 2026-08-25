import { Module } from '@nestjs/common';
import { ProxyController } from './proxy.controller';
import { ProxyService } from './proxy.service';
import { ProxyAuditService } from './proxy-audit.service';
import { ProxyHealthcheckService } from './proxy-healthcheck.service';
import { PrismaService } from '../common/prisma.service';
import { FederationModule } from '../federation/federation.module';
import { FederatedFleetUpdateService } from './federated-fleet-update.service';
import { FederationTrustLifecycleController } from './federation-trust-lifecycle.controller';
import { FederationTrustLifecycleService } from './federation-trust-lifecycle.service';

@Module({
  imports: [FederationModule],
  controllers: [ProxyController, FederationTrustLifecycleController],
  providers: [
    ProxyService,
    ProxyAuditService,
    ProxyHealthcheckService,
    FederatedFleetUpdateService,
    FederationTrustLifecycleService,
    PrismaService,
  ],
  exports: [ProxyService, ProxyAuditService],
})
export class ProxyModule {}
