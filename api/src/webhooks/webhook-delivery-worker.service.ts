import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WebhookDelivery, WebhookRoute } from '@prisma/client';
import {
  FederatedWebhookDelivery,
  FederatedWebhookDeliveryResult,
  safeErrorMessage,
  validateFederatedWebhookDeliveryResult,
} from '@meowbox/shared';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import {
  FederationDispatchError,
  FederationDispatcherService,
} from '../federation/federation-dispatcher.service';
import { PanelIdentityService } from '../federation/panel-identity.service';
import {
  FEDERATED_WEBHOOK_SERVICE_SUBJECT,
  WEBHOOK_DELIVERY_TIMEOUT_MS,
  WEBHOOK_DLQ_RETENTION_MS_DEFAULT,
  WEBHOOK_LEASE_MS,
  WEBHOOK_RETRY_DELAYS_MS,
  WEBHOOK_WORKER_CONCURRENCY_DEFAULT,
} from './webhook.constants';
import { WebhookSpoolService } from './webhook-spool.service';
import { WebhookTargetDeliveryService } from './webhook-target-delivery.service';

type ClaimedDelivery = WebhookDelivery & { route: WebhookRoute };

async function readBoundedJson(body: AsyncIterable<Buffer>): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of body) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new Error('Webhook target response exceeded bounds');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    throw new Error('Webhook target response is invalid');
  }
}

