import {
  Controller,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { WebhookIngressService } from './webhook-ingress.service';

interface RawWebhookRequest {
  body?: unknown;
  rawHeaders?: string[];
}

@Controller('public/v1/webhooks')
export class PublicWebhookController {
  constructor(private readonly ingress: WebhookIngressService) {}

  @Post(':token')
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async accept(
    @Param('token') token: string,
    @Req() request: RawWebhookRequest,
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (!Buffer.isBuffer(request.body) || !Array.isArray(request.rawHeaders)) {
      response.status(400).json({ success: false, message: 'Invalid webhook request' });
      return;
    }
    const result = await this.ingress.accept(token, request.rawHeaders, request.body);
    if (result.ignored) {
      response.status(204).send();
      return;
    }
    response.status(202).json({ success: true, accepted: true });
  }
}
