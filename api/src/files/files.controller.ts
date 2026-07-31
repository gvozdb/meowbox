import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Query,
  Body,
  Res,
  Header,
  ParseUUIDPipe,
  StreamableFile,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import * as path from 'path';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { FilesService } from './files.service';
import { attachmentDisposition } from '../common/http/content-disposition';
import { WriteFileDto, CreateItemDto, RenameItemDto } from './files.dto';
import { UPLOAD_BLOCKED_EXTENSIONS } from '@meowbox/shared';

@Controller('sites/:siteId/domains/:domainId/files')
@Roles('ADMIN', 'MANAGER')
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

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
  @Header('Cache-Control', 'no-store')
  async download(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Query('path') filePath: string,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const file = await this.filesService.openDownloadFile(
      siteId,
      domainId,
      userId,
      role,
      filePath,
    );

    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Length': file.size.toString(),
      'Content-Disposition': attachmentDisposition(file.filename),
    });

    return new StreamableFile(file.stream);
  }

  @Post('upload')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024 } }))
  async upload(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Query('path') targetDir: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    if (!file) {
      throw new BadRequestException('Файл не прикреплён');
    }

    // Блокировка исполняемых расширений: загрузка в www/ делает файл
    // доступным через HTTP, а PHP-FPM с радостью его выполнит. RCE через
    // upload — топ-1 вектор на shared-хостингах. Блэклист по расширению,
    // потому что MIME из multipart — клиентский, ему доверять нельзя.
    const origName = String(file.originalname || '').toLowerCase();
    const ext = path.extname(origName).replace(/^\./, '');
    // Блокируем и двойные расширения вида shell.php.jpg: проверяем все
    // сегменты после первой точки.
    const segments = origName.split('.').slice(1);
    for (const seg of segments) {
      if ((UPLOAD_BLOCKED_EXTENSIONS as readonly string[]).includes(seg)) {
        throw new BadRequestException(
          `Загрузка файлов с расширением .${seg} запрещена по соображениям безопасности`,
        );
      }
    }
    // Пустое расширение — тоже подозрительно в контексте web-root. Не блокируем
    // жёстко (туда же текстовые README/Makefile без расширения льют), но логируем
    // в сервисе. ext уже проверили выше через segments.
    void ext;

    await this.filesService.uploadFile(
      siteId,
      domainId,
      userId,
      role,
      targetDir || '/',
      file,
    );
    return { success: true };
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
