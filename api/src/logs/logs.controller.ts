import {
  Controller,
  Get,
  Param,
  Query,
  ParseUUIDPipe,
} from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { LogsService } from './logs.service';

// --- Per-site log endpoints (backward compat) ---

@Controller('sites/:siteId/logs')
@Roles('ADMIN', 'MANAGER')
export class LogsController {
  constructor(private readonly logsService: LogsService) {}

  @Get()
  async getAvailable(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const data = await this.logsService.getAvailableLogs(siteId, userId, role);
    return { success: true, data };
  }

  @Get('read')
  async read(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Query('type') type: string,
    @Query('lines') lines: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const validTypes = ['access', 'error', 'php', 'app'];
    const logType = validTypes.includes(type) ? type : 'access';
    const data = await this.logsService.getSiteLogs(
      siteId,
      userId,
      role,
      logType,
      lines ? parseInt(lines, 10) : 200,
    );
    return { success: true, data };
  }
}

// --- Centralized log endpoints ---

@Controller('logs')
@Roles('ADMIN', 'MANAGER')
export class LogsCentralController {
  constructor(private readonly logsService: LogsService) {}

  @Get('sources')
  async getSources(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const data = await this.logsService.getLogSources(userId, role);
    return { success: true, data };
  }

  @Get('read')
  async read(
    @Query('source') source: string,
    @Query('type') type: string,
    @Query('lines') lines: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    if (!source) {
      return { success: false, error: 'source query param is required' };
    }
    const data = await this.logsService.readCentralLog(
      source,
      type || 'access',
      lines ? parseInt(lines, 10) : 200,
      userId,
      role,
    );
    return { success: true, data };
  }
}
