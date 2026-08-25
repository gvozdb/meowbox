import {
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  FederatedWebhookDelivery,
  validateFederatedWebhookDelivery,
} from '@meowbox/shared';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  statfs,
  unlink,
} from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  decryptWebhookSpool,
  encryptWebhookSpool,
} from '../common/crypto/webhook-cipher';

const FILE = /^[0-9a-f-]{36}\.payload$/i;
const PARTIAL = /^[0-9a-f-]{36}-[0-9a-f-]{36}\.partial$/i;
const DEFAULT_RESERVE_BYTES = 1024 ** 3;
const DEFAULT_RESERVE_PERCENT = 10;

function positiveInt(config: ConfigService, key: string, fallback: number): number {
  const value = Number(config.get(key, fallback));
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

@Injectable()
export class WebhookSpoolService implements OnModuleInit {
  readonly root: string;
  readonly queueRoot: string;
  readonly dlqRoot: string;
  private readonly tmpRoot: string;
  private readonly reserveBytes: number;
  private readonly reservePercent: number;

  constructor(config: ConfigService) {
    const configured = String(config.get(
      'MEOWBOX_STATE_DIR',
      process.env.MEOWBOX_STATE_DIR || '/opt/meowbox/state',
    )).trim();
    const stateRoot = path.resolve(configured || '/opt/meowbox/state');
    if (stateRoot === path.parse(stateRoot).root) throw new Error('Webhook state directory is unsafe');
    this.root = path.join(stateRoot, 'data', 'webhooks');
    this.queueRoot = path.join(this.root, 'queue');
    this.dlqRoot = path.join(this.root, 'dlq');
    this.tmpRoot = path.join(this.root, 'tmp');
    this.reserveBytes = positiveInt(config, 'WEBHOOK_SPOOL_RESERVE_BYTES', DEFAULT_RESERVE_BYTES);
    const percent = Number(config.get('WEBHOOK_SPOOL_RESERVE_PERCENT', DEFAULT_RESERVE_PERCENT));
    this.reservePercent = Number.isInteger(percent) && percent >= 0 && percent <= 90
      ? percent
      : DEFAULT_RESERVE_PERCENT;
  }

  async onModuleInit(): Promise<void> {
    await this.ensureDirectories();
    await this.cleanupPartialFiles();
  }

  async write(delivery: FederatedWebhookDelivery): Promise<string> {
    const payload = encryptWebhookSpool(delivery);
    await this.assertDiskAdmission(payload.length);
    const filename = `${delivery.deliveryId}.payload`;
    const finalPath = this.resolve(this.queueRoot, filename);
    const temporaryPath = this.resolve(
      this.tmpRoot,
      `${delivery.deliveryId}-${randomUUID()}.partial`,
      PARTIAL,
    );
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(payload);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, finalPath);
    const directory = await open(this.queueRoot, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    return filename;
  }

  async read(
    delivery: Pick<FederatedWebhookDelivery, 'deliveryId' | 'routeId' | 'rawBodySha256'>,
    location: 'queue' | 'dlq' = 'queue',
  ): Promise<FederatedWebhookDelivery> {
    const root = location === 'queue' ? this.queueRoot : this.dlqRoot;
    const file = this.resolve(root, `${delivery.deliveryId}.payload`);
    const state = await lstat(file);
    if (!state.isFile() || state.isSymbolicLink() || state.size > 256 * 1024) {
      throw new Error('Webhook spool file is invalid');
    }
    return validateFederatedWebhookDelivery(
      decryptWebhookSpool(delivery, await readFile(file)),
    );
  }

  async remove(deliveryId: string, location: 'queue' | 'dlq' = 'queue'): Promise<void> {
    const root = location === 'queue' ? this.queueRoot : this.dlqRoot;
    await this.unlinkIfExists(this.resolve(root, `${deliveryId}.payload`));
  }

  async moveToDlq(deliveryId: string): Promise<void> {
    await this.move(deliveryId, this.queueRoot, this.dlqRoot);
  }

  async moveToQueue(deliveryId: string): Promise<void> {
    await this.move(deliveryId, this.dlqRoot, this.queueRoot);
  }

  private async move(deliveryId: string, sourceRoot: string, targetRoot: string): Promise<void> {
    const source = this.resolve(sourceRoot, `${deliveryId}.payload`);
    const target = this.resolve(targetRoot, `${deliveryId}.payload`);
    try {
      await rename(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const targetState = await lstat(target).catch(() => null);
      if (!targetState?.isFile() || targetState.isSymbolicLink()) throw error;
    }
  }

  private async ensureDirectories(): Promise<void> {
    for (const directory of [this.root, this.queueRoot, this.dlqRoot, this.tmpRoot]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
  }

  private async cleanupPartialFiles(): Promise<void> {
    const cutoff = Date.now() - 10 * 60_000;
    for (const entry of await readdir(this.tmpRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !PARTIAL.test(entry.name)) continue;
      const file = this.resolve(this.tmpRoot, entry.name, PARTIAL);
      const state = await lstat(file);
      if (!state.isSymbolicLink() && state.mtimeMs < cutoff) await unlink(file);
    }
  }

  private async assertDiskAdmission(bytes: number): Promise<void> {
    const disk = await statfs(this.root);
    const block = BigInt(disk.bsize);
    const free = BigInt(disk.bavail) * block;
    const total = BigInt(disk.blocks) * block;
    const percentage = total * BigInt(this.reservePercent) / 100n;
    const reserve = percentage > BigInt(this.reserveBytes)
      ? percentage
      : BigInt(this.reserveBytes);
    if (free <= reserve + BigInt(bytes)) {
      throw new ServiceUnavailableException('Webhook spool disk reserve would be violated');
    }
  }

  private resolve(root: string, filename: string, pattern: RegExp = FILE): string {
    if (!pattern.test(filename)) throw new Error('Unsafe webhook spool filename');
    const resolved = path.resolve(root, filename);
    if (path.dirname(resolved) !== root) throw new Error('Unsafe webhook spool path');
    return resolved;
  }

  private async unlinkIfExists(file: string): Promise<void> {
    try { await unlink(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
