import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, WebhookRoute } from '@prisma/client';
import {
  FederatedWebhookProvider,
  PublicEndpointDelivery,
  validatePublicDelivery,
} from '@meowbox/shared';
import {
  createHash,
  timingSafeEqual,
  randomUUID,
} from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import {
  decryptWebhookRouteVerifier,
  deriveWebhookRouteToken,
  encryptWebhookRouteVerifier,
  webhookRouteTokenHash,
} from '../common/crypto/webhook-cipher';
import { PanelIdentityService } from '../federation/panel-identity.service';
import { RemoteContextService } from '../federation/remote-context.service';
import { PublicDeliveryOriginService } from '../public-delivery/public-delivery-origin.service';
import { FEDERATED_WEBHOOK_DELIVERY_ACTION_ID } from './webhook.constants';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

interface WebhookRouteTarget {
  remoteServerId: string | null;
  targetInstallationId: string;
}

function assertRouteVerifier(
  route: WebhookRoute,
  provider: FederatedWebhookProvider,
  secret: string,
): void {
  const verifier = decryptWebhookRouteVerifier(route.id, route.verifierEnc);
  if (verifier.provider !== provider || verifier.secret !== secret) {
    throw new ConflictException('Webhook route already exists with a different verifier');
  }
}

function digest(...parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest('hex');
}

