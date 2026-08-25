import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Headers,
  Param,
  Query,
  Res,
  Header,
  ParseUUIDPipe,
  NotFoundException,
  BadRequestException,
  HttpCode,
  HttpStatus,
  GoneException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
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
  ResticLocationQueryDto,
} from './backups.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { ResticQueryOperationsService } from './restic-query-operations.service';
import { BackupDeleteOperationsService } from './backup-delete-operations.service';
import { BackupTransferService } from './backup-transfer.service';

interface JwtUser {
  id: string;
  role: string;
}

@Controller()
export class BackupsController {
  constructor(
    private readonly backupsService: BackupsService,
    private readonly resticCheckService: ResticCheckService,
    private readonly resticQueries: ResticQueryOperationsService,
    private readonly backupDeletes: BackupDeleteOperationsService,
    private readonly backupTransfers: BackupTransferService,
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
  @Roles('ADMIN', 'MANAGER')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async triggerBackup(
    @Body() dto: TriggerBackupDto,
    @CurrentUser() user?: JwtUser,
    @Headers('idempotency-key') _idempotencyKey?: string,
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

  @Post('sites/:siteId/restic-snapshots/query')
  @Roles('ADMIN', 'MANAGER')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async enqueueResticSnapshots(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() body: ResticLocationQueryDto,
    @CurrentUser() user?: JwtUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const data = await this.resticQueries.enqueueSnapshots(
      siteId,
      body.locationId,
      { userId: user!.id, role: user!.role },
      idempotencyKey,
    );
    return { success: true, data };
  }

  @Post('backups/:id/restore')
  @Roles('ADMIN', 'MANAGER')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  async restoreBackup(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RestoreBackupDto,
    @CurrentUser() user?: JwtUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const result = await this.backupsService.restoreBackup(
      id, user!.id, user!.role,
      body?.cleanup ?? false,
      body?.scope,
      body?.includePaths,
      body?.databaseIds,
      idempotencyKey,
    );
    return {
      success: true,
      data: {
        backupId: result.id,
        operationId: result.operationId,
      },
    };
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

  @Post('backups/:id/tree/query')
  @Roles('ADMIN', 'MANAGER')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async enqueueBackupTree(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const data = await this.resticQueries.enqueueBackupTree(
      id,
      { userId: user!.id, role: user!.role },
      idempotencyKey,
    );
    return { success: true, data };
  }

  // Восстановление из произвольного restic-snapshotId (взятого прямо из репы).
  // Создаёт запись Backup и запускает стандартный restore.
  @Post('sites/:siteId/restic-snapshots/:snapshotId/restore')
  @Roles('ADMIN', 'MANAGER')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  async restoreFromResticSnapshot(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('snapshotId') snapshotId: string,
    @Body() body: RestoreResticSnapshotDto,
    @CurrentUser() user?: JwtUser,
    @Headers('idempotency-key') idempotencyKey?: string,
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
      idempotencyKey,
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

  @Post('sites/:siteId/restic-snapshots/:snapshotId/tree/query')
  @Roles('ADMIN', 'MANAGER')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async enqueueSnapshotTree(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('snapshotId') snapshotId: string,
    @Body() body: ResticLocationQueryDto,
    @CurrentUser() user?: JwtUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const data = await this.resticQueries.enqueueSnapshotTree(
      { siteId, snapshotId, locationId: body.locationId },
      { userId: user!.id, role: user!.role },
      idempotencyKey,
    );
    return { success: true, data };
  }

  // ===========================================================================
  // Restic check (integrity verification)
  // ===========================================================================

  @Post('sites/:siteId/restic-checks')
  @Roles('ADMIN', 'MANAGER')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async runResticCheck(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() body: RunResticCheckDto,
    @CurrentUser() user?: JwtUser,
    @Headers('idempotency-key') _idempotencyKey?: string,
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

  @Get('backups/history')
  @Roles('ADMIN')
  async listUnifiedHistory(
    @Query('page') page?: string,
    @Query('perPage') perPage?: string,
  ) {
    const result = await this.backupsService.listUnifiedHistory(
      page ? parseInt(page, 10) : 1,
      perPage ? parseInt(perPage, 10) : 30,
    );
    return { success: true, data: result.items, meta: result.meta };
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
  downloadBackup() {
    throw new GoneException('Use POST /backups/:id/download-session');
  }

  @Post('backups/:id/download-session')
  @Roles('ADMIN', 'MANAGER')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async createBackupDownloadSession(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const data = await this.backupTransfers.issueDelivery(
      id,
      { userId: user!.id, role: user!.role },
    );
    return { success: true, data };
  }

  @Delete('backups/:id')
  @Roles('ADMIN', 'MANAGER')
  @HttpCode(HttpStatus.ACCEPTED)
  async deleteBackup(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const result = await this.backupDeletes.enqueue(
      id,
      { userId: user!.id, role: user!.role },
      idempotencyKey,
    );
    return { success: true, data: result };
  }

  // ===========================================================================
  // Restic diff
  // ===========================================================================

  // Diff между двумя снапшотами (одна репа = одно хранилище для обоих).
  // Возвращает плоский список изменённых/добавленных/удалённых файлов.
  @Post('sites/:siteId/restic-diff/snapshots')
  @Roles('ADMIN', 'MANAGER')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async diffResticSnapshots(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() body: DiffResticSnapshotsDto,
    @CurrentUser() user?: JwtUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const data = await this.resticQueries.enqueueDiffSnapshots({
      siteId,
      locationId: body.locationId,
      snapshotIdA: body.snapshotIdA,
      snapshotIdB: body.snapshotIdB,
    }, { userId: user!.id, role: user!.role }, idempotencyKey);
    return { success: true, data };
  }

  // Diff: снапшот vs текущие live-файлы (rootPath сайта).
  @Post('sites/:siteId/restic-diff/live')
  @Roles('ADMIN', 'MANAGER')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async diffResticLive(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() body: DiffResticLiveDto,
    @CurrentUser() user?: JwtUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const data = await this.resticQueries.enqueueDiffLive({
      siteId,
      locationId: body.locationId,
      snapshotId: body.snapshotId,
    }, { userId: user!.id, role: user!.role }, idempotencyKey);
    return { success: true, data };
  }

  // Diff содержимого одного файла между двумя снапами (unified diff).
  @Post('sites/:siteId/restic-diff/file')
  @Roles('ADMIN', 'MANAGER')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async diffResticFile(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() body: DiffResticFileDto,
    @CurrentUser() user?: JwtUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const data = await this.resticQueries.enqueueDiffFile({
      siteId,
      locationId: body.locationId,
      snapshotIdA: body.snapshotIdA,
      snapshotIdB: body.snapshotIdB,
      filePath: body.filePath,
    }, { userId: user!.id, role: user!.role }, idempotencyKey);
    return { success: true, data };
  }

  // Diff содержимого одного файла: версия из снапа vs текущий live-файл.
  @Post('sites/:siteId/restic-diff/file-live')
  @Roles('ADMIN', 'MANAGER')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async diffResticFileLive(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() body: DiffResticFileLiveDto,
    @CurrentUser() user?: JwtUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const data = await this.resticQueries.enqueueDiffFileLive({
      siteId,
      locationId: body.locationId,
      snapshotId: body.snapshotId,
      filePath: body.filePath,
    }, { userId: user!.id, role: user!.role }, idempotencyKey);
    return { success: true, data };
  }
}
