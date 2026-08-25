import {
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import {
  FederationRequestState,
  isVerifiedFederationRequest,
} from '../federation/federation-request-context';
import { WebhookTargetDeliveryService } from './webhook-target-delivery.service';

@Controller('federation/v1/webhooks')
export class WebhookTargetDeliveryController {
  constructor(private readonly deliveries: WebhookTargetDeliveryService) {}

  @Post('deliveries/:deliveryId')
  @HttpCode(200)
  @Roles('SERVICE')
  async deliver(
    @Param('deliveryId', ParseUUIDPipe) deliveryId: string,
    @Headers('idempotency-key') _idempotencyKey: string | undefined,
    @Req() request: FederationRequestState,
  ) {
    if (
      !isVerifiedFederationRequest(request) ||
      request.federationContext.actorKind !== 'SERVICE' ||
      request.federationContext.role !== 'SERVICE'
    ) throw new ForbiddenException('Verified federation service is required');
    const body = request.body as { deliveryId?: unknown } | undefined;
    if (body?.deliveryId !== deliveryId) throw new ForbiddenException('Webhook delivery binding mismatch');
    return {
      success: true,
      data: await this.deliveries.deliver(request.body, {
        issuerInstallationId: request.federationContext.issuerInstallationId,
      }),
    };
  }
}
