import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Res,
  Header,
  ParseUUIDPipe,
  NotFoundException,
  BadRequestException,
  StreamableFile,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { BackupsService } from './backups.service';
import { ResticCheckService } from './restic-check.service';
import {
  CreateBackupConfigDto,
  TriggerBackupDto,
  UpdateAutoBackupSettingsDto,
  RestoreBackupDto,
  RestoreResticSnapshotDto,
  RunResticCheckDto,
  DiffResticSnapshotsDto,
  DiffResticLiveDto,
  DiffResticFileDto,
  DiffResticFileLiveDto,
} from './backups.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { attachmentDisposition } from '../common/http/content-disposition';

interface JwtUser {
  id: string;
  role: string;
}

@Controller()
export class BackupsController {
  constructor(
    private readonly backupsService: BackupsService,
    private readonly resticCheckService: ResticCheckService,
  ) {}

  // ===========================================================================
  // Backup Configs
  // ===========================================================================

  @Get('sites/:siteId/backup-configs')
  async getConfigs(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const configs = await this.backupsService.getConfigs(siteId, user!.id, user!.role);
    return { success: true, data: configs };
  }

  @Post('backup-configs')
  async createConfig(
    @Body() dto: CreateBackupConfigDto,
    @CurrentUser() user?: JwtUser,
  ) {
    const config = await this.backupsService.createConfig(dto, user!.id, user!.role);
    return { success: true, data: config };
  }

  @Delete('backup-configs/:id')
  async deleteConfig(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    await this.backupsService.deleteConfig(id, user!.id, user!.role);
    return { success: true };
  }

  // ===========================================================================
  // Backups
  // ===========================================================================

  @Post('backups/trigger')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async triggerBackup(
    @Body() dto: TriggerBackupDto,
    @CurrentUser() user?: JwtUser,
  ) {
    const result = await this.backupsService.triggerBackup(dto, user!.id, user!.role);
    return {
      success: true,
      data: {
        backups: result.backups,
        siteId: result.site.id,
      },
    };
  }

  // ===========================================================================
  // Auto-backup settings (global)
  // ===========================================================================

  @Get('backups/auto-settings')
  async getAutoSettings() {
    const data = await this.backupsService.getAutoBackupSettings();
    return { success: true, data };
  }

  @Post('backups/auto-settings')
  @Roles('ADMIN')
  async updateAutoSettings(@Body() dto: UpdateAutoBackupSettingsDto) {
    const data = await this.backupsService.updateAutoBackupSettings(dto);
    return { success: true, data };
  }

  // ===========================================================================
  // Restic snapshots (read from repo, not DB)
  // ===========================================================================

  @Get('sites/:siteId/restic-snapshots')
  async listResticSnapshots(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Query('locationId') locationId: string,
    @CurrentUser() user?: JwtUser,
  ) {
    if (!locationId) {
      return { success: false, error: 'locationId обязателен' };
    }
    const snapshots = await this.backupsService.listResticSnapshotsForSite(
      siteId, locationId, user!.id, user!.role,
    );
    return { success: true, data: snapshots };
  }

  @Post('backups/:id/restore')
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  async restoreBackup(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RestoreBackupDto,
    @CurrentUser() user?: JwtUser,
  ) {
    const result = await this.backupsService.restoreBackup(
      id, user!.id, user!.role,
      body?.cleanup ?? false,
      body?.scope,
      body?.includePaths,
      body?.databaseIds,
    );
    return { success: true, data: { backupId: result.id } };
  }

  // Дерево первого уровня rootPath в снапшоте — для UI selective restore.
  // Только для Restic-бэкапов; для TAR клиент использует другой механизм
  // (или не показывает чекбоксы — TAR старого формата).
  @Get('backups/:id/tree')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async getBackupTree(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const items = await this.backupsService.listBackupTopLevel(id, user!.id, user!.role);
    return { success: true, data: { items } };
  }

  // Восстановление из произвольного restic-snapshotId (взятого прямо из репы).
  // Создаёт запись Backup и запускает стандартный restore.
  @Post('sites/:siteId/restic-snapshots/:snapshotId/restore')
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  async restoreFromResticSnapshot(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('snapshotId') snapshotId: string,
    @Body() body: RestoreResticSnapshotDto,
    @CurrentUser() user?: JwtUser,
  ) {
    if (!body?.locationId) {
      return { success: false, error: 'locationId обязателен' };
    }
    const result = await this.backupsService.restoreFromResticSnapshot({
      siteId,
      locationId: body.locationId,
      snapshotId,
      cleanup: body?.cleanup ?? false,
      scope: body?.scope,
      includePaths: body?.includePaths,
      databaseIds: body?.databaseIds,
      userId: user!.id,
      role: user!.role,
    });
    return { success: true, data: result };
  }

