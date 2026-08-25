import {
  Controller,
  Get,
  Header,
  Param,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { extractClientIp } from '../common/http/client-ip';
import { FederatedVpnSubscriptionService } from './federated-vpn-subscription.service';

@Controller('public/v1/vpn/subscriptions')
export class PublicFederatedVpnSubscriptionController {
  constructor(private readonly subscriptions: FederatedVpnSubscriptionService) {}

  @Public()
  @Get(':token')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  @Throttle({ short: { ttl: 60_000, limit: 30 } })
  async get(
    @Param('token') token: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const result = await this.subscriptions.publicSubscription(
      token,
      extractClientIp(request),
    );
    response.setHeader('X-Meowbox-VPN-State', result.state);
    response.send(result.content);
  }
}
