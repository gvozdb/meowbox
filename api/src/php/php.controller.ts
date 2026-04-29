import { Controller, Get, Post, Delete, Param, Body } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PhpService } from './php.service';
import { Roles } from '../common/decorators/roles.decorator';
import {
  InstallPhpVersionDto,
  WriteIniDto,
  ExtensionNameDto,
  ToggleExtensionDto,
} from './php.dto';

@Controller('php')
@Roles('ADMIN')
export class PhpController {
  constructor(private readonly phpService: PhpService) {}

  @Get('versions')
  async listVersions() {
    const versions = await this.phpService.listVersions();
    return { success: true, data: versions };
  }

  @Get('status')
  async getAllStatuses() {
    const statuses = await this.phpService.getAllStatuses();
    return { success: true, data: statuses };
  }

  @Get('status/:version')
  async getStatus(@Param('version') version: string) {
    const status = await this.phpService.getStatus(version);
    return { success: true, data: status };
  }

  @Post('restart/:version')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async restart(@Param('version') version: string) {
    await this.phpService.restartVersion(version);
    return { success: true };
  }

  @Post('install')
  @Throttle({ default: { limit: 2, ttl: 60000 } })
  async installVersion(@Body() body: InstallPhpVersionDto) {
    await this.phpService.installVersion(body.version);
    return { success: true };
  }

  @Delete('uninstall/:version')
  @Throttle({ default: { limit: 2, ttl: 60000 } })
  async uninstallVersion(@Param('version') version: string) {
    await this.phpService.uninstallVersion(version);
    return { success: true };
  }

  @Get(':version/ini')
  async readIni(@Param('version') version: string) {
    const content = await this.phpService.readIni(version);
    return { success: true, data: { content } };
  }

  @Post(':version/ini')
  async writeIni(@Param('version') version: string, @Body() body: WriteIniDto) {
    await this.phpService.writeIni(version, body.content);
    return { success: true };
  }

  @Get(':version/extensions')
  async listExtensions(@Param('version') version: string) {
    const extensions = await this.phpService.listExtensions(version);
    return { success: true, data: extensions };
  }

  @Post(':version/extensions/install')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async installExtension(@Param('version') version: string, @Body() body: ExtensionNameDto) {
    await this.phpService.installExtension(version, body.name);
    return { success: true };
  }

  @Post(':version/extensions/toggle')
  async toggleExtension(@Param('version') version: string, @Body() body: ToggleExtensionDto) {
    await this.phpService.toggleExtension(version, body.name, body.enable);
    return { success: true };
  }
}
