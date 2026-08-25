import {
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  FederatedWebhookDelivery,
  validateFederatedWebhookDelivery,
} from '@meowbox/shared';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { WEBHOOK_MAX_ATTEMPTS, WEBHOOK_QUEUE_LIMIT_DEFAULT } from './webhook.constants';
import { verifyWebhookProviderDelivery } from './webhook-provider';
import { WebhookRouteService } from './webhook-route.service';
import { WebhookSpoolService } from './webhook-spool.service';

export type WebhookIngressResult =
  | Readonly<{ ignored: true }>
  | Readonly<{ ignored: false; deliveryId: string; replayed: boolean }>;

function isSameProviderDelivery(
  delivery: Readonly<{ bodySha256: string; event: string }>,
  bodySha256: string,
  event: string,
): boolean {
  return delivery.bodySha256 === bodySha256 && delivery.event === event;
}

@Injectable()
export class WebhookIngressService {
  private readonly logger = new Logger(WebhookIngressService.name);
  private readonly queueLimit: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly routes: WebhookRouteService,
    private readonly spool: WebhookSpoolService,
    config: ConfigService,
  ) {
    const configured = Number(config.get('WEBHOOK_QUEUE_LIMIT', WEBHOOK_QUEUE_LIMIT_DEFAULT));
    this.queueLimit = Number.isInteger(configured) && configured >= 1 && configured <= 100_000
      ? configured
      : WEBHOOK_QUEUE_LIMIT_DEFAULT;
  }

  async accept(
    token: string,
    rawHeaders: readonly string[],
    body: Buffer,
    now = new Date(),
  ): Promise<WebhookIngressResult> {
    const route = await this.routes.resolvePublicToken(token);
    const verifier = this.routes.verifier(route);
    const provider = verifyWebhookProviderDelivery(
      verifier.provider,
      verifier.secret,
      rawHeaders,
      body,
    );
    if (provider.event !== 'push') return { ignored: true };
    const ref = provider.payload.ref;
    if (typeof ref !== 'string' || !/^refs\/heads\/[A-Za-z0-9._/-]{1,128}$/.test(ref)) {
      throw new ConflictException('Webhook push ref is invalid');
    }
    const bodySha256 = createHash('sha256').update(body).digest('hex');
    const existing = await this.prisma.webhookDelivery.findUnique({
      where: {
        routeId_providerDeliveryId: {
          routeId: route.id,
          providerDeliveryId: provider.providerDeliveryId,
        },
      },
    });
    if (existing) {
      if (!isSameProviderDelivery(existing, bodySha256, provider.event)) {
        throw new ConflictException('Webhook delivery ID is bound to different bytes');
      }
      return { ignored: false, deliveryId: existing.id, replayed: true };
    }
    const queued = await this.prisma.webhookDelivery.count({
      where: { state: { in: ['ACCEPTED', 'DELIVERING', 'RETRY_WAIT'] } },
    });
    if (queued >= this.queueLimit) {
      throw new ServiceUnavailableException('Webhook delivery queue is full');
    }

    const deliveryId = randomUUID();
    const delivery = validateFederatedWebhookDelivery({
      schemaVersion: 1,
      deliveryId,
      routeId: route.id,
      targetInstallationId: route.targetInstallationId,
      siteId: route.targetSiteId,
      domainId: route.targetDomainId,
      domain: route.targetDomain,
      provider: provider.provider,
      providerDeliveryId: provider.providerDeliveryId,
      event: 'push',
      receivedAt: now.toISOString(),
      rawBodyBase64: body.toString('base64url'),
      rawBodySha256: bodySha256,
      providerSignature: provider.signature,
    } satisfies FederatedWebhookDelivery);
    const spoolRelativePath = await this.spool.write(delivery);
    try {
      const admission = await this.prisma.$transaction(async (tx) => {
        const concurrent = await tx.webhookDelivery.findUnique({
          where: {
            routeId_providerDeliveryId: {
              routeId: route.id,
              providerDeliveryId: provider.providerDeliveryId,
            },
          },
        });
        if (concurrent) return { created: false as const, delivery: concurrent };
        const currentQueueDepth = await tx.webhookDelivery.count({
          where: { state: { in: ['ACCEPTED', 'DELIVERING', 'RETRY_WAIT'] } },
        });
        if (currentQueueDepth >= this.queueLimit) {
          throw new ServiceUnavailableException('Webhook delivery queue is full');
        }
        const created = await tx.webhookDelivery.create({
          data: {
            id: deliveryId,
            routeId: route.id,
            providerDeliveryId: provider.providerDeliveryId,
            event: 'push',
            bodySha256,
            spoolRelativePath,
            state: 'ACCEPTED',
            attempt: 0,
            maxAttempts: WEBHOOK_MAX_ATTEMPTS,
            availableAt: now,
            acceptedAt: now,
          },
        });
        return { created: true as const, delivery: created };
      });
      if (!admission.created) {
        await this.spool.remove(deliveryId);
        if (!isSameProviderDelivery(admission.delivery, bodySha256, provider.event)) {
          throw new ConflictException('Webhook delivery ID is bound to different bytes');
        }
        return { ignored: false, deliveryId: admission.delivery.id, replayed: true };
      }
    } catch (error) {
      await this.spool.remove(deliveryId).catch(() => undefined);
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const concurrent = await this.prisma.webhookDelivery.findUnique({
          where: {
            routeId_providerDeliveryId: {
              routeId: route.id,
              providerDeliveryId: provider.providerDeliveryId,
            },
          },
        });
        if (concurrent && isSameProviderDelivery(concurrent, bodySha256, provider.event)) {
          return { ignored: false, deliveryId: concurrent.id, replayed: true };
        }
      }
      throw error;
    }
    this.logger.log('public.webhook_enqueue outcome=accepted');
    return { ignored: false, deliveryId, replayed: false };
  }
}
