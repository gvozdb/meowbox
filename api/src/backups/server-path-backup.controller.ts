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
import { ServerPathBackupService } from './server-path-backup.service';
import {
  CreateServerPathBackupDto,
  UpdateServerPathBackupDto,
} from './server-path-backup.dto';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('backups/server-paths')
export class ServerPathBackupController {
  constructor(private readonly svc: ServerPathBackupService) {}

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
  async create(@Body() dto: CreateServerPathBackupDto) {
    return { success: true, data: await this.svc.create(dto) };
  }

  @Patch(':id')
  @Roles('ADMIN')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateServerPathBackupDto,
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
