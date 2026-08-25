import { Body, Controller, Get, Headers, Post, Req } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { FederationRequestState } from './federation-request-context';
import { FederationTrustTargetService } from './federation-trust-target.service';

@Controller('federation/v1/trust')
@Roles('ADMIN')
export class FederationTrustTargetController {
  constructor(private readonly trust: FederationTrustTargetService) {}

  @Get('keys')
  async keys(@Req() request: FederationRequestState) {
    return { success: true, data: await this.trust.list(request) };
  }

  @Post('keys')
  async rotate(
    @Req() request: FederationRequestState,
    @Body() body: unknown,
    @Headers('idempotency-key') _idempotencyKey: string | undefined,
  ) {
    return { success: true, data: await this.trust.rotate(request, body) };
  }

  @Post('revoke')
  async revoke(
    @Req() request: FederationRequestState,
    @Headers('idempotency-key') _idempotencyKey: string | undefined,
  ) {
    return { success: true, data: await this.trust.revoke(request) };
  }
}

