import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { extractClientIp } from '../common/http/client-ip';
import {
  AddFederatedVpnSubscriptionSourceDto,
  CreateFederatedVpnSubscriptionDto,
  ReorderFederatedVpnSubscriptionSourcesDto,
} from './federated-vpn.dto';
import { FederatedVpnSubscriptionService } from './federated-vpn-subscription.service';

@Controller('servers')
@Roles('ADMIN')
export class FederatedVpnSubscriptionController {
  constructor(private readonly subscriptions: FederatedVpnSubscriptionService) {}

  @Post(':serverId/vpn-subscriptions')
  async create(
    @Param('serverId') serverId: string,
    @Body() dto: CreateFederatedVpnSubscriptionDto,
    @CurrentUser('sub') actorUserId: string,
    @Req() request: Request,
  ) {
    return {
      success: true,
      data: await this.subscriptions.createOrGet(
        serverId,
        dto.vpnUserId,
        actorUserId,
        extractClientIp(request),
      ),
    };
  }

  @Post('vpn-subscriptions/:id/sources')
  async addSource(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddFederatedVpnSubscriptionSourceDto,
    @CurrentUser('sub') actorUserId: string,
    @Req() request: Request,
  ) {
    return {
      success: true,
      data: await this.subscriptions.addSource(
        id,
        dto.serverId,
        dto.vpnUserId,
        actorUserId,
        extractClientIp(request),
      ),
    };
  }

  @Delete('vpn-subscriptions/:id/sources/:sourceId')
  @HttpCode(204)
  async removeSource(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sourceId', ParseUUIDPipe) sourceId: string,
    @CurrentUser('sub') actorUserId: string,
  ) {
    await this.subscriptions.removeSource(id, sourceId, actorUserId);
  }

  @Patch('vpn-subscriptions/:id/sources/order')
  @HttpCode(204)
  async reorderSources(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReorderFederatedVpnSubscriptionSourcesDto,
    @CurrentUser('sub') actorUserId: string,
  ) {
    await this.subscriptions.reorderSources(id, dto.sourceIds, actorUserId);
  }

  @Post('vpn-subscriptions/:id/rotate')
  async rotate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') actorUserId: string,
  ) {
    return {
      success: true,
      data: await this.subscriptions.rotate(id, actorUserId),
    };
  }

  @Delete('vpn-subscriptions/:id')
  @HttpCode(204)
  async revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') actorUserId: string,
  ) {
    await this.subscriptions.revoke(id, actorUserId);
  }
}
