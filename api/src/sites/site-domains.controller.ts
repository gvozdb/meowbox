import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  ParseUUIDPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums';

import { SiteDomainsService } from './site-domains.service';
import {
  CreateSiteDomainDto,
  UpdateSiteDomainDto,
  UpdateSiteDomainAliasesDto,
} from './site-domains.dto';

interface AuthCtx {
  id: string;
  role: string;
}

/**
 * REST API мульти-доменной модели сайта (`SiteDomain`).
 * Все мутации требуют ADMIN/MANAGER и пересобирают nginx сайта.
 */
@Controller('sites/:id/domains')
export class SiteDomainsController {
  constructor(private readonly service: SiteDomainsService) {}

  @Get()
  async list(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthCtx,
  ) {
    const data = await this.service.listDomains(id, user.id, user.role);
    return { success: true, data };
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async create(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateSiteDomainDto,
    @CurrentUser() user: AuthCtx,
  ) {
    const data = await this.service.createDomain(id, dto, user.id, user.role);
    return { success: true, data };
  }

  @Put(':domainId')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('domainId', new ParseUUIDPipe()) domainId: string,
    @Body() dto: UpdateSiteDomainDto,
    @CurrentUser() user: AuthCtx,
  ) {
    const data = await this.service.updateDomain(id, domainId, dto, user.id, user.role);
    return { success: true, data };
  }

  @Delete(':domainId')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  async delete(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('domainId', new ParseUUIDPipe()) domainId: string,
    @CurrentUser() user: AuthCtx,
  ) {
    const data = await this.service.deleteDomain(id, domainId, user.id, user.role);
    return { success: true, data };
  }

  @Post(':domainId/make-primary')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  async makePrimary(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('domainId', new ParseUUIDPipe()) domainId: string,
    @CurrentUser() user: AuthCtx,
  ) {
    const data = await this.service.makePrimary(id, domainId, user.id, user.role);
    return { success: true, data };
  }

  @Put(':domainId/aliases')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  async updateAliases(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('domainId', new ParseUUIDPipe()) domainId: string,
    @Body() dto: UpdateSiteDomainAliasesDto,
    @CurrentUser() user: AuthCtx,
  ) {
    const data = await this.service.updateAliases(id, domainId, dto, user.id, user.role);
    return { success: true, data };
  }
}
