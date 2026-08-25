import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

export interface NormalizedDiskMetrics {
  mountPoint: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usagePercent: number;
}

export interface MetricsInput {
  cpuPercent: number | null;
  memoryPercent: number | null;
  memoryUsed: number | null;
  memoryTotal: number | null;
  diskPercent: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
  networkRx: number | null;
  networkTx: number | null;
  hostname: string | null;
  cpuCores: number | null;
  loadAverage: [number, number, number] | null;
  disks: NormalizedDiskMetrics[];
  uptimeSeconds: number | null;
  collectedAt: string;
}

export interface MetricsPoint {
  t: string;
  cpu: number;
  mem: number;
  disk: number;
  netRx: number;
  netTx: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finite(value: unknown, options: { min?: number; max?: number } = {}): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (options.min !== undefined && value < options.min) return null;
  if (options.max !== undefined && value > options.max) return null;
  return value;
}

function safeTimestamp(value: unknown): string {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed <= Date.now() + 5 * 60_000) {
      return new Date(parsed).toISOString();
    }
  }
  return new Date(0).toISOString();
}

function normalizeLoadAverage(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const normalized = value.slice(0, 3).map((item) => finite(item, { min: 0 }));
  if (normalized.some((item) => item === null)) return null;
  return normalized as [number, number, number];
}

function normalizeDisks(value: unknown): NormalizedDiskMetrics[] {
  if (!Array.isArray(value)) return [];
  const disks: NormalizedDiskMetrics[] = [];
  for (const item of value) {
    const raw = record(item);
    if (!raw || typeof raw.mountPoint !== 'string') continue;
    const mountPoint = raw.mountPoint.trim().slice(0, 256);
    const totalBytes = finite(raw.totalBytes, { min: 1 });
    const usedBytes = finite(raw.usedBytes, { min: 0 });
    const availableBytes = finite(raw.availableBytes, { min: 0 });
    const usagePercent = finite(raw.usagePercent, { min: 0, max: 100 });
    if (
      !mountPoint ||
      totalBytes === null ||
      usedBytes === null ||
      usedBytes > totalBytes ||
      (availableBytes !== null && availableBytes > totalBytes) ||
      usagePercent === null
    ) {
      continue;
    }
    disks.push({
      mountPoint,
      totalBytes,
      usedBytes,
      availableBytes: availableBytes ?? Math.max(0, totalBytes - usedBytes),
      usagePercent,
    });
  }
  return disks;
}

