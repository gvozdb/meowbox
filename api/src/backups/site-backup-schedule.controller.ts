import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { SiteBackupScheduleService } from './site-backup-schedule.service';
import {
  CreateSiteBackupScheduleDto,
  UpdateSiteBackupScheduleDto,
} from './site-backup-schedule.dto';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('backups/site-schedules')
export class SiteBackupScheduleController {
  constructor(private readonly svc: SiteBackupScheduleService) {}

  @Get()
  @Roles('ADMIN')
  async list() {
    return { success: true, data: await this.svc.list() };
  }

  @Get(':id')
  @Roles('ADMIN')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.svc.get(id) };
  }

  @Post()
  @Roles('ADMIN')
  async create(@Body() dto: CreateSiteBackupScheduleDto) {
    return { success: true, data: await this.svc.create(dto) };
  }

  @Patch(':id')
  @Roles('ADMIN')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSiteBackupScheduleDto,
  ) {
    return { success: true, data: await this.svc.update(id, dto) };
  }

  @Delete(':id')
  @Roles('ADMIN')
  async delete(@Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.svc.delete(id) };
  }

  @Post(':id/run')
  @Roles('ADMIN')
  async triggerBackup(@Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.svc.triggerForAllSites(id) };
  }
}
