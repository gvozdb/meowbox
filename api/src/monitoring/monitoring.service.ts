import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

export interface MetricsInput {
  cpuPercent: number;
  memoryPercent: number;
  memoryUsed: number;
  memoryTotal: number;
  diskPercent: number;
  diskUsed: number;
  diskTotal: number;
  networkRx: number;
  networkTx: number;
}

export interface MetricsPoint {
  t: string; // ISO timestamp
  cpu: number;
  mem: number;
  disk: number;
  netRx: number;
  netTx: number;
}

@Injectable()
export class MonitoringService {
  private readonly logger = new Logger('MonitoringService');
  private latestMetrics: MetricsInput | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Called from the gateway when agent sends system:metrics.
   * Stores latest in memory for the scheduler to persist.
   */
  updateLatest(data: any): void {
    if (!data) return;

    // Agent sends: cpuUsagePercent, memoryUsagePercent, memoryUsedBytes, memoryTotalBytes, disks[], network{}
    const disk = data.disks?.find((d: any) => d.mountPoint === '/') || data.disks?.[0];

    this.latestMetrics = {
      cpuPercent: data.cpuUsagePercent ?? 0,
      memoryPercent: data.memoryUsagePercent ?? 0,
      memoryUsed: data.memoryUsedBytes ?? 0,
      memoryTotal: data.memoryTotalBytes ?? 0,
      diskPercent: disk?.usagePercent ?? 0,
      diskUsed: disk?.usedBytes ?? 0,
      diskTotal: disk?.totalBytes ?? 0,
      networkRx: data.network?.rxBytesPerSec ?? 0,
      networkTx: data.network?.txBytesPerSec ?? 0,
    };
  }

  /**
   * Return current in-memory metrics (may be null if agent hasn't reported yet).
   */
  getLatestMetrics(): MetricsInput | null {
    return this.latestMetrics;
  }

  /**
   * Persist the latest metrics snapshot to DB.
   * Called by the scheduler every 60 seconds.
   */
  async saveSnapshot(): Promise<void> {
    if (!this.latestMetrics) return;

    const m = this.latestMetrics;
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

  /**
   * Query metrics history by time range.
   * Automatically downsamples for larger ranges.
   */
  async getHistory(range: string): Promise<MetricsPoint[]> {
    const now = new Date();
    let since: Date;
    let maxPoints: number;

    switch (range) {
      case '1h':
        since = new Date(now.getTime() - 60 * 60 * 1000);
        maxPoints = 60; // 1-minute resolution
        break;
      case '6h':
        since = new Date(now.getTime() - 6 * 60 * 60 * 1000);
        maxPoints = 72; // 5-minute resolution
        break;
      case '24h':
        since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        maxPoints = 144; // 10-minute resolution
        break;
      case '7d':
        since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        maxPoints = 168; // 1-hour resolution
        break;
      case '30d':
        since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        maxPoints = 180; // 4-hour resolution
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

    // Downsample if needed
    if (rows.length <= maxPoints) {
      return rows.map((r) => ({
        t: r.timestamp.toISOString(),
        cpu: r.cpuPercent,
        mem: r.memoryPercent,
        disk: r.diskPercent,
        netRx: Number(r.networkRx),
        netTx: Number(r.networkTx),
      }));
    }

    // Bucket averaging
    const bucketSize = Math.ceil(rows.length / maxPoints);
    const result: MetricsPoint[] = [];

    for (let i = 0; i < rows.length; i += bucketSize) {
      const bucket = rows.slice(i, i + bucketSize);
      const avgCpu = bucket.reduce((s, r) => s + r.cpuPercent, 0) / bucket.length;
      const avgMem = bucket.reduce((s, r) => s + r.memoryPercent, 0) / bucket.length;
      const avgDisk = bucket.reduce((s, r) => s + r.diskPercent, 0) / bucket.length;
      const avgRx = bucket.reduce((s, r) => s + Number(r.networkRx), 0) / bucket.length;
      const avgTx = bucket.reduce((s, r) => s + Number(r.networkTx), 0) / bucket.length;

      result.push({
        t: bucket[Math.floor(bucket.length / 2)].timestamp.toISOString(),
        cpu: Math.round(avgCpu * 10) / 10,
        mem: Math.round(avgMem * 10) / 10,
        disk: Math.round(avgDisk * 10) / 10,
        netRx: Math.round(avgRx),
        netTx: Math.round(avgTx),
      });
    }

    return result;
  }

  /**
   * Delete snapshots older than retention. Дефолт 30 дней; переопределяется
   * через MONITORING_RETENTION_DAYS — оператор может ужать (мелкая БД на VPS)
   * или расширить (compliance-окно для метрик).
   */
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
