import { Module } from '@nestjs/common';
import { DeployModule } from '../deploy/deploy.module';
import { PublicDeliveryModule } from '../public-delivery/public-delivery.module';
import { PublicWebhookController } from './public-webhook.controller';
import { WebhookDeliveryWorkerService } from './webhook-delivery-worker.service';
import { WebhookIngressService } from './webhook-ingress.service';
import { WebhookManagementController } from './webhook-management.controller';
import { WebhookRouteService } from './webhook-route.service';
import { WebhookSpoolService } from './webhook-spool.service';
import { WebhookTargetDeliveryController } from './webhook-target-delivery.controller';
import { WebhookTargetDeliveryService } from './webhook-target-delivery.service';

@Module({
  imports: [DeployModule, PublicDeliveryModule],
  controllers: [
    WebhookManagementController,
    PublicWebhookController,
    WebhookTargetDeliveryController,
  ],
  providers: [
    WebhookRouteService,
    WebhookIngressService,
    WebhookSpoolService,
    WebhookTargetDeliveryService,
    WebhookDeliveryWorkerService,
  ],
  exports: [WebhookRouteService, WebhookIngressService, WebhookDeliveryWorkerService],
})
export class WebhooksModule {}
