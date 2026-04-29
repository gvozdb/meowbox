import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Res,
  Header,
  BadRequestException,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import * as fs from 'fs';
import * as path from 'path';
import { Response } from 'express';
import { MigrationService, MigrateParams } from './migration.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums';
import { attachmentDisposition } from '../common/http/content-disposition';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsArray,
} from 'class-validator';

// ─── DTOs ───

class StartMigrationDto {
  @IsString()
  @IsNotEmpty()
  siteId!: string;

  @IsString()
  @IsNotEmpty()
  sourceServerId!: string;

  @IsString()
  @IsNotEmpty()
  targetServerId!: string;

  @IsOptional()
  @IsBoolean()
  reissueSsl?: boolean;

  @IsOptional()
  @IsBoolean()
  stopSource?: boolean;

  @IsOptional()
  @IsString()
  panelUrl?: string;
}

class CreateDownloadTokenDto {
  @IsString()
  @IsNotEmpty()
  filePath!: string;
}

class ImportPullDto {
  @IsString()
  @IsNotEmpty()
  siteId!: string;

  @IsString()
  @IsNotEmpty()
  sourceUrl!: string;

  @IsOptional()
  @IsArray()
  databases?: Array<{ name: string; type: string }>;
}

// ─── Controller ───

// Миграции вызывают useradd/chown/восстановление БД на целевом сервере и
// могут тянуть произвольный URL (SSRF). Оставляем только для ADMIN.
// Роли ставим на конкретные методы, чтобы не сталкиваться с @Public() на
// download-эндпоинте (там защита через one-shot download-token).
@Controller('migration')
export class MigrationController {
  constructor(private readonly migrationService: MigrationService) {}

  /** Start migration (orchestrator — always runs on main server). */
  @Post('start')
  @Roles(UserRole.ADMIN)
  @Throttle({ default: { limit: 2, ttl: 60000 } })
  async startMigration(
    @Body() dto: StartMigrationDto,
    @CurrentUser('sub') userId: string,
  ) {
    const params: MigrateParams = {
      siteId: dto.siteId,
      sourceServerId: dto.sourceServerId,
      targetServerId: dto.targetServerId,
      reissueSsl: dto.reissueSsl ?? false,
      stopSource: dto.stopSource ?? false,
      panelUrl: dto.panelUrl,
    };

    const migrationId = await this.migrationService.startMigration(params, userId);
    return { success: true, data: { migrationId } };
  }

  /** Poll migration progress. */
  @Get(':id/status')
  @Roles(UserRole.ADMIN)
  getStatus(@Param('id') id: string) {
    const state = this.migrationService.getStatus(id);
    if (!state) {
      throw new BadRequestException('Миграция не найдена');
    }
    return { success: true, data: state };
  }

  // ─── Source server endpoints ───

  /** Create a temporary single-use download token for a backup file. */
  @Post('download-token')
  @Roles(UserRole.ADMIN)
  createDownloadToken(@Body() dto: CreateDownloadTokenDto) {
    const result = this.migrationService.createDownloadToken(dto.filePath);
    return { success: true, data: result };
  }

  /** Stream backup file. Token is the auth — public endpoint. */
  @Get('download/:token')
  @Public()
  // Rate-limit на перебор токенов: 32 байта криптослучайности — брутить
  // бесполезно, но если кто-то начнёт стучать по эндпоинту с чужими/битыми
  // токенами, хочется видеть это как выброс 429, а не как ровную 404-ленту.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  downloadBackup(
    @Param('token') token: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokenData = this.migrationService.consumeDownloadToken(token);
    if (!tokenData) {
      throw new NotFoundException('Недействительный или истёкший токен загрузки');
    }

    if (!fs.existsSync(tokenData.filePath)) {
      throw new NotFoundException('Файл бэкапа не найден');
    }

    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Length': tokenData.fileSize.toString(),
      'Content-Disposition': attachmentDisposition(path.basename(tokenData.filePath)),
    });

    const fileStream = fs.createReadStream(tokenData.filePath);
    return new StreamableFile(fileStream);
  }

  // ─── Target server endpoints ───

  /** Target pulls file from source URL, saves locally, triggers restore. */
  @Post('import-pull')
  @Roles(UserRole.ADMIN)
  async importPull(@Body() dto: ImportPullDto) {
    const result = await this.migrationService.startImportPull(
      dto.siteId,
      dto.sourceUrl,
      dto.databases || [],
    );
    return { success: true, data: result };
  }

  /** Poll download + restore progress on target. */
  @Get('pull-status/:pullId')
  @Roles(UserRole.ADMIN)
  getPullStatus(@Param('pullId') pullId: string) {
    const state = this.migrationService.getPullStatus(pullId);
    if (!state) {
      throw new BadRequestException('Операция передачи не найдена');
    }
    return { success: true, data: state };
  }
}
