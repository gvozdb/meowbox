import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Query,
  Body,
  ParseUUIDPipe,
  Headers,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SiteNodeService } from './site-node.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  EcosystemStartDto,
  AutostartDto,
  QuickCommandsReplaceDto,
} from './site-node.dto';

@Controller('sites/:siteId/domains/:domainId/node')
@Roles('ADMIN')
export class SiteNodeController {
  constructor(private readonly siteNode: SiteNodeService) {}

  // -- PM2-процессы --

  @Get('processes')
  async getProcesses(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
  ) {
    return {
      success: true,
      data: await this.siteNode.getProcesses(siteId, domainId),
    };
  }

  @Post('ecosystem/start')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async startEcosystem(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Body() body: EcosystemStartDto,
  ) {
    await this.siteNode.startEcosystem(siteId, domainId, body.file, body.only);
    return { success: true };
  }

  @Post('processes/:name/stop')
  async stopProcess(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Param('name') name: string,
  ) {
    await this.siteNode.controlProcess(siteId, domainId, 'stop', name);
    return { success: true };
  }

  @Post('processes/:name/restart')
  async restartProcess(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Param('name') name: string,
  ) {
    await this.siteNode.controlProcess(siteId, domainId, 'restart', name);
    return { success: true };
  }

  @Post('processes/:name/reload')
  async reloadProcess(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Param('name') name: string,
  ) {
    await this.siteNode.controlProcess(siteId, domainId, 'reload', name);
    return { success: true };
  }

  @Delete('processes/:name')
  async deleteProcess(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Param('name') name: string,
  ) {
    await this.siteNode.controlProcess(siteId, domainId, 'delete', name);
    return { success: true };
  }

  @Get('processes/:name/logs')
  async getProcessLogs(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Param('name') name: string,
    @Query('lines') lines?: string,
  ) {
    const n = Math.min(Math.max(parseInt(lines || '200', 10) || 200, 1), 2000);
    const content = await this.siteNode.getProcessLogs(
      siteId,
      domainId,
      name,
      n,
    );
    return { success: true, data: { content } };
  }

  // -- Автозагрузка --

  @Get('autostart')
  async getAutostart(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
  ) {
    return {
      success: true,
      data: await this.siteNode.getAutostart(siteId, domainId),
    };
  }

  @Put('autostart')
  async setAutostart(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Body() body: AutostartDto,
  ) {
    await this.siteNode.setAutostart(siteId, domainId, body.enabled);
    return { success: true };
  }

  // -- Быстрые команды --

  @Get('commands/discover')
  async discoverCommands(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
  ) {
    return {
      success: true,
      data: await this.siteNode.discoverCommands(siteId, domainId),
    };
  }

  @Get('quick-commands')
  async listQuickCommands(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
  ) {
    return {
      success: true,
      data: await this.siteNode.listQuickCommands(siteId, domainId),
    };
  }

  @Put('quick-commands')
  async replaceQuickCommands(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Body() body: QuickCommandsReplaceDto,
  ) {
    const data = await this.siteNode.replaceQuickCommands(
      siteId,
      domainId,
      body.commands,
    );
    return { success: true, data };
  }

  @Post('quick-commands/:id/run')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async runQuickCommand(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const data = await this.siteNode.enqueueQuickCommand(
      siteId,
      domainId,
      id,
      { userId, role },
      idempotencyKey,
    );
    return { success: true, data };
  }
}
