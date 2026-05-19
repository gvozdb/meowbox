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
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SiteNodeService } from './site-node.service';
import { Roles } from '../common/decorators/roles.decorator';
import {
  EcosystemStartDto,
  AutostartDto,
  QuickCommandsReplaceDto,
} from './site-node.dto';

@Controller('sites/:siteId/node')
@Roles('ADMIN')
export class SiteNodeController {
  constructor(private readonly siteNode: SiteNodeService) {}

  // -- PM2-процессы --

  @Get('processes')
  async getProcesses(@Param('siteId', ParseUUIDPipe) siteId: string) {
    return { success: true, data: await this.siteNode.getProcesses(siteId) };
  }

  @Post('ecosystem/start')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async startEcosystem(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() body: EcosystemStartDto,
  ) {
    await this.siteNode.startEcosystem(siteId, body.file, body.only);
    return { success: true };
  }

  @Post('processes/:name/stop')
  async stopProcess(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('name') name: string,
  ) {
    await this.siteNode.controlProcess(siteId, 'stop', name);
    return { success: true };
  }

  @Post('processes/:name/restart')
  async restartProcess(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('name') name: string,
  ) {
    await this.siteNode.controlProcess(siteId, 'restart', name);
    return { success: true };
  }

  @Post('processes/:name/reload')
  async reloadProcess(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('name') name: string,
  ) {
    await this.siteNode.controlProcess(siteId, 'reload', name);
    return { success: true };
  }

  @Delete('processes/:name')
  async deleteProcess(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('name') name: string,
  ) {
    await this.siteNode.controlProcess(siteId, 'delete', name);
    return { success: true };
  }

  @Get('processes/:name/logs')
  async getProcessLogs(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('name') name: string,
    @Query('lines') lines?: string,
  ) {
    const n = Math.min(Math.max(parseInt(lines || '200', 10) || 200, 1), 2000);
    const content = await this.siteNode.getProcessLogs(siteId, name, n);
    return { success: true, data: { content } };
  }

  // -- Автозагрузка --

  @Get('autostart')
  async getAutostart(@Param('siteId', ParseUUIDPipe) siteId: string) {
    return { success: true, data: await this.siteNode.getAutostart(siteId) };
  }

  @Put('autostart')
  async setAutostart(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() body: AutostartDto,
  ) {
    await this.siteNode.setAutostart(siteId, body.enabled);
    return { success: true };
  }

  // -- Быстрые команды --

  @Get('commands/discover')
  async discoverCommands(@Param('siteId', ParseUUIDPipe) siteId: string) {
    return { success: true, data: await this.siteNode.discoverCommands(siteId) };
  }

  @Get('quick-commands')
  async listQuickCommands(@Param('siteId', ParseUUIDPipe) siteId: string) {
    return { success: true, data: await this.siteNode.listQuickCommands(siteId) };
  }

  @Put('quick-commands')
  async replaceQuickCommands(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() body: QuickCommandsReplaceDto,
  ) {
    const data = await this.siteNode.replaceQuickCommands(siteId, body.commands);
    return { success: true, data };
  }

  @Post('quick-commands/:id/run')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async runQuickCommand(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const data = await this.siteNode.runQuickCommand(siteId, id);
    return { success: true, data };
  }
}
