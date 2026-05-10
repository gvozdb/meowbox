import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Res,
  Header,
  ParseUUIDPipe,
  NotFoundException,
  StreamableFile,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { DatabasesService } from './databases.service';
import { CreateDatabaseDto, UpdateDatabaseDto } from './databases.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { attachmentDisposition } from '../common/http/content-disposition';
import {
  assertSafeFilePath,
  ALLOWED_DB_FILE_PREFIXES,
} from '../common/validators/safe-path';

interface JwtUser {
  id: string;
  role: string;
}

@Controller('databases')
export class DatabasesController {
  constructor(private readonly databasesService: DatabasesService) {}

  @Get()
  async findAll(
    @Query('type') type?: string,
    @Query('search') search?: string,
    @Query('siteId') siteId?: string,
    @Query('page') page?: string,
    @Query('perPage') perPage?: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const result = await this.databasesService.findAll({
      userId: user!.id,
      role: user!.role,
      type,
      search,
      siteId,
      page: page ? parseInt(page, 10) : 1,
      perPage: perPage ? parseInt(perPage, 10) : 20,
    });

    return { success: true, data: result.databases, meta: result.meta };
  }

  @Get(':id')
  async findById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const db = await this.databasesService.findById(id, user!.id, user!.role);
    return { success: true, data: db };
  }

  @Post()
  @Roles('ADMIN')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async create(
    @Body() dto: CreateDatabaseDto,
    @CurrentUser() user?: JwtUser,
  ) {
    const result = await this.databasesService.create(dto, user!.id);
    return { success: true, data: result };
  }

  @Put(':id')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDatabaseDto,
    @CurrentUser() user?: JwtUser,
  ) {
    const result = await this.databasesService.update(id, dto, user!.id, user!.role);
    return { success: true, data: result };
  }

  @Delete(':id')
  @Roles('ADMIN')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async delete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    await this.databasesService.delete(id, user!.id, user!.role);
    return { success: true };
  }

  @Post(':id/reset-password')
  @Roles('ADMIN')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const result = await this.databasesService.resetPassword(id, user!.id, user!.role);
    return { success: true, data: result };
  }

  @Post(':id/adminer-ticket')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async createAdminerTicket(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const result = await this.databasesService.createAdminerTicket(id, user!.id, user!.role);
    return { success: true, data: result };
  }

  @Post(':id/export')
  @Roles('ADMIN')
  @Throttle({ default: { limit: 3, ttl: 300_000 } })
  async exportDatabase(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const result = await this.databasesService.exportDatabase(id, user!.id, user!.role);
    return { success: true, data: result };
  }

  @Get(':id/download')
  @Roles('ADMIN')
  @Header('Cache-Control', 'no-store')
  async downloadExport(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('filePath') filePath: string,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() user?: JwtUser,
  ) {
    // Validate user has access to this database
    await this.databasesService.findById(id, user!.id, user!.role);

    // Safety: allowlist префиксов + защита от `..` + запрет symlink.
    const safePath = assertSafeFilePath(filePath, ALLOWED_DB_FILE_PREFIXES, {
      mustExist: true,
      extensions: ['sql', 'gz', 'zip', 'bz2', 'xz'],
    });

    const stat = fs.statSync(safePath);
    const filename = path.basename(safePath);

    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size.toString(),
      'Content-Disposition': attachmentDisposition(filename),
    });

    // Удаляем файл после успешной передачи. Дамп — одноразовая
    // штука: каждое нажатие «Экспорт» создаёт новый файл с новым ts.
    // Если соединение оборвалось (`close` без `finish`) — НЕ удаляем,
    // чтобы юзер мог докачать; забытые файлы подберёт периодический
    // cleanup в DatabasesService.
    //
    // Ставим listener только на `finish` response — он триггерится,
    // когда весь body отправлен клиенту. Express прокидывает finish
    // через writable stream — для StreamableFile это работает корректно.
    const stream = fs.createReadStream(safePath);
    res.on('finish', () => {
      fs.unlink(safePath, () => {
        // ENOENT/etc — игнорим: cleanup-таймер всё равно подметёт мусор.
      });
    });
    // Если что-то порвётся на нашей стороне — уничтожаем стрим, файл оставляем.
    res.on('close', () => {
      if (!res.writableEnded) stream.destroy();
    });

    return new StreamableFile(stream);
  }

  @Post(':id/import')
  @Roles('ADMIN')
  @Throttle({ default: { limit: 3, ttl: 300_000 } })
  async importDatabase(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { filePath: string },
    @CurrentUser() user?: JwtUser,
  ) {
    // Safety: path traversal + symlink + extension guard.
    const safePath = assertSafeFilePath(body?.filePath, ALLOWED_DB_FILE_PREFIXES, {
      mustExist: true,
      extensions: ['sql', 'gz', 'zip', 'bz2', 'xz'],
    });
    const result = await this.databasesService.importDatabase(id, user!.id, user!.role, safePath);
    return { success: true, data: result };
  }

  @Post(':id/import-upload')
  @Roles('ADMIN')
  @Throttle({ default: { limit: 3, ttl: 300_000 } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024 } }))
  async importUpload(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user?: JwtUser,
  ) {
    if (!file) {
      throw new BadRequestException('SQL-файл не прикреплён');
    }

    // Разрешаем только дамп-форматы. `originalname` от клиента —
    // для пользовательской валидации этого достаточно (дальше агент сам
    // определит формат по магическому заголовку через mysql/gunzip).
    const origName = String(file.originalname || '').toLowerCase();
    const ALLOWED_DUMP_EXT = ['.sql', '.sql.gz', '.sql.bz2', '.sql.xz', '.sql.zip', '.gz', '.bz2', '.xz', '.zip'];
    const ok = ALLOWED_DUMP_EXT.some((ext) => origName.endsWith(ext));
    if (!ok) {
      throw new BadRequestException(
        'Допустимы только дампы БД: .sql, .sql.gz, .sql.bz2, .sql.xz, .sql.zip',
      );
    }

    const result = await this.databasesService.importUpload(id, user!.id, user!.role, file);
    return { success: true, data: result };
  }
}
