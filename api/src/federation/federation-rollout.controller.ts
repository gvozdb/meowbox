import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { createHash } from 'node:crypto';
import { Roles } from '../common/decorators/roles.decorator';
import { parseFederationRolloutRequest } from './federation-rollout-policy';
import { RemoteRegistryService } from './remote-registry.service';

function rolloutRequestKeyHash(serverId: string, value: string | undefined): string {
  if (!value || value.length < 8 || value.length > 128 || !/^[\x20-\x7e]+$/.test(value)) {
    throw new BadRequestException(
      'Idempotency-Key must be 8-128 printable ASCII characters',
    );
  }
  return createHash('sha256').update(`${serverId}\n${value}`).digest('hex');
}

@Controller('servers/:id/federation-rollout')
@Roles('ADMIN', 'MANAGER')
export class FederationRolloutController {
  constructor(private readonly registry: RemoteRegistryService) {}

  @Get()
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.registry.getFederationRollout(id) };
  }

  @Patch()
  @Roles('ADMIN')
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    const request = parseFederationRolloutRequest(body);
    return {
      success: true,
      data: await this.registry.updateFederationRollout({
        ...request,
        serverId: id,
        requestKeyHash: rolloutRequestKeyHash(id, idempotencyKey),
      }),
    };
  }
}

