import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CreateWebhookRouteDto } from './webhook.dto';
import { WebhookDeliveryWorkerService } from './webhook-delivery-worker.service';
import { WebhookRouteService } from './webhook-route.service';

interface AdminUser {
  id: string;
  role: 'ADMIN';
}

@Controller('servers')
@Roles('ADMIN')
export class WebhookManagementController {
  constructor(
    private readonly routes: WebhookRouteService,
    private readonly worker: WebhookDeliveryWorkerService,
  ) {}

  @Post(':serverId/webhook-routes')
  async create(
    @Param('serverId') serverId: string,
    @Body() dto: CreateWebhookRouteDto,
    @CurrentUser() user: AdminUser,
  ) {
    return {
      success: true,
      data: await this.routes.create({
        serverId,
        siteId: dto.siteId,
        domainId: dto.domainId,
        domain: dto.domain,
        provider: dto.provider,
        secret: dto.secret,
        actorUserId: user.id,
      }),
    };
  }

  @Post('webhook-routes/:id/rotate')
  async rotate(@Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.routes.rotate(id) };
  }

  @Delete('webhook-routes/:id')
  @HttpCode(204)
  async revoke(@Param('id', ParseUUIDPipe) id: string) {
    await this.routes.revoke(id);
  }

  @Get('webhook-routes/:id/deliveries')
  async deliveries(@Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.routes.listDeliveries(id) };
  }

  @Post('webhook-deliveries/:id/redrive')
  @HttpCode(202)
  async redrive(@Param('id', ParseUUIDPipe) id: string) {
    await this.worker.redrive(id);
    return { success: true };
  }
}
