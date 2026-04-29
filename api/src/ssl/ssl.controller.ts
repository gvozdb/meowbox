import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SslService } from './ssl.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { InstallCustomCertDto } from './ssl.dto';

import { Roles } from '../common/decorators/roles.decorator';

interface JwtUser {
  id: string;
  role: string;
}

@Controller('ssl')
@Roles('ADMIN', 'MANAGER')
export class SslOverviewController {
  constructor(private readonly sslService: SslService) {}

  @Get()
  async getAll(@CurrentUser('id') userId: string, @CurrentUser('role') role: string) {
    const data = await this.sslService.findAll(userId, role);
    return { success: true, data };
  }
}

@Controller('sites/:siteId/ssl')
export class SslController {
  constructor(private readonly sslService: SslService) {}

  @Get()
  async getCertificate(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const cert = await this.sslService.findBySite(siteId, user!.id, user!.role);
    return { success: true, data: cert };
  }

  @Post('issue')
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  async issueCertificate(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const params = await this.sslService.requestIssuance(siteId, user!.id, user!.role);
    return {
      success: true,
      data: params,
      message: 'SSL certificate issued successfully',
    };
  }

  // Отозвать (и удалить) действующий сертификат через UI.
  @Post('revoke')
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  async revokeCertificate(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const result = await this.sslService.revokeCertificate(siteId, user!.id, user!.role);
    return { success: true, data: result };
  }

  // Подхватить уже выпущенный на диске сертификат (без нового запроса к LE).
  @Post('import')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async importExistingCertificate(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const result = await this.sslService.importExistingCertificate(siteId, user!.id, user!.role);
    return { success: true, data: result };
  }

  @Post('custom')
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  async installCustomCertificate(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() body: InstallCustomCertDto,
    @CurrentUser() user?: JwtUser,
  ) {
    const result = await this.sslService.installCustomCertificate(
      siteId,
      user!.id,
      user!.role,
      body.certPem,
      body.keyPem,
      body.chainPem,
    );
    return { success: true, data: result };
  }
}
