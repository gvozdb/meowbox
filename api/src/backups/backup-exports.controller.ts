import {
  Controller, Get, Post, Delete, Param, Body, Query, Res,
  ParseUUIDPipe, BadRequestException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { IsInt, IsString, IsEnum, Min, Max, IsUUID } from 'class-validator';
import { BackupExportsService } from './backup-exports.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { BackupExportMode } from '../common/enums';

interface JwtUser { id: string; role: string }

class CreateBackupExportDto {
  @IsUUID()
  backupId!: string;

  @IsEnum(BackupExportMode)
  mode!: string;

  // 1..720 (30 дней). Меньше 1 — бессмысленно, больше 30 дней — риск
  // переполнения S3 и устаревших presigned-ссылок.
  @IsInt()
  @Min(1)
  @Max(720)
  ttlHours!: number;
}

@Controller()
export class BackupExportsController {
  constructor(private readonly service: BackupExportsService) {}

  @Post('backup-exports')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async createExport(
    @Body() dto: CreateBackupExportDto,
    @CurrentUser() user?: JwtUser,
  ) {
    const row = await this.service.createExport({
      backupId: dto.backupId,
      mode: dto.mode as 'STREAM' | 'S3_PRESIGNED',
      ttlHours: dto.ttlHours,
      userId: user!.id,
      role: user!.role,
    });
    return {
      success: true,
      data: {
        id: row.id,
        mode: row.mode,
        status: row.status,
        downloadUrl: row.downloadUrl,
        expiresAt: row.expiresAt,
      },
    };
  }

  @Get('backup-exports/:id')
  async getExport(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const row = await this.service.getExport(id, user!.id, user!.role);
    return { success: true, data: row };
  }

  @Get('backups/:backupId/exports')
  async listExports(
    @Param('backupId', ParseUUIDPipe) backupId: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const rows = await this.service.listExportsForBackup(backupId, user!.id, user!.role);
    return { success: true, data: rows };
  }

  @Delete('backup-exports/:id')
  async deleteExport(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    await this.service.deleteExport(id, user!.id, user!.role);
    return { success: true };
  }

  // Свежий download-URL с короткоживущим токеном для STREAM-экспорта.
  // Существует, чтобы НЕ хранить долгоживущие токены в БД и НЕ отдавать
  // их в getExport/listExports — клиент перезапрашивает при каждой попытке
  // скачивания (rate-limit ниже не даёт абьюзить).
  @Post('backup-exports/:id/issue-token')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async issueToken(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const url = await this.service.issueDownloadUrl(id, user!.id, user!.role);
    return { success: true, data: { downloadUrl: url } };
  }

  // STREAM-режим: спавним restic dump → пайпим в response.
  // @Public + одноразовый токен в ?token=... — чтобы браузер мог скачивать
  // нативно через <a download> (без Bearer header'а, который не передаётся
  // нативным download'ом). Токен валидирует service.
  @Get('backup-exports/:id/download')
  @Public()
  async streamDownload(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('token') token?: string,
    @Res({ passthrough: false }) res?: Response,
  ) {
    if (!res) throw new BadRequestException('Response object missing');
    if (!token) {
      res.status(401).json({ success: false, error: 'token required' });
      return;
    }
    const u = this.service.verifyDownloadToken(token, id);
    await this.service.streamDownload(id, u.userId, u.role, res);
  }
}