@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);
  private latestMetrics: MetricsInput | null = null;

  constructor(private readonly prisma: PrismaService) {}

  updateLatest(value: unknown): void {
    const data = record(value);
    if (!data) return;

    const disks = normalizeDisks(data.disks);
    const rootDisk = disks.find((disk) => disk.mountPoint === '/') ?? disks[0] ?? null;
    const network = record(data.network);
    const rawMemoryUsed = finite(data.memoryUsedBytes, { min: 0 });
    const rawMemoryTotal = finite(data.memoryTotalBytes, { min: 1 });
    const memoryPairValid =
      rawMemoryUsed !== null &&
      rawMemoryTotal !== null &&
      rawMemoryUsed <= rawMemoryTotal;
    const memoryUsed = memoryPairValid ? rawMemoryUsed : null;
    const memoryTotal = memoryPairValid ? rawMemoryTotal : null;
    const sentMemoryPercent = finite(data.memoryUsagePercent, { min: 0, max: 100 });

    this.latestMetrics = {
      cpuPercent: finite(data.cpuUsagePercent, { min: 0, max: 100 }),
      memoryPercent:
        memoryPairValid
          ? sentMemoryPercent ??
            Math.min(100, (rawMemoryUsed / rawMemoryTotal) * 100)
          : null,
      memoryUsed,
      memoryTotal,
      diskPercent: rootDisk?.usagePercent ?? null,
      diskUsed: rootDisk?.usedBytes ?? null,
      diskTotal: rootDisk?.totalBytes ?? null,
      networkRx: network ? finite(network.rxBytesPerSec, { min: 0 }) : null,
      networkTx: network ? finite(network.txBytesPerSec, { min: 0 }) : null,
      hostname:
        typeof data.hostname === 'string' && data.hostname.trim()
          ? data.hostname.trim().slice(0, 253)
          : null,
      cpuCores: finite(data.cpuCores, { min: 1, max: 4096 }),
      loadAverage: normalizeLoadAverage(data.loadAverage),
      disks,
      uptimeSeconds: finite(data.uptimeSeconds, { min: 0 }),
      collectedAt: safeTimestamp(data.collectedAt),
    };
  }

  getLatestMetrics(): MetricsInput | null {
    return this.latestMetrics;
  }

  async saveSnapshot(): Promise<void> {
    const m = this.latestMetrics;
    if (
      !m ||
      m.cpuPercent === null ||
      m.memoryPercent === null ||
      m.memoryUsed === null ||
      m.memoryTotal === null ||
      m.diskPercent === null ||
      m.diskUsed === null ||
      m.diskTotal === null ||
      m.networkRx === null ||
      m.networkTx === null
    ) {
      return;
    }

    await this.prisma.metricsSnapshot.create({
      data: {
        cpuPercent: m.cpuPercent,
        memoryPercent: m.memoryPercent,
        memoryUsed: BigInt(Math.round(m.memoryUsed)),
        memoryTotal: BigInt(Math.round(m.memoryTotal)),
        diskPercent: m.diskPercent,
        diskUsed: BigInt(Math.round(m.diskUsed)),
        diskTotal: BigInt(Math.round(m.diskTotal)),
        networkRx: BigInt(Math.round(m.networkRx)),
        networkTx: BigInt(Math.round(m.networkTx)),
      },
    });
  }

  async getHistory(range: string): Promise<MetricsPoint[]> {
    const now = new Date();
    let since: Date;
    let maxPoints: number;

    switch (range) {
      case '6h':
        since = new Date(now.getTime() - 6 * 60 * 60 * 1000);
        maxPoints = 72;
        break;
      case '24h':
        since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        maxPoints = 144;
        break;
      case '7d':
        since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        maxPoints = 168;
        break;
      case '30d':
        since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        maxPoints = 180;
        break;
      default:
        since = new Date(now.getTime() - 60 * 60 * 1000);
        maxPoints = 60;
    }

    const rows = await this.prisma.metricsSnapshot.findMany({
      where: { timestamp: { gte: since } },
      orderBy: { timestamp: 'asc' },
      select: {
        timestamp: true,
        cpuPercent: true,
        memoryPercent: true,
        diskPercent: true,
        networkRx: true,
        networkTx: true,
      },
    });

    if (rows.length <= maxPoints) return rows.map((row) => this.toPoint(row));

    const bucketSize = Math.ceil(rows.length / maxPoints);
    const result: MetricsPoint[] = [];
    for (let i = 0; i < rows.length; i += bucketSize) {
      const bucket = rows.slice(i, i + bucketSize);
      const middle = bucket[Math.floor(bucket.length / 2)];
      const average = (get: (row: (typeof bucket)[number]) => number) =>
        bucket.reduce((sum, row) => sum + get(row), 0) / bucket.length;
      result.push({
        t: middle.timestamp.toISOString(),
        cpu: Math.round(average((row) => row.cpuPercent) * 10) / 10,
        mem: Math.round(average((row) => row.memoryPercent) * 10) / 10,
        disk: Math.round(average((row) => row.diskPercent) * 10) / 10,
        netRx: Math.round(average((row) => Number(row.networkRx))),
        netTx: Math.round(average((row) => Number(row.networkTx))),
      });
    }
    return result;
  }

  private toPoint(row: {
    timestamp: Date;
    cpuPercent: number;
    memoryPercent: number;
    diskPercent: number;
    networkRx: bigint;
    networkTx: bigint;
  }): MetricsPoint {
    return {
      t: row.timestamp.toISOString(),
      cpu: row.cpuPercent,
      mem: row.memoryPercent,
      disk: row.diskPercent,
      netRx: Number(row.networkRx),
      netTx: Number(row.networkTx),
    };
  }

  async cleanup(): Promise<number> {
    const days = Number(process.env.MONITORING_RETENTION_DAYS) || 30;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.metricsSnapshot.deleteMany({
      where: { timestamp: { lt: cutoff } },
    });
    if (count > 0) {
      this.logger.log(`Cleaned up ${count} old metrics snapshots (retention=${days}d)`);
    }
    return count;
  }
}
