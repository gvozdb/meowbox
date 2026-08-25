import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Headers,
  Req,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { DeployService } from './deploy.service';
import { TriggerDeployDto } from './deploy.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import {
  detectWebhookProvider,
  verifyWebhookProviderDelivery,
} from '../webhooks/webhook-provider';

interface JwtUser {
  id: string;
  role: string;
}

@Controller()
export class DeployController {
  constructor(
    private readonly deployService: DeployService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Trigger a manual deploy.
   */
  @Post('sites/:siteId/domains/:domainId/deploy')
  @Roles('ADMIN', 'MANAGER')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async triggerDeploy(
    @Body() dto: TriggerDeployDto,
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @CurrentUser() user: JwtUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const { deployLog, site } = await this.deployService.triggerDeploy(
      siteId,
      domainId,
      user.id,
      user.role,
      dto.branch,
      idempotencyKey,
    );

    return {
      success: true,
      data: {
        deployId: deployLog.id,
        siteId: site.id,
        siteDomainId: domainId,
        branch: deployLog.branch,
        status: deployLog.status,
      },
    };
  }

  /**
   * Rollback to a specific deploy.
   */
  @Post('sites/:siteId/domains/:domainId/deploys/:id/rollback')
  @Roles('ADMIN', 'MANAGER')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async rollbackDeploy(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const rollbackLog = await this.deployService.rollbackDeploy(
      siteId,
      domainId,
      id,
      user.id,
      user.role,
      idempotencyKey,
    );
    return {
      success: true,
      data: {
        deployId: rollbackLog.id,
        status: rollbackLog.status,
      },
    };
  }

  /**
   * GitHub / Gitea webhook endpoint.
   * Public (no JWT), authenticated by HMAC signature.
   */
  @Post('deploy/webhook/:domain')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async webhook(
    @Param('domain') domain: string,
    @Req() req: { body: unknown; rawHeaders?: string[] },
  ) {
    const webhookSecret = this.config.get<string>('WEBHOOK_SECRET');
    if (!webhookSecret) {
      throw new ServiceUnavailableException('Webhook not configured');
    }
    if (!Buffer.isBuffer(req.body) || !Array.isArray(req.rawHeaders)) {
      throw new ServiceUnavailableException('Exact webhook bytes are unavailable');
    }
    const verified = verifyWebhookProviderDelivery(
      detectWebhookProvider(req.rawHeaders),
      webhookSecret,
      req.rawHeaders,
      req.body,
    );
    if (verified.event !== 'push') {
      return { success: true, message: 'Event ignored' };
    }
    const body = verified.payload as {
      ref?: string;
      head_commit?: { id?: string; message?: string };
      repository?: { clone_url?: string; ssh_url?: string };
    };

    // Find site by domain
    const app = await this.deployService.findSiteByDomain(domain);
    if (!app) {
      return { success: false, message: 'Site not found' };
    }

    // Check branch matches
    const pushBranch = body.ref?.replace('refs/heads/', '') || '';
    const deployBranch = app.deployBranch || 'main';
    if (pushBranch !== deployBranch) {
      return { success: true, message: `Branch ${pushBranch} ignored (watching ${deployBranch})` };
    }

    // Trigger deploy
    try {
      const { deployLog } = await this.deployService.triggerDeploy(
        app.site.id,
        app.id,
        app.site.userId,
        'ADMIN', // Webhook-triggered deploys run with admin privileges
        pushBranch,
      );

      return {
        success: true,
        data: {
          deployId: deployLog.id,
          branch: pushBranch,
        },
      };
    } catch (e: unknown) {
      const error = e as { message?: string };
      return {
        success: false,
        message: error.message || 'Deploy trigger failed',
      };
    }
  }

  /**
   * Get deploy logs for a site.
   */
  @Get('sites/:siteId/domains/:domainId/deploys')
  async listDeploys(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Query('page') page?: string,
    @Query('perPage') perPage?: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const logs = await this.deployService.findBySite({
      siteId,
      domainId,
      userId: user!.id,
      role: user!.role,
      page: page ? parseInt(page, 10) : 1,
      perPage: perPage ? parseInt(perPage, 10) : 20,
    });

    return { success: true, ...logs };
  }

  /**
   * Get a single deploy log.
   */
  @Get('sites/:siteId/domains/:domainId/deploys/:id')
  async getDeploy(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const log = await this.deployService.findById(
      siteId,
      domainId,
      id,
      user!.id,
      user!.role,
    );
    return { success: true, data: log };
  }
}
