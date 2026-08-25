import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Query,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
  GoneException,
  ParseUUIDPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { FilesService } from './files.service';
import {
  CommitFileUploadDto,
  CreateFileDownloadSessionDto,
  CreateFileUploadSessionDto,
  WriteFileDto,
  CreateItemDto,
  RenameItemDto,
} from './files.dto';
import { FileTransferService } from './file-transfer.service';

@Controller('sites/:siteId/domains/:domainId/files')
@Roles('ADMIN', 'MANAGER')
export class FilesController {
  constructor(
    private readonly filesService: FilesService,
    private readonly fileTransfers: FileTransferService,
  ) {}

  @Get()
  async list(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Query('path') dirPath: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const data = await this.filesService.listFiles(
      siteId,
      domainId,
      userId,
      role,
      dirPath || '/',
    );
    return { success: true, data };
  }

  @Get('read')
  async read(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Query('path') filePath: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const content = await this.filesService.readFile(
      siteId,
      domainId,
      userId,
      role,
      filePath,
    );
    return { success: true, data: content };
  }

  @Get('download')
  download() {
    throw new GoneException('Use POST /download-session');
  }

  @Post('download-session')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async createDownloadSession(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Body() body: CreateFileDownloadSessionDto,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const data = await this.fileTransfers.issueDownload(
      siteId,
      domainId,
      body.path,
      { userId, role },
    );
    return { success: true, data };
  }

  @Post('upload')
  upload() {
    throw new GoneException('Use POST /upload-session and POST /upload-commit');
  }

  @Post('upload-session')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async createUploadSession(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Body() body: CreateFileUploadSessionDto,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const data = await this.fileTransfers.issueUpload(
      siteId,
      domainId,
      body,
      { userId, role },
      idempotencyKey,
    );
    return { success: true, data };
  }

  @Post('upload-commit')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async commitUpload(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Body() body: CommitFileUploadDto,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const data = await this.fileTransfers.enqueueUploadCommit(
      siteId,
      domainId,
      body.uploadSessionId,
      body.targetDir,
      { userId, role },
      idempotencyKey,
    );
    return { success: true, data };
  }

  @Put('write')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async write(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Body() body: WriteFileDto,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    await this.filesService.writeFile(
      siteId,
      domainId,
      userId,
      role,
      body.path,
      body.content,
    );
    return { success: true };
  }

  @Post('create')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async create(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Body() body: CreateItemDto,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    await this.filesService.createItem(
      siteId,
      domainId,
      userId,
      role,
      body.path,
      body.type,
    );
    return { success: true };
  }

  @Delete()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async remove(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Query('path') itemPath: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    await this.filesService.deleteItem(siteId, domainId, userId, role, itemPath);
    return { success: true };
  }

  @Post('rename')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async rename(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Body() body: RenameItemDto,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    await this.filesService.renameItem(
      siteId,
      domainId,
      userId,
      role,
      body.oldPath,
      body.newPath,
    );
    return { success: true };
  }
}
