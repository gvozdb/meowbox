import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums';
import {
  ChangeCmsAdminPasswordDto,
  UpdateModxVersionDto,
  UpdatePhpPoolConfigDto,
} from './sites.dto';
import { DomainApplicationsService } from './domain-applications.service';

@Controller('sites/:siteId/domains/:domainId')
export class DomainApplicationsController {
  constructor(private readonly applications: DomainApplicationsService) {}

  @Get('application')
  async getApplication(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const data = await this.applications.getApplication(
      siteId,
      domainId,
      userId,
      role,
    );
    return { success: true, data };
  }

  @Get('metrics')
  async getMetrics(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const data = await this.applications.getMetrics(
      siteId,
      domainId,
      userId,
      role,
    );
    return { success: true, data };
  }

  @Post('application/retry')
  @Roles(UserRole.ADMIN)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async retryApplication(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const data = await this.applications.retryApplication(
      siteId,
      domainId,
      userId,
      role,
      idempotencyKey,
    );
    return { success: true, data };
  }

  @Get('php-pool-config')
  async getPhpPoolConfig(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const data = await this.applications.getPhpPoolConfig(
      siteId,
      domainId,
      userId,
      role,
    );
    return { success: true, data };
  }

  @Put('php-pool-config')
  async updatePhpPoolConfig(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Body() body: UpdatePhpPoolConfigDto,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const data = await this.applications.updatePhpPoolConfig(
      siteId,
      domainId,
      userId,
      role,
      body.custom,
      idempotencyKey,
    );
    return { success: true, data };
  }

  @Post('modx/update')
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  async updateModx(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Body() body: UpdateModxVersionDto,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const data = await this.applications.updateModx(
      siteId,
      domainId,
      userId,
      role,
      body,
      idempotencyKey,
    );
    return { success: true, data };
  }

  @Get('modx/doctor')
  async modxDoctor(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const data = await this.applications.runModxDoctor(
      siteId,
      domainId,
      userId,
      role,
    );
    return { success: true, data };
  }

  @Post('modx/cleanup-setup')
  @Roles(UserRole.ADMIN)
  async cleanupSetup(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const data = await this.applications.cleanupSetup(
      siteId,
      domainId,
      userId,
      role,
      idempotencyKey,
    );
    return { success: true, data };
  }

  @Post('modx/admin-password')
  @Roles(UserRole.ADMIN)
  async changeAdminPassword(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Body() body: ChangeCmsAdminPasswordDto,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const data = await this.applications.changeCmsAdminPassword(
      siteId,
      domainId,
      userId,
      role,
      body.password,
      idempotencyKey,
    );
    return { success: true, data };
  }

  @Post('modx/admin-login')
  @Roles(UserRole.ADMIN)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async createAdminLogin(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const data = await this.applications.createLoginHandoff(
      siteId,
      domainId,
      userId,
      role,
    );
    return { success: true, data };
  }

  @Post('permissions/normalize')
  @Roles(UserRole.ADMIN)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async normalizePermissions(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const data = await this.applications.normalizePermissions(
      siteId,
      domainId,
      userId,
      role,
      idempotencyKey,
    );
    return { success: true, data };
  }
}

@Controller('domain-app-login')
export class DomainApplicationLoginController {
  constructor(private readonly applications: DomainApplicationsService) {}

  @Get(':token')
  @Public()
  @Header('Cache-Control', 'no-store, max-age=0')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Frame-Options', 'DENY')
  async consume(
    @Param('token') token: string,
    @Res() response: Response,
  ): Promise<void> {
    const html = await this.applications.consumeLoginHandoff(token);
    response
      .setHeader(
        'Content-Security-Policy',
        "default-src 'none'; form-action http: https:; script-src 'unsafe-inline'",
      )
      .type('html')
      .send(html);
  }
}
