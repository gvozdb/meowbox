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
  ParseUUIDPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { createHmac, timingSafeEqual } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { DeployService } from './deploy.service';
import { TriggerDeployDto } from './deploy.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';

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
  @Post('deploy/trigger')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async triggerDeploy(
    @Body() dto: TriggerDeployDto,
    @CurrentUser() user: JwtUser,
  ) {
    const { deployLog, site } = await this.deployService.triggerDeploy(
      dto.siteId,
      user.id,
      user.role,
      dto.branch,
    );

    return {
      success: true,
      data: {
        deployId: deployLog.id,
        siteId: site.id,
        branch: deployLog.branch,
        status: deployLog.status,
      },
    };
  }

  /**
   * Rollback to a specific deploy.
   */
  @Post('deploys/:id/rollback')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async rollbackDeploy(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtUser,
  ) {
    const rollbackLog = await this.deployService.rollbackDeploy(id, user.id, user.role);
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
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Headers('x-github-event') event: string | undefined,
    @Req() req: { body: unknown; rawBody?: Buffer },
  ) {
    // Only respond to push events
    if (event && event !== 'push') {
      return { success: true, message: 'Event ignored' };
    }

    const webhookSecret = this.config.get<string>('WEBHOOK_SECRET');
    if (!webhookSecret) {
      return { success: false, message: 'Webhook not configured' };
    }

    // Verify HMAC signature if present
    if (signature) {
      const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
      const expectedSig =
        'sha256=' +
        createHmac('sha256', webhookSecret).update(rawBody).digest('hex');

      const sigBuffer = Buffer.from(signature);
      const expectedBuffer = Buffer.from(expectedSig);

      if (
        sigBuffer.length !== expectedBuffer.length ||
        !timingSafeEqual(sigBuffer, expectedBuffer)
      ) {
        return { success: false, message: 'Invalid signature' };
      }
    } else {
      // No signature — verify via shared secret in URL is not safe enough
      // Require HMAC
      return { success: false, message: 'Missing signature' };
    }

    const body = req.body as {
      ref?: string;
      head_commit?: { id?: string; message?: string };
      repository?: { clone_url?: string; ssh_url?: string };
    };

    // Find site by domain
    const site = await this.deployService.findSiteByDomain(domain);
    if (!site) {
      return { success: false, message: 'Site not found' };
    }

    // Check branch matches
    const pushBranch = body.ref?.replace('refs/heads/', '') || '';
    const deployBranch = site.deployBranch || 'main';
    if (pushBranch !== deployBranch) {
      return { success: true, message: `Branch ${pushBranch} ignored (watching ${deployBranch})` };
    }

    // Trigger deploy
    try {
      const { deployLog } = await this.deployService.triggerDeploy(
        site.id,
        site.userId,
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
  @Get('sites/:siteId/deploys')
  async listDeploys(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Query('page') page?: string,
    @Query('perPage') perPage?: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const logs = await this.deployService.findBySite({
      siteId,
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
  @Get('deploys/:id')
  async getDeploy(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const log = await this.deployService.findById(id, user!.id, user!.role);
    return { success: true, data: log };
  }
}
