import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  Headers,
  HttpCode,
  GoneException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { DatabasesService } from './databases.service';
import { DatabaseOperationsService } from './database-operations.service';
import {
  CreateDatabaseDto,
  CreateDatabaseImportSessionDto,
  StartDatabaseImportDto,
  UpdateDatabaseDto,
} from './databases.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';

interface JwtUser {
  id: string;
  role: string;
}

@Controller('sites/:siteId/domains/:domainId/databases')
export class DatabasesController {
  constructor(
    private readonly databasesService: DatabasesService,
    private readonly databaseOperations: DatabaseOperationsService,
  ) {}

  @Get()
  async findAll(
    @Query('type') type?: string,
    @Query('search') search?: string,
    @Param('siteId', ParseUUIDPipe) siteId?: string,
    @Param('domainId', ParseUUIDPipe) domainId?: string,
    @Query('page') page?: string,
    @Query('perPage') perPage?: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const result = await this.databasesService.findAll({
      userId: user!.id,
      role: user!.role,
      siteId: siteId!,
      domainId: domainId!,
      type,
      search,
      page: page ? parseInt(page, 10) : 1,
      perPage: perPage ? parseInt(perPage, 10) : 20,
    });

    return { success: true, data: result.databases, meta: result.meta };
  }

  @Get(':id')
  async findById(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const db = await this.databasesService.findById(
      siteId,
      domainId,
      id,
      user!.id,
      user!.role,
    );
    return { success: true, data: db };
  }

  @Post()
  @Roles('ADMIN')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async create(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Body() dto: CreateDatabaseDto,
    @CurrentUser() user?: JwtUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const result = await this.databaseOperations.enqueueCreate(
      siteId,
      domainId,
      dto,
      { userId: user!.id, role: user!.role },
      idempotencyKey,
    );
    return { success: true, data: result };
  }

  @Put(':id')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async update(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDatabaseDto,
    @CurrentUser() user?: JwtUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const result = await this.databasesService.update(
      siteId,
      domainId,
      id,
      dto,
      user!.id,
      user!.role,
      idempotencyKey,
    );
    return { success: true, data: result };
  }

  @Delete(':id')
  @Roles('ADMIN')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async delete(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const result = await this.databaseOperations.enqueueDelete(
      siteId,
      domainId,
      id,
      { userId: user!.id, role: user!.role },
      idempotencyKey,
    );
    return { success: true, data: result };
  }

  @Post(':id/reset-password')
  @Roles('ADMIN')
  @HttpCode(202)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async resetPassword(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const result = await this.databaseOperations.enqueueResetPassword(
      siteId,
      domainId,
      id,
      { userId: user!.id, role: user!.role },
      idempotencyKey,
    );
    return { success: true, data: result };
  }

  // Возвращает plaintext пароль БД (расшифровка dbPasswordEnc). ADMIN-only,
  // throttle жёсткий — фактически операция чтения секрета.
  @Post(':id/reveal-password')
  @Roles('ADMIN')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async revealPassword(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const result = await this.databasesService.revealPassword(
      siteId,
      domainId,
      id,
      user!.id,
      user!.role,
    );
    return { success: true, data: result };
  }

  @Post(':id/adminer-ticket')
  @Roles('ADMIN', 'MANAGER')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async createAdminerTicket(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
    @Headers('idempotency-key') _idempotencyKey?: string,
  ) {
    const result = await this.databasesService.createAdminerTicket(
      siteId,
      domainId,
      id,
      user!.id,
      user!.role,
    );
    return { success: true, data: result };
  }

  @Post(':id/export')
  @HttpCode(202)
  @Roles('ADMIN')
  @Throttle({ default: { limit: 3, ttl: 300_000 } })
  async exportDatabase(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const result = await this.databaseOperations.enqueueExport(
      siteId,
      domainId,
      id,
      { userId: user!.id, role: user!.role },
      idempotencyKey,
    );
    return { success: true, data: result };
  }

  @Post(':id/exports/:operationId/delivery')
  @Roles('ADMIN')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async issueExportDelivery(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('operationId', ParseUUIDPipe) operationId: string,
    @CurrentUser() user?: JwtUser,
    @Headers('idempotency-key') _idempotencyKey?: string,
  ) {
    const result = await this.databaseOperations.issueExportDelivery(
      siteId,
      domainId,
      id,
      operationId,
      { userId: user!.id, role: user!.role },
    );
    return { success: true, data: result };
  }

  @Get(':id/download')
  @Roles('ADMIN')
  downloadExport(): never {
    throw new GoneException('Legacy path-based database downloads are disabled');
  }

  @Post(':id/import-session')
  @Roles('ADMIN')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async createImportSession(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateDatabaseImportSessionDto,
    @CurrentUser() user?: JwtUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const result = await this.databaseOperations.createImportSession(
      siteId,
      domainId,
      id,
      { userId: user!.id, role: user!.role },
      dto,
      idempotencyKey,
    );
    return { success: true, data: result };
  }

  @Post(':id/import')
  @HttpCode(202)
  @Roles('ADMIN')
  @Throttle({ default: { limit: 3, ttl: 300_000 } })
  async importDatabase(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StartDatabaseImportDto,
    @CurrentUser() user?: JwtUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const result = await this.databaseOperations.enqueueImport(
      siteId,
      domainId,
      id,
      dto.uploadSessionId,
      { userId: user!.id, role: user!.role },
      idempotencyKey,
    );
    return { success: true, data: result };
  }

  @Post(':id/import-upload')
  @Roles('ADMIN')
  importUpload(): never {
    throw new GoneException('Legacy buffered database uploads are disabled');
  }
}
