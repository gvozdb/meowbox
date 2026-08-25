import { Global, Module } from '@nestjs/common';
import { FederationModule } from '../federation/federation.module';
import { OperationsController } from './operations.controller';
import { OperationsService } from './operations.service';
import { OperationsWorkerService } from './operations-worker.service';
import { RemoteOperationLinkService } from './remote-operation-link.service';
import { AgentJobService } from './agent-job.service';
import { OperationAdmissionService } from './operation-admission.service';
import { OperationSensitiveResultService } from './operation-sensitive-result.service';

@Global()
@Module({
  imports: [FederationModule],
  controllers: [OperationsController],
  providers: [
    OperationsService,
    OperationsWorkerService,
    RemoteOperationLinkService,
    AgentJobService,
    OperationAdmissionService,
    OperationSensitiveResultService,
  ],
  exports: [
    OperationsService,
    OperationsWorkerService,
    RemoteOperationLinkService,
    AgentJobService,
    OperationAdmissionService,
    OperationSensitiveResultService,
  ],
})
export class OperationsModule {}
