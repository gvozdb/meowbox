import { createHash } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { RESTIC_RETENTION_LEASE_MS } from './restic-retention.constants';

const SUCCESS_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 2 * 60 * 60 * 1000;

interface SweepState {
  nextAt?: number;
  leaseUntil?: number;
  status?: 'running' | 'ok' | 'failed';
}

export interface RetentionLease {
  key: string;
  value: string;
}

export class RetentionSweepState {
  constructor(private readonly prisma: Pick<PrismaService, 'panelSetting'>) {}

  async claim(locationId: string, repoName: string, now: Date): Promise<RetentionLease | null> {
    const hash = createHash('sha256').update(JSON.stringify([locationId, repoName])).digest('hex');
    const key = `restic-retention-v1:${hash}`;
    let row = await this.prisma.panelSetting.findUnique({ where: { key } });
    if (!row) {
      try {
        row = await this.prisma.panelSetting.create({ data: { key, value: '{}' } });
      } catch (err) {
        // A second API worker may have created the same key concurrently.
        if ((err as { code?: string }).code !== 'P2002') throw err;
        row = await this.prisma.panelSetting.findUnique({ where: { key } });
      }
    }
    if (!row) return null;
    const previous = JSON.parse(row.value) as SweepState;
    if ((previous.nextAt || 0) > now.getTime() || (previous.leaseUntil || 0) > now.getTime()) return null;
    const value = JSON.stringify({ status: 'running', leaseUntil: now.getTime() + RESTIC_RETENTION_LEASE_MS });
    const claimed = await this.prisma.panelSetting.updateMany({
      where: { key, value: row.value }, data: { value },
    });
    return claimed.count === 1 ? { key, value } : null;
  }

  async finish(lease: RetentionLease, success: boolean, now = new Date()): Promise<boolean> {
    const value = JSON.stringify({
      status: success ? 'ok' : 'failed',
      nextAt: now.getTime() + (success ? SUCCESS_INTERVAL_MS : RETRY_INTERVAL_MS),
    } satisfies SweepState);
    const updated = await this.prisma.panelSetting.updateMany({
      where: { key: lease.key, value: lease.value }, data: { value },
    });
    return updated.count === 1;
  }
}
