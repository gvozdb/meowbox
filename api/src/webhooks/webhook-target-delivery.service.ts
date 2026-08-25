import {
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  assertFederatedWebhookRawLength,
  FederatedWebhookDelivery,
  FederatedWebhookDeliveryResult,
  validateFederatedWebhookDelivery,
  validateFederatedWebhookDeliveryResult,
} from '@meowbox/shared';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { PrismaService } from '../common/prisma.service';
import { stableJson } from '../common/stable-json';
import { DeployService } from '../deploy/deploy.service';
import { PanelIdentityService } from '../federation/panel-identity.service';

interface TargetDeliveryContext {
  issuerInstallationId: string;
}

function digest(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function decodeBody(delivery: FederatedWebhookDelivery): Buffer {
  assertFederatedWebhookRawLength(delivery.rawBodyBase64);
  const body = Buffer.from(delivery.rawBodyBase64, 'base64url');
  if (body.toString('base64url') !== delivery.rawBodyBase64 || digest(body) !== delivery.rawBodySha256) {
    throw new ConflictException('Webhook body binding mismatch');
  }
  return body;
}

function parsePush(body: Buffer): Readonly<{ branch: string }> {
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new ConflictException('Webhook body is not valid JSON UTF-8');
  }
  const ref = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).ref
    : null;
  const match = typeof ref === 'string'
    ? /^refs\/heads\/([A-Za-z0-9._/-]{1,128})$/.exec(ref)
    : null;
  if (!match) throw new ConflictException('Webhook push ref is invalid');
  return { branch: match[1] };
}

@Injectable()
export class WebhookTargetDeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly panelIdentity: PanelIdentityService,
    private readonly deploys: DeployService,
  ) {}

  async deliver(
    rawDelivery: unknown,
    context: TargetDeliveryContext,
  ): Promise<FederatedWebhookDeliveryResult> {
    const delivery = validateFederatedWebhookDelivery(rawDelivery);
    const identity = await this.panelIdentity.getLocalIdentity();
    if (
      identity.installationId !== delivery.targetInstallationId ||
      (identity.installationRole !== 'TARGET' &&
        !(identity.installationRole === 'MASTER' && context.issuerInstallationId === identity.installationId))
    ) throw new ConflictException('Webhook target binding mismatch');
    const body = decodeBody(delivery);
    const requestHash = digest(stableJson(delivery));
    let receipt = await this.prisma.webhookDeliveryReceipt.findUnique({
      where: {
        issuerInstallationId_deliveryId: {
          issuerInstallationId: context.issuerInstallationId,
          deliveryId: delivery.deliveryId,
        },
      },
    });
    if (receipt && receipt.requestHash !== requestHash) {
      throw new ConflictException('Webhook delivery ID is bound to a different request');
    }
    if (receipt?.state === 'DELIVERED' && receipt.result) {
      return {
        ...validateFederatedWebhookDeliveryResult(JSON.parse(receipt.result)),
        duplicate: true,
      };
    }
    if (!receipt) {
      try {
        receipt = await this.prisma.webhookDeliveryReceipt.create({
          data: {
            issuerInstallationId: context.issuerInstallationId,
            deliveryId: delivery.deliveryId,
            routeId: delivery.routeId,
            requestHash,
            state: 'PROCESSING',
          },
        });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
        receipt = await this.prisma.webhookDeliveryReceipt.findUnique({
          where: {
            issuerInstallationId_deliveryId: {
              issuerInstallationId: context.issuerInstallationId,
              deliveryId: delivery.deliveryId,
            },
          },
        });
        if (!receipt || receipt.requestHash !== requestHash) {
          throw new ConflictException('Webhook receipt conflict');
        }
      }
    }

    try {
      const app = await this.deploys.findSiteByDomain(delivery.domain);
      if (
        !app ||
        app.id !== delivery.domainId ||
        app.site.id !== delivery.siteId ||
        app.domain !== delivery.domain
      ) throw new NotFoundException('Webhook target domain not found');
      const { branch } = parsePush(body);
      let result: FederatedWebhookDeliveryResult;
      if (branch !== (app.deployBranch || 'main')) {
        result = {
          schemaVersion: 1,
          deliveryId: delivery.deliveryId,
          status: 'IGNORED',
          deployId: null,
          duplicate: receipt.state !== 'PROCESSING',
        };
      } else {
        const operationKey = `webhook-${digest(`${context.issuerInstallationId}\0${delivery.deliveryId}`)}`;
        const { deployLog } = await this.deploys.triggerDeploy(
          app.site.id,
          app.id,
          app.site.userId,
          'ADMIN',
          branch,
          operationKey,
        );
        result = {
          schemaVersion: 1,
          deliveryId: delivery.deliveryId,
          status: 'DELIVERED',
          deployId: deployLog.id,
          duplicate: receipt.state !== 'PROCESSING',
        };
      }
      validateFederatedWebhookDeliveryResult(result);
      await this.prisma.webhookDeliveryReceipt.update({
        where: { id: receipt.id },
        data: {
          state: 'DELIVERED',
          deployId: result.deployId,
          result: JSON.stringify({ ...result, duplicate: false }),
          lastErrorCode: null,
          completedAt: new Date(),
        },
      });
      return result;
    } catch (error) {
      await this.prisma.webhookDeliveryReceipt.updateMany({
        where: { id: receipt.id, state: { not: 'DELIVERED' } },
        data: {
          state: 'FAILED',
          lastErrorCode: 'TARGET_DEPLOY_FAILED',
        },
      }).catch(() => undefined);
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Webhook target delivery failed');
    }
  }
}