@Injectable()
export class WebhookDeliveryWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookDeliveryWorkerService.name);
  private readonly workerId = `webhook:${process.pid}:${randomUUID()}`;
  private readonly active = new Map<string, Promise<void>>();
  private readonly activeTargets = new Set<string>();
  private readonly concurrency: number;
  private readonly dlqRetentionMs: number;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private stopped = false;
  private autoPolling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly panelIdentity: PanelIdentityService,
    private readonly dispatcher: FederationDispatcherService,
    private readonly localTarget: WebhookTargetDeliveryService,
    private readonly spool: WebhookSpoolService,
    config: ConfigService,
  ) {
    const concurrency = Number(config.get('WEBHOOK_WORKER_CONCURRENCY', WEBHOOK_WORKER_CONCURRENCY_DEFAULT));
    this.concurrency = Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 16
      ? concurrency
      : WEBHOOK_WORKER_CONCURRENCY_DEFAULT;
    const retention = Number(config.get('WEBHOOK_DLQ_RETENTION_MS', WEBHOOK_DLQ_RETENTION_MS_DEFAULT));
    this.dlqRetentionMs = Number.isSafeInteger(retention) && retention >= 60_000
      ? retention
      : WEBHOOK_DLQ_RETENTION_MS_DEFAULT;
  }

  onModuleInit(): void {
    this.autoPolling = true;
    this.schedule(0);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    this.autoPolling = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async pollOnce(now = new Date()): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      while (!this.stopped && this.active.size < this.concurrency) {
        const claimed = await this.claimNext(now);
        if (!claimed) break;
        this.activeTargets.add(claimed.route.targetInstallationId);
        const execution = this.execute(claimed)
          .catch((error: unknown) => {
            this.logger.error(`public.webhook_delivery outcome=worker_error code=${this.errorCode(error)}`);
          })
          .finally(() => {
            this.active.delete(claimed.id);
            this.activeTargets.delete(claimed.route.targetInstallationId);
            if (this.autoPolling) this.schedule(0);
          });
        this.active.set(claimed.id, execution);
      }
    } finally {
      this.polling = false;
    }
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.active.values()]);
  }

  async redrive(deliveryId: string): Promise<void> {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { route: true },
    });
    if (!delivery || delivery.state !== 'DLQ') throw new NotFoundException('Webhook DLQ delivery not found');
    if (delivery.route.state !== 'ACTIVE' || delivery.route.revokedAt !== null) {
      throw new ConflictException('Webhook route is revoked');
    }
    await this.spool.moveToQueue(deliveryId);
    const updated = await this.prisma.webhookDelivery.updateMany({
      where: { id: deliveryId, state: 'DLQ' },
      data: {
        state: 'ACCEPTED',
        attempt: 0,
        availableAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        dlqAt: null,
      },
    });
    if (updated.count !== 1) throw new ConflictException('Webhook delivery changed concurrently');
    if (this.autoPolling) this.schedule(0);
  }

  async cleanupDlq(now = new Date()): Promise<number> {
    const expired = await this.prisma.webhookDelivery.findMany({
      where: {
        state: 'DLQ',
        dlqAt: { lte: new Date(now.getTime() - this.dlqRetentionMs) },
      },
      orderBy: { dlqAt: 'asc' },
      take: 100,
      select: { id: true },
    });
    for (const { id } of expired) {
      await this.spool.remove(id, 'dlq');
      await this.spool.remove(id, 'queue');
    }
    if (expired.length > 0) {
      await this.prisma.webhookDelivery.deleteMany({
        where: { id: { in: expired.map(({ id }) => id) }, state: 'DLQ' },
      });
    }
    return expired.length;
  }

  private schedule(delayMs: number): void {
    if (this.stopped || !this.autoPolling || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pollOnce().finally(() => this.schedule(1_000));
    }, delayMs);
    this.timer.unref();
  }

  private async claimNext(now: Date): Promise<ClaimedDelivery | null> {
    const candidates = await this.prisma.webhookDelivery.findMany({
      where: {
        OR: [
          { state: { in: ['ACCEPTED', 'RETRY_WAIT'] }, availableAt: { lte: now } },
          { state: 'DELIVERING', leaseExpiresAt: { lte: now } },
        ],
      },
      include: { route: true },
      orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }],
      take: 32,
    });
    for (const candidate of candidates) {
      if (this.activeTargets.has(candidate.route.targetInstallationId)) continue;
      const claimed = await this.prisma.webhookDelivery.updateMany({
        where: {
          id: candidate.id,
          OR: [
            { state: { in: ['ACCEPTED', 'RETRY_WAIT'] }, availableAt: { lte: now } },
            { state: 'DELIVERING', leaseExpiresAt: { lte: now } },
          ],
        },
        data: {
          state: 'DELIVERING',
          leaseOwner: this.workerId,
          leaseExpiresAt: new Date(now.getTime() + WEBHOOK_LEASE_MS),
          lastAttemptAt: now,
          attempt: { increment: 1 },
        },
      });
      if (claimed.count !== 1) continue;
      return this.prisma.webhookDelivery.findUnique({
        where: { id: candidate.id },
        include: { route: true },
      });
    }
    return null;
  }

  private async execute(delivery: ClaimedDelivery): Promise<void> {
    if (delivery.route.state !== 'ACTIVE' || delivery.route.revokedAt !== null) {
      await this.fail(delivery, new Error('Webhook route is revoked'), true);
      return;
    }
    try {
      const payload = await this.spool.read({
        deliveryId: delivery.id,
        routeId: delivery.routeId,
        rawBodySha256: delivery.bodySha256,
      });
      const identity = await this.panelIdentity.getLocalIdentity();
      let result: FederatedWebhookDeliveryResult;
      let targetRequestId: string | null = null;
      if (delivery.route.remoteServerId === null) {
        result = await this.localTarget.deliver(payload, {
          issuerInstallationId: identity.installationId,
        });
      } else {
        const body = Buffer.from(JSON.stringify(payload), 'utf8');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), WEBHOOK_DELIVERY_TIMEOUT_MS);
        timer.unref();
        try {
          const response = await this.dispatcher.dispatchService({
            targetInstallationId: delivery.route.targetInstallationId,
            inboundTarget: `/api/proxy/${delivery.route.targetInstallationId}/federation/v1/webhooks/deliveries/${delivery.id}`,
            method: 'POST',
            rawHeaders: [
              'content-type', 'application/json',
              'idempotency-key', `webhook-${delivery.id}-${delivery.attempt}`,
            ],
            body,
            serviceSubject: FEDERATED_WEBHOOK_SERVICE_SUBJECT,
            browserIp: '127.0.0.1',
            signal: controller.signal,
          });
          targetRequestId = response.requestId;
          const parsed = await readBoundedJson(response.body);
          if (response.statusCode !== 200 || !parsed || typeof parsed !== 'object') {
            throw new Error(`Webhook target rejected delivery with status ${response.statusCode}`);
          }
          const data = (parsed as { data?: unknown }).data;
          result = validateFederatedWebhookDeliveryResult(data);
        } finally {
          clearTimeout(timer);
        }
      }
      if (result.deliveryId !== delivery.id) throw new Error('Webhook target result binding mismatch');
      const completed = await this.prisma.webhookDelivery.updateMany({
        where: { id: delivery.id, state: 'DELIVERING', leaseOwner: this.workerId },
        data: {
          state: 'DELIVERED',
          leaseOwner: null,
          leaseExpiresAt: null,
          targetRequestId,
          result: JSON.stringify(result),
          lastErrorCode: null,
          deliveredAt: new Date(),
        },
      });
      if (completed.count === 1) await this.spool.remove(delivery.id);
      this.logger.log('public.webhook_delivery outcome=delivered');
    } catch (error) {
      await this.fail(delivery, error, false);
    }
  }

  private async fail(delivery: ClaimedDelivery, error: unknown, forceDlq: boolean): Promise<void> {
    const code = this.errorCode(error);
    const terminal = forceDlq || delivery.attempt >= delivery.maxAttempts;
    if (terminal) {
      const updated = await this.prisma.webhookDelivery.updateMany({
        where: { id: delivery.id, state: 'DELIVERING', leaseOwner: this.workerId },
        data: {
          state: 'DLQ',
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: code,
          dlqAt: new Date(),
        },
      });
      if (updated.count === 1) await this.spool.moveToDlq(delivery.id).catch(() => undefined);
      this.logger.warn(`public.webhook_dlq outcome=stored code=${code}`);
      return;
    }
    const delay = WEBHOOK_RETRY_DELAYS_MS[Math.min(delivery.attempt - 1, WEBHOOK_RETRY_DELAYS_MS.length - 1)];
    await this.prisma.webhookDelivery.updateMany({
      where: { id: delivery.id, state: 'DELIVERING', leaseOwner: this.workerId },
      data: {
        state: 'RETRY_WAIT',
        availableAt: new Date(Date.now() + delay),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: code,
      },
    });
    this.logger.warn(`public.webhook_retry outcome=scheduled code=${code}`);
  }

  private errorCode(error: unknown): string {
    if (error instanceof FederationDispatchError) return error.contract.code;
    const name = error instanceof Error ? error.name : 'Error';
    const safeName = name.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64).toUpperCase();
    void safeErrorMessage(error, 'Webhook delivery failed');
    return safeName || 'DELIVERY_FAILED';
  }
}
