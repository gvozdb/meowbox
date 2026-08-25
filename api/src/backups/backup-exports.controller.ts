import {
  Controller, Get, Post, Delete, Param, Body, Headers,
  ParseUUIDPipe, GoneException, HttpCode, HttpStatus,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsInt, IsIn, Min, Max, IsUUID } from 'class-validator';
import { BackupExportsService } from './backup-exports.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { BackupExportMode } from '../common/enums';

interface JwtUser { id: string; role: string }

class CreateBackupExportDto {
  @IsUUID()
  backupId!: string;

  @IsIn([BackupExportMode.STREAM, BackupExportMode.S3_PRESIGNED])
  mode!: string;

  // 1..720 (30 дней). Меньше 1 — бессмысленно, больше 30 дней — риск
  // переполнения S3 и устаревших presigned-ссылок.
  @IsInt()
  @Min(1)
  @Max(720)
  ttlHours!: number;
}

class CreateStagedBackupExportDto {
  @IsUUID()
  backupId!: string;

  @IsInt()
  @Min(1)
  @Max(720)
  ttlHours!: number;
}

@Controller()
export class BackupExportsController {
  constructor(private readonly service: BackupExportsService) {}

  @Post('backup-exports')
  @Roles('ADMIN', 'MANAGER')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async createExport(
    @Body() dto: CreateBackupExportDto,
    @CurrentUser() user?: JwtUser,
    @Headers('idempotency-key') _idempotencyKey?: string,
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
        expiresAt: row.expiresAt,
      },
    };
  }

  @Post('backup-exports/staged')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles('ADMIN', 'MANAGER')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async createStagedExport(
    @Body() dto: CreateStagedBackupExportDto,
    @CurrentUser() user?: JwtUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const accepted = await this.service.createStagedExport({
      backupId: dto.backupId,
      ttlHours: dto.ttlHours,
      userId: user!.id,
      role: user!.role,
      idempotencyKey,
    });
    return { success: true, data: accepted };
  }

  @Get('backup-exports/:id')
  @Roles('ADMIN', 'MANAGER')
  async getExport(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const row = await this.service.getExport(id, user!.id, user!.role);
    return { success: true, data: row };
  }

  @Get('backups/:backupId/exports')
  @Roles('ADMIN', 'MANAGER')
  async listExports(
    @Param('backupId', ParseUUIDPipe) backupId: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const rows = await this.service.listExportsForBackup(backupId, user!.id, user!.role);
    return { success: true, data: rows };
  }

  @Delete('backup-exports/:id')
  @Roles('ADMIN', 'MANAGER')
  async deleteExport(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
    @Headers('idempotency-key') _idempotencyKey?: string,
  ) {
    await this.service.deleteExport(id, user!.id, user!.role);
    return { success: true };
  }

  @Post('backup-exports/:id/delivery')
  @Roles('ADMIN', 'MANAGER')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async issueDelivery(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
    @Headers('idempotency-key') _idempotencyKey?: string,
  ) {
    const delivery = await this.service.issueDelivery(id, user!.id, user!.role);
    return { success: true, data: delivery };
  }

  @Post('backup-exports/:id/issue-token')
  @Roles('ADMIN', 'MANAGER')
  issueLegacyToken(): never {
    throw new GoneException('Legacy backup export tokens are disabled');
  }

  @Get('backup-exports/:id/download')
  @Public()
  streamLegacyDownload(): never {
    throw new GoneException('Legacy backup export downloads are disabled');
  }
}
