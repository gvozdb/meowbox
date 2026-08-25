import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import {
  getOrCreateNetworkContext,
  NetworkContextRequest,
} from '../common/http/network-context';
import {
  ConfirmPanelAccessCutoverDto,
  StartPanelAccessCutoverDto,
} from './panel-access.dto';
import { PanelAccessCutoverCoordinatorService } from './panel-access-cutover-coordinator.service';

@Controller('servers/:serverId/panel-access/cutovers')
@Roles('ADMIN')
export class PanelAccessCutoverController {
  constructor(private readonly cutovers: PanelAccessCutoverCoordinatorService) {}

  @Post()
  @Throttle({ default: { limit: 3, ttl: 300_000 } })
  async start(
    @Param('serverId', ParseUUIDPipe) serverId: string,
    @Body() body: StartPanelAccessCutoverDto,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: 'ADMIN',
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Request,
  ) {
    const browserIp = getOrCreateNetworkContext(
      request as unknown as NetworkContextRequest,
    ).browserIp;
    return {
      success: true,
      data: await this.cutovers.start(
        serverId,
        body,
        { id: userId, role },
        browserIp,
        idempotencyKey,
      ),
    };
  }

  @Get(':cutoverId')
  async get(
    @Param('serverId', ParseUUIDPipe) serverId: string,
    @Param('cutoverId', ParseUUIDPipe) cutoverId: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: 'ADMIN',
    @Req() request: Request,
  ) {
    const browserIp = getOrCreateNetworkContext(
      request as unknown as NetworkContextRequest,
    ).browserIp;
    return {
      success: true,
      data: await this.cutovers.get(
        serverId,
        cutoverId,
        { id: userId, role },
        browserIp,
      ),
    };
  }

  @Post(':cutoverId/confirm-browser')
  async confirmBrowser(
    @Param('serverId', ParseUUIDPipe) serverId: string,
    @Param('cutoverId', ParseUUIDPipe) cutoverId: string,
    @Body() body: ConfirmPanelAccessCutoverDto,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: 'ADMIN',
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Request,
  ) {
    const browserIp = getOrCreateNetworkContext(
      request as unknown as NetworkContextRequest,
    ).browserIp;
    return {
      success: true,
      data: await this.cutovers.confirmBrowser(
        serverId,
        cutoverId,
        body.candidateOrigin,
        { id: userId, role },
        browserIp,
        idempotencyKey,
      ),
    };
  }

  @Post(':cutoverId/rollback')
  async rollback(
    @Param('serverId', ParseUUIDPipe) serverId: string,
    @Param('cutoverId', ParseUUIDPipe) cutoverId: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: 'ADMIN',
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Request,
  ) {
    const browserIp = getOrCreateNetworkContext(
      request as unknown as NetworkContextRequest,
    ).browserIp;
    return {
      success: true,
      data: await this.cutovers.rollback(
        serverId,
        cutoverId,
        { id: userId, role },
        browserIp,
        idempotencyKey,
      ),
    };
  }
}
