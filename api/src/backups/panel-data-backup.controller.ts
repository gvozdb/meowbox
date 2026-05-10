import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
} from '@nestjs/common';
import { PanelDataBackupService } from './panel-data-backup.service';
import { CreatePanelDataBackupDto } from './server-path-backup.dto';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('backups/panel-data')
export class PanelDataBackupController {
  constructor(private readonly svc: PanelDataBackupService) {}

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
  async create(@Body() dto: CreatePanelDataBackupDto) {
    return { success: true, data: await this.svc.create(dto) };
  }

  @Patch(':id')
  @Roles('ADMIN')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: Partial<CreatePanelDataBackupDto>,
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
    return { success: true, data: await this.svc.triggerBackup(id) };
  }

  @Get(':id/backups')
  @Roles('ADMIN')
  async listBackups(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page?: string,
    @Query('perPage') perPage?: string,
  ) {
    const data = await this.svc.listBackups(
      id,
      page ? Number(page) : 1,
      perPage ? Number(perPage) : 20,
    );
    return { success: true, data };
  }
}