  // Дерево произвольного restic-snapshotId (для UI selective restore).
  @Get('sites/:siteId/restic-snapshots/:snapshotId/tree')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async getSnapshotTree(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('snapshotId') snapshotId: string,
    @Query('locationId') locationId: string,
    @CurrentUser() user?: JwtUser,
  ) {
    if (!locationId) {
      throw new BadRequestException('locationId обязателен');
    }
    const items = await this.backupsService.listResticSnapshotTopLevel({
      siteId, snapshotId, locationId, userId: user!.id, role: user!.role,
    });
    return { success: true, data: { items } };
  }

  // ===========================================================================
  // Restic check (integrity verification)
  // ===========================================================================

  @Post('sites/:siteId/restic-checks')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async runResticCheck(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() body: RunResticCheckDto,
    @CurrentUser() user?: JwtUser,
  ) {
    if (!body?.locationId) {
      return { success: false, error: 'locationId обязателен' };
    }
    const result = await this.resticCheckService.runCheck({
      siteId,
      locationId: body.locationId,
      userId: user!.id,
      role: user!.role,
      options: {
        readData: !!body?.readData,
        readDataSubset: body?.readDataSubset,
        source: 'manual',
      },
    });
    return { success: true, data: result };
  }

  @Get('sites/:siteId/restic-checks')
  async listResticChecks(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Query('locationId') locationId?: string,
    @Query('limit') limit?: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const data = await this.resticCheckService.listChecks({
      siteId,
      locationId,
      userId: user!.id,
      role: user!.role,
      limit: limit ? parseInt(limit, 10) : 50,
    });
    return { success: true, data };
  }

  @Get('restic-checks/latest')
  @Roles('ADMIN')
  async latestResticChecks() {
    const data = await this.resticCheckService.latestPerSite();
    return { success: true, data };
  }

  @Get('sites/:siteId/backups')
  async listBackups(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Query('page') page?: string,
    @Query('perPage') perPage?: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const result = await this.backupsService.listBackups(
      siteId,
      user!.id,
      user!.role,
      page ? parseInt(page, 10) : 1,
      perPage ? parseInt(perPage, 10) : 20,
    );
    return { success: true, data: result.backups, meta: result.meta };
  }

  @Get('backups/:id/download')
  @Header('Cache-Control', 'no-store')
  async downloadBackup(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() user?: JwtUser,
  ) {
    const backup = await this.backupsService.getBackupForDownload(id, user!.id, user!.role);

    if (!backup.filePath || !fs.existsSync(backup.filePath)) {
      throw new NotFoundException('Файл бэкапа не найден на диске. Возможно, он хранится только в облаке.');
    }

    const stat = fs.statSync(backup.filePath);
    const filename = path.basename(backup.filePath);

    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size.toString(),
      'Content-Disposition': attachmentDisposition(filename),
    });

    return new StreamableFile(fs.createReadStream(backup.filePath));
  }

  @Delete('backups/:id')
  async deleteBackup(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const result = await this.backupsService.deleteBackup(id, user!.id, user!.role);
    return { success: true, data: result };
  }

  // ===========================================================================
  // Restic diff
  // ===========================================================================

  // Diff между двумя снапшотами (одна репа = одно хранилище для обоих).
  // Возвращает плоский список изменённых/добавленных/удалённых файлов.
  @Post('sites/:siteId/restic-diff/snapshots')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async diffResticSnapshots(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() body: DiffResticSnapshotsDto,
    @CurrentUser() user?: JwtUser,
  ) {
    const data = await this.backupsService.diffResticSnapshots({
      siteId,
      locationId: body.locationId,
      snapshotIdA: body.snapshotIdA,
      snapshotIdB: body.snapshotIdB,
      userId: user!.id,
      role: user!.role,
    });
    return { success: true, data };
  }

  // Diff: снапшот vs текущие live-файлы (rootPath сайта).
  @Post('sites/:siteId/restic-diff/live')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async diffResticLive(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() body: DiffResticLiveDto,
    @CurrentUser() user?: JwtUser,
  ) {
    const data = await this.backupsService.diffResticSnapshotWithLive({
      siteId,
      locationId: body.locationId,
      snapshotId: body.snapshotId,
      userId: user!.id,
      role: user!.role,
    });
    return { success: true, data };
  }

  // Diff содержимого одного файла между двумя снапами (unified diff).
  @Post('sites/:siteId/restic-diff/file')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async diffResticFile(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() body: DiffResticFileDto,
    @CurrentUser() user?: JwtUser,
  ) {
    const data = await this.backupsService.diffResticFile({
      siteId,
      locationId: body.locationId,
      snapshotIdA: body.snapshotIdA,
      snapshotIdB: body.snapshotIdB,
      filePath: body.filePath,
      userId: user!.id,
      role: user!.role,
    });
    return { success: true, data };
  }

  // Diff содержимого одного файла: версия из снапа vs текущий live-файл.
  @Post('sites/:siteId/restic-diff/file-live')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async diffResticFileLive(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() body: DiffResticFileLiveDto,
    @CurrentUser() user?: JwtUser,
  ) {
    const data = await this.backupsService.diffResticFileWithLive({
      siteId,
      locationId: body.locationId,
      snapshotId: body.snapshotId,
      filePath: body.filePath,
      userId: user!.id,
      role: user!.role,
    });
    return { success: true, data };
  }
}
