import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import {
  FederationRequestState,
  isVerifiedFederationRequest,
} from '../federation/federation-request-context';
import { FederationManifestService } from '../federation/federation-manifest.service';
import { PanelUpdateService } from './panel-update.service';

const RELEASE_VERSION = /^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;

interface AuthCtx {
  id: string;
  role: string;
}

function assertFederatedAdmin(request: FederationRequestState): void {
  if (
    !isVerifiedFederationRequest(request) ||
    request.federationContext.actorKind !== 'OPERATOR' ||
    request.federationContext.role !== 'ADMIN'
  ) {
    throw new ForbiddenException('Verified federated ADMIN is required');
  }
}

@Controller('federation/v1/target-update')
@Roles('ADMIN')
export class FederatedTargetUpdateController {
  constructor(
    private readonly updates: PanelUpdateService,
    private readonly manifests: FederationManifestService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async trigger(
    @Body() body: { version?: unknown },
    @CurrentUser() user: AuthCtx,
    @Headers('idempotency-key') _idempotencyKey: string | undefined,
    @Req() request: FederationRequestState,
  ) {
    assertFederatedAdmin(request);
    if (typeof body?.version !== 'string' || !RELEASE_VERSION.test(body.version)) {
      throw new BadRequestException('version must be a release semver');
    }
    const data = await this.updates.triggerUpdate(body.version, user.id, user.role);
    return {
      success: true,
      data: {
        ...data,
        targetVersion: body.version,
        statusPath: '/api/federation/v1/target-update/status',
      },
    };
  }

  @Get('status')
  async status(@Req() request: FederationRequestState) {
    assertFederatedAdmin(request);
    return { success: true, data: await this.updates.getStatus(false) };
  }

  @Get('manifest')
  async manifest(@Req() request: FederationRequestState) {
    assertFederatedAdmin(request);
    return { success: true, data: await this.manifests.manifest() };
  }
}
