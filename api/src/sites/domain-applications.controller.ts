import {
  Body,
  Controller,
  Get,
  GoneException,
  Header,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Res,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums';
import {
  ChangeCmsAdminPasswordDto,
  ConsumeModxLoginHandoffDto,
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
  @HttpCode(HttpStatus.ACCEPTED)
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
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @HttpCode(HttpStatus.ACCEPTED)
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
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @HttpCode(HttpStatus.ACCEPTED)
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

  @Post('modx/doctor/scan')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async scanModxDoctor(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const data = await this.applications.enqueueModxDoctor(
      siteId,
      domainId,
      userId,
      role,
      idempotencyKey,
    );
    return { success: true, data };
  }

  @Post('modx/cleanup-setup')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.ACCEPTED)
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
  @HttpCode(HttpStatus.ACCEPTED)
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
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const data = await this.applications.createLoginHandoff(
      siteId,
      domainId,
      userId,
      role,
      idempotencyKey,
    );
    return { success: true, data };
  }

  @Post('permissions/normalize')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.ACCEPTED)
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

const MODX_HANDOFF_BOOTSTRAP = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <meta name="robots" content="noindex,nofollow">
  <title>MODX sign-in</title>
</head>
<body>
  <noscript>JavaScript is required to continue.</noscript>
  <script>
    (() => {
      const match = /^#handoff=([A-Za-z0-9_-]{43})$/.exec(location.hash);
      history.replaceState(null, '', location.pathname);
      if (!match) {
        document.body.textContent = 'Invalid or expired handoff.';
        return;
      }
      const form = document.createElement('form');
      form.method = 'post';
      form.action = '/api/public/v1/modx/login/consume';
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'token';
      input.value = match[1];
      form.appendChild(input);
      document.body.appendChild(form);
      form.submit();
    })();
  </script>
</body>
</html>`;

@Controller('public/v1/modx/login')
export class ModxLoginHandoffController {
  constructor(private readonly applications: DomainApplicationsService) {}

  @Get()
  @Public()
  @Header('Cache-Control', 'no-store, max-age=0')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Frame-Options', 'DENY')
  bootstrap(@Res() response: Response): void {
    response
      .setHeader(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
      )
      .type('html')
      .send(MODX_HANDOFF_BOOTSTRAP);
  }

  @Post('consume')
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store, max-age=0')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Frame-Options', 'DENY')
  async consume(
    @Body() body: ConsumeModxLoginHandoffDto,
    @Res() response: Response,
  ): Promise<void> {
    const html = await this.applications.consumeLoginHandoff(body.token);
    response
      .setHeader(
        'Content-Security-Policy',
        "default-src 'none'; form-action http: https:; script-src 'unsafe-inline'; base-uri 'none'",
      )
      .type('html')
      .send(html);
  }
}

@Controller('domain-app-login')
export class LegacyDomainApplicationLoginController {
  @Get(':token')
  @Public()
  legacy(): never {
    throw new GoneException('Legacy MODX login handoff is disabled');
  }
}
