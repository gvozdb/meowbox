import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { NginxService } from './nginx.service';
import { UpdateNginxConfigDto, WriteNginxGlobalConfigDto } from './nginx.dto';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('nginx')
@Roles('ADMIN')
export class NginxController {
  constructor(private readonly nginxService: NginxService) {}

  @Get('status')
  async getStatus() {
    const status = await this.nginxService.getStatus();
    return { success: true, data: status };
  }

  @Post('test')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async test() {
    const result = await this.nginxService.test();
    return { success: true, data: result };
  }

  @Post('reload')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async reload() {
    await this.nginxService.reload();
    return { success: true };
  }

  @Get('global-config')
  async readGlobalConfig() {
    const content = await this.nginxService.readGlobalConfig();
    return { success: true, data: { content } };
  }

  @Put('global-config')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async writeGlobalConfig(@Body() body: WriteNginxGlobalConfigDto) {
    await this.nginxService.writeGlobalConfig(body.content);
    return { success: true };
  }

  @Get('configs')
  async listConfigs() {
    const configs = await this.nginxService.listConfigs();
    return { success: true, data: configs };
  }

  @Get('configs/:domain')
  async readConfig(@Param('domain') domain: string) {
    const config = await this.nginxService.readConfig(domain);
    return { success: true, data: config };
  }

  @Put('configs/:domain')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async updateConfig(
    @Param('domain') domain: string,
    @Body() dto: UpdateNginxConfigDto,
  ) {
    await this.nginxService.updateConfig(domain, dto.config);
    return { success: true };
  }
}
