import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { getOrCreateNetworkContext } from '../common/http/network-context';
import { FederationTrustLifecycleService } from './federation-trust-lifecycle.service';

interface AuthCtx {
  id: string;
  role: 'ADMIN';
}

function rotationGraceSeconds(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Key rotation body must be an object');
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== 'graceSeconds')) {
    throw new BadRequestException('Key rotation body contains unknown fields');
  }
  const graceSeconds = body.graceSeconds ?? 3_600;
  if (!Number.isSafeInteger(graceSeconds) || Number(graceSeconds) < 60 || Number(graceSeconds) > 86_400) {
    throw new BadRequestException('graceSeconds must be an integer between 60 and 86400');
  }
  return Number(graceSeconds);
}

@Controller('servers/:id/federation-keys')
@Roles('ADMIN')
export class FederationTrustLifecycleController {
  constructor(private readonly lifecycle: FederationTrustLifecycleService) {}

  @Post('rotate')
  @Throttle({ default: { limit: 2, ttl: 300_000 } })
  async rotate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthCtx,
    @Req() request: Request,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    const graceSeconds = rotationGraceSeconds(body);
    const network = getOrCreateNetworkContext(request);
    return {
      success: true,
      data: await this.lifecycle.rotate(
        id,
        {
          id: user.id,
          role: user.role,
          browserIp: network.browserIp,
          peerIp: network.peerIp,
          userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
        },
        idempotencyKey,
        graceSeconds,
      ),
    };
  }

  @Post('revoke')
  @Throttle({ default: { limit: 2, ttl: 300_000 } })
  async revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthCtx,
    @Req() request: Request,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    const network = getOrCreateNetworkContext(request);
    return {
      success: true,
      data: await this.lifecycle.revoke(
        id,
        {
          id: user.id,
          role: user.role,
          browserIp: network.browserIp,
          peerIp: network.peerIp,
          userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
        },
        idempotencyKey,
      ),
    };
  }
}
