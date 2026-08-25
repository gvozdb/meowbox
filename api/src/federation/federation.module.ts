import { Module } from '@nestjs/common';
import { FederatedPrincipalService } from './federated-principal.service';
import { FederationHealthController } from './federation-health.controller';
import { FederationManifestAccessGuard } from './federation-manifest-access.guard';
import { FederationManifestController } from './federation-manifest.controller';
import { FederationManifestService } from './federation-manifest.service';
import { FederationReplayService } from './federation-replay.service';
import { PanelIdentityService } from './panel-identity.service';
import { ServicePrincipalService } from './service-principal.service';
import { LegacyRegistryFileService } from './legacy-registry-file.service';
import { RegistryImportService } from './registry-import.service';
import { RemoteRegistryService } from './remote-registry.service';
import { RemoteContextController } from './remote-context.controller';
import { RemoteContextService } from './remote-context.service';
import { FederationActionCatalogueService } from './federation-action-catalogue.service';
import { FederationDelegationGuard } from './federation-delegation.guard';
import { FederationDelegationVerifierService } from './federation-delegation-verifier.service';
import { FederationIdempotencyService } from './federation-idempotency.service';
import { FederationDispatcherPoolService } from './federation-dispatcher-pool.service';
import { FederationDispatcherService } from './federation-dispatcher.service';
import { FederationLocalEndpointService } from './federation-local-endpoint.service';
import { FederationCompatibilityService } from './federation-compatibility.service';
import { FederationManifestVerifierService } from './federation-manifest-verifier.service';
import { FederationEnrollmentBootstrapGuard } from './federation-enrollment-bootstrap.guard';
import { FederationEnrollmentController } from './federation-enrollment.controller';
import { FederationEnrollmentService } from './federation-enrollment.service';
import { FederationEnrollmentHttpService } from './federation-enrollment-http.service';
import { FederationEnrollmentSshService } from './federation-enrollment-ssh.service';
import { FederationMasterEnrollmentController } from './federation-master-enrollment.controller';
import { FederationMasterEnrollmentService } from './federation-master-enrollment.service';
import { FederatedSocketPolicyService } from './federated-socket-policy';
import { FederationWsChannelIssuerService } from './federation-ws-channel-issuer.service';
import { FederationWsChannelVerifierService } from './federation-ws-channel-verifier.service';
import { FederationRolloutController } from './federation-rollout.controller';
import { FederationTrustTargetController } from './federation-trust-target.controller';
import { FederationTrustTargetService } from './federation-trust-target.service';

@Module({
  controllers: [
    FederationMasterEnrollmentController,
    FederationEnrollmentController,
    FederationHealthController,
    FederationManifestController,
    FederationRolloutController,
    FederationTrustTargetController,
    RemoteContextController,
  ],
  providers: [
    FederatedPrincipalService,
    FederationActionCatalogueService,
    FederationDelegationGuard,
    FederationDelegationVerifierService,
    FederationIdempotencyService,
    FederationDispatcherPoolService,
    FederationDispatcherService,
    FederationCompatibilityService,
    FederationEnrollmentBootstrapGuard,
    FederationEnrollmentHttpService,
    FederationEnrollmentService,
    FederationEnrollmentSshService,
    FederationMasterEnrollmentService,
    FederatedSocketPolicyService,
    FederationWsChannelIssuerService,
    FederationWsChannelVerifierService,
    FederationLocalEndpointService,
    FederationManifestAccessGuard,
    FederationManifestService,
    FederationManifestVerifierService,
    FederationReplayService,
    FederationTrustTargetService,
    LegacyRegistryFileService,
    PanelIdentityService,
    RegistryImportService,
    RemoteContextService,
    RemoteRegistryService,
    ServicePrincipalService,
  ],
  exports: [
    FederatedPrincipalService,
    FederationActionCatalogueService,
    FederationDelegationGuard,
    FederationDelegationVerifierService,
    FederationIdempotencyService,
    FederationDispatcherService,
    FederationCompatibilityService,
    FederationEnrollmentBootstrapGuard,
    FederationEnrollmentHttpService,
    FederationEnrollmentService,
    FederationEnrollmentSshService,
    FederationMasterEnrollmentService,
    FederatedSocketPolicyService,
    FederationWsChannelIssuerService,
    FederationWsChannelVerifierService,
    FederationLocalEndpointService,
    FederationManifestService,
    FederationManifestVerifierService,
    FederationReplayService,
    FederationTrustTargetService,
    PanelIdentityService,
    RegistryImportService,
    RemoteContextService,
    RemoteRegistryService,
    ServicePrincipalService,
  ],
})
export class FederationModule {}
