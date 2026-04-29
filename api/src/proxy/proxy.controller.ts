import {
  Controller,
  All,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Req,
  Res,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { Roles } from '../common/decorators/roles.decorator';
import { ProxyService } from './proxy.service';
import { ProvisionService } from './provision.service';
import { AddServerDto, UpdateServerDto, ProvisionServerDto } from './proxy.dto';

@Controller()
@Roles('ADMIN')
export class ProxyController {
  private readonly logger = new Logger('ProxyController');

  constructor(
    private readonly proxyService: ProxyService,
    private readonly provisionService: ProvisionService,
  ) {}

  /** List all configured servers with online status */
  @Get('servers')
  async listServers() {
    const servers = await this.proxyService.getServersWithStatus();
    return { success: true, data: servers };
  }

  /** Add a new server */
  @Post('servers')
  async addServer(@Body() body: AddServerDto) {
    const server = await this.proxyService.addServer(body);
    const { online, version } = await this.proxyService.pingServer(server);
    return {
      success: true,
      data: { ...server, token: '***', online, version },
    };
  }

  /** Update an existing server */
  @Put('servers/:id')
  async updateServer(
    @Param('id') id: string,
    @Body() body: UpdateServerDto,
  ) {
    const server = await this.proxyService.updateServer(id, body);
    return { success: true, data: { ...server, token: '***' } };
  }

  /** Delete a server */
  @Delete('servers/:id')
  async deleteServer(@Param('id') id: string) {
    await this.proxyService.removeServer(id);
    return { success: true };
  }

  /** Provision a new server via SSH */
  @Post('servers/provision')
  // Провижнинг запускает apt-install + ssh: дорогая и тяжёлая операция.
  // Ограничиваем 2 запроса / 5 минут, чтобы оператор случайно не запустил
  // десяток параллельных установок и не положил сеть.
  @Throttle({ default: { limit: 2, ttl: 300_000 } })
  async provisionServer(@Body() body: ProvisionServerDto) {
    const result = await this.provisionService.provision(body);
    return { success: true, data: result };
  }

  /** Trigger mass update on all servers */
  @Post('servers/update-all')
  // Обход всех серверов с POST /system/update — каждый раз тащит пакеты.
  // 1 запрос / 5 минут более чем достаточно.
  @Throttle({ default: { limit: 1, ttl: 300_000 } })
  async updateAll() {
    const servers = this.proxyService.getServers();
    const results: Array<{ id: string; name: string; success: boolean; error?: string }> = [];

    for (const server of servers) {
      try {
        const { status, data } = await this.proxyService.proxyRequest(
          server,
          'POST',
          '/system/update',
        );
        results.push({
          id: server.id,
          name: server.name,
          success: status >= 200 && status < 300,
          error: status >= 400 ? JSON.stringify(data) : undefined,
        });
      } catch (err) {
        results.push({
          id: server.id,
          name: server.name,
          success: false,
          error: (err as Error).message,
        });
      }
    }

    return { success: true, data: results };
  }

  /** Proxy any request to a remote server */
  @All('proxy/:serverId/*')
  async proxyRequest(
    @Param('serverId') serverId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const server = this.proxyService.getServer(serverId);
    if (!server) {
      throw new NotFoundException(`Server "${serverId}" not found in config`);
    }

    const fullPath = req.path;
    const prefix = `/api/proxy/${serverId}`;
    const targetPath = fullPath.startsWith(prefix)
      ? fullPath.slice(prefix.length) || '/'
      : fullPath;

    try {
      const { status, data } = await this.proxyService.proxyRequest(
        server,
        req.method,
        targetPath,
        req.body,
      );

      res.status(status).json(data);
    } catch (err) {
      this.logger.error(`Proxy to ${server.name} failed: ${(err as Error).message}`);
      res.status(502).json({
        success: false,
        error: `Failed to reach server "${server.name}"`,
      });
    }
  }
}
