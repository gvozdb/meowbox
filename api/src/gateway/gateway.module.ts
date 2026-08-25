import { Global, Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AgentGateway } from './agent.gateway';
import { AgentRelayService } from './agent-relay.service';
import { DeployModule } from '../deploy/deploy.module';
import { BackupsModule } from '../backups/backups.module';
import { SslModule } from '../ssl/ssl.module';
import { SitesModule } from '../sites/sites.module';
import { LogsModule } from '../logs/logs.module';
import { AiModule } from '../ai/ai.module';
import { MigrationHostpanelModule } from '../migration-hostpanel/migration-hostpanel.module';
import { OperationsModule } from '../operations/operations.module';
import { FederationModule } from '../federation/federation.module';
import { FederatedSocketBridgeService } from './federated-socket-bridge.service';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      }),
    }),
    forwardRef(() => DeployModule),
    forwardRef(() => BackupsModule),
    forwardRef(() => SslModule),
    forwardRef(() => SitesModule),
    forwardRef(() => LogsModule),
    forwardRef(() => AiModule),
    forwardRef(() => MigrationHostpanelModule),
    OperationsModule,
    FederationModule,
  ],
  providers: [AgentGateway, AgentRelayService, FederatedSocketBridgeService],
  exports: [AgentRelayService, AgentGateway, FederatedSocketBridgeService],
})
export class GatewayModule {}