@Injectable()
export class WebhookRouteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly panelIdentity: PanelIdentityService,
    private readonly contexts: RemoteContextService,
    private readonly origins: PublicDeliveryOriginService,
  ) {}

  async create(input: {
    serverId: string;
    siteId: string;
    domainId: string;
    domain: string;
    provider: FederatedWebhookProvider;
    secret: string;
    actorUserId: string;
  }): Promise<PublicEndpointDelivery> {
    const target = await this.resolveTarget(input.serverId);
    const domain = input.domain.trim().toLowerCase();
    if (target.remoteServerId === null) {
      const local = await this.prisma.siteDomain.findUnique({
        where: { id: input.domainId },
        select: { id: true, siteId: true, domain: true },
      });
      if (!local || local.siteId !== input.siteId || local.domain !== domain) {
        throw new NotFoundException('Webhook target domain not found');
      }
    }
    const dedupeKey = digest(
      'webhook-route-v1',
      input.actorUserId,
      target.targetInstallationId,
      input.siteId,
      input.domainId,
      input.provider,
    );
    const existing = await this.prisma.webhookRoute.findUnique({ where: { dedupeKey } });
    if (existing && existing.state === 'ACTIVE' && existing.revokedAt === null) {
      assertRouteVerifier(existing, input.provider, input.secret);
      return this.delivery(existing);
    }

    const id = randomUUID();
    const tokenVersion = 1;
    const tokenHash = webhookRouteTokenHash(deriveWebhookRouteToken(id, tokenVersion));
    try {
      const route = await this.prisma.webhookRoute.create({
        data: {
          id,
          dedupeKey,
          tokenVersion,
          tokenHash,
          createdByUserId: input.actorUserId,
          remoteServerId: target.remoteServerId,
          targetInstallationId: target.targetInstallationId,
          targetSiteId: input.siteId,
          targetDomainId: input.domainId,
          targetDomain: domain,
          provider: input.provider,
          verifierEnc: encryptWebhookRouteVerifier(id, input.provider, input.secret),
          state: 'ACTIVE',
        },
      });
      return this.delivery(route);
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const concurrent = await this.prisma.webhookRoute.findUnique({ where: { dedupeKey } });
      if (!concurrent || concurrent.state !== 'ACTIVE') {
        throw new ConflictException('Webhook route creation conflict');
      }
      assertRouteVerifier(concurrent, input.provider, input.secret);
      return this.delivery(concurrent);
    }
  }

  async rotate(routeId: string): Promise<PublicEndpointDelivery> {
    const current = await this.requireActive(routeId);
    const tokenVersion = current.tokenVersion + 1;
    const tokenHash = webhookRouteTokenHash(deriveWebhookRouteToken(routeId, tokenVersion));
    const updated = await this.prisma.webhookRoute.updateMany({
      where: {
        id: routeId,
        state: 'ACTIVE',
        revokedAt: null,
        tokenVersion: current.tokenVersion,
      },
      data: { tokenVersion, tokenHash },
    });
    if (updated.count !== 1) throw new ConflictException('Webhook route changed concurrently');
    return this.delivery(await this.requireActive(routeId));
  }

  async revoke(routeId: string): Promise<void> {
    const now = new Date();
    const updated = await this.prisma.webhookRoute.updateMany({
      where: { id: routeId, state: 'ACTIVE', revokedAt: null },
      data: { state: 'REVOKED', revokedAt: now, dedupeKey: null },
    });
    if (updated.count !== 1) throw new NotFoundException('Webhook route not found');
  }

  async resolvePublicToken(token: string): Promise<WebhookRoute> {
    if (!TOKEN.test(token)) throw new NotFoundException('Webhook route not found');
    const hash = webhookRouteTokenHash(token);
    const route = await this.prisma.webhookRoute.findUnique({ where: { tokenHash: hash } });
    if (!route || route.state !== 'ACTIVE' || route.revokedAt !== null) {
      throw new NotFoundException('Webhook route not found');
    }
    const expected = deriveWebhookRouteToken(route.id, route.tokenVersion);
    if (!timingSafeEqual(Buffer.from(token, 'utf8'), Buffer.from(expected, 'utf8'))) {
      throw new NotFoundException('Webhook route not found');
    }
    return route;
  }

  verifier(route: WebhookRoute): Readonly<{ provider: FederatedWebhookProvider; secret: string }> {
    const verifier = decryptWebhookRouteVerifier(route.id, route.verifierEnc);
    if (verifier.provider !== route.provider) throw new Error('Webhook route provider binding mismatch');
    return verifier;
  }

  async listDeliveries(routeId: string) {
    const route = await this.prisma.webhookRoute.findUnique({ where: { id: routeId } });
    if (!route) throw new NotFoundException('Webhook route not found');
    return this.prisma.webhookDelivery.findMany({
      where: { routeId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        providerDeliveryId: true,
        event: true,
        state: true,
        attempt: true,
        maxAttempts: true,
        availableAt: true,
        lastErrorCode: true,
        acceptedAt: true,
        deliveredAt: true,
        dlqAt: true,
      },
    });
  }

  private async resolveTarget(serverId: string): Promise<WebhookRouteTarget> {
    const identity = await this.panelIdentity.getLocalIdentity();
    if (identity.installationRole !== 'MASTER') {
      throw new ConflictException('Webhook routes are master-owned');
    }
    if (serverId === 'main' || serverId === identity.installationId) {
      return { remoteServerId: null, targetInstallationId: identity.installationId };
    }
    const server = await this.prisma.remoteServer.findUnique({
      where: { id: serverId },
      select: { id: true, installationId: true },
    });
    if (!server?.installationId) throw new NotFoundException('Webhook target not found');
    const context = await this.contexts.getRemoteContext(server.id);
    if (
      context.killSwitches.publicDelivery ||
      context.protocol.mode !== 'v1-enabled' ||
      !context.capabilities[FEDERATED_WEBHOOK_DELIVERY_ACTION_ID]?.enabled
    ) throw new ServiceUnavailableException('Webhook target capability is unavailable');
    return { remoteServerId: server.id, targetInstallationId: server.installationId };
  }

  private async requireActive(routeId: string): Promise<WebhookRoute> {
    const route = await this.prisma.webhookRoute.findUnique({ where: { id: routeId } });
    if (!route || route.state !== 'ACTIVE' || route.revokedAt !== null) {
      throw new NotFoundException('Webhook route not found');
    }
    return route;
  }

  private delivery(route: WebhookRoute): PublicEndpointDelivery {
    const token = deriveWebhookRouteToken(route.id, route.tokenVersion);
    if (webhookRouteTokenHash(token) !== route.tokenHash) {
      throw new Error('Webhook route token binding mismatch');
    }
    const headers = route.provider === 'GITHUB'
      ? ['content-type', 'x-github-delivery', 'x-github-event', 'x-hub-signature-256']
      : ['content-type', 'x-gitea-delivery', 'x-gitea-event', 'x-gitea-signature'];
    return validatePublicDelivery({
      kind: 'PublicEndpoint',
      purpose: 'DEPLOY_WEBHOOK',
      targetInstallationId: route.targetInstallationId,
      resource: { kind: 'WEBHOOK_ROUTE', id: route.id },
      method: 'POST',
      allowedHeaders: headers,
      cachePolicy: 'NO_STORE',
      referrerPolicy: 'NO_REFERRER',
      expiresAt: null,
      browserReachabilityRequired: false,
      rangeSupported: false,
      resumeSupported: false,
      fallbackReason: null,
      reusable: true,
      url: `${this.origins.browserPublicOrigin()}/api/public/v1/webhooks/${token}`,
    }) as PublicEndpointDelivery;
  }
}
