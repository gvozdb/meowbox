import * as os from 'os';
import { CommandExecutor } from '../command-executor';

interface DiskInfo {
  mountPoint: string;
  device: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usagePercent: number;
}

interface NetworkInfo {
  rxBytes: number;
  txBytes: number;
  rxBytesPerSec: number;
  txBytesPerSec: number;
}

export interface SystemMetricsData {
  cpuUsagePercent: number;
  cpuCores: number;
  hostname: string;
  loadAverage: [number, number, number];
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  memoryUsagePercent: number;
  disks: DiskInfo[];
  network: NetworkInfo | null;
  uptimeSeconds: number;
  collectedAt: string;
}

export class MetricsCollector {
  private executor: CommandExecutor;
  private lastNetworkRx = 0;
  private lastNetworkTx = 0;
  private lastNetworkTime = 0;
  private lastCpuIdle = 0;
  private lastCpuTotal = 0;

  constructor() {
    this.executor = new CommandExecutor();
    this.initCpuSnapshot();
  }

  private initCpuSnapshot() {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;
    for (const cpu of cpus) {
      idle += cpu.times.idle;
      total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
    }
    this.lastCpuIdle = idle;
    this.lastCpuTotal = total;
  }

  /**
   * Collect all system metrics. Lightweight — uses OS module and /proc.
   */
  async collect(): Promise<SystemMetricsData> {
    const [cpuUsagePercent, disks, network] = await Promise.all([
      this.getCpuUsage(),
      this.getDiskUsage(),
      this.getNetworkTraffic(),
    ]);

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    return {
      cpuUsagePercent,
      cpuCores: os.cpus().length,
      hostname: os.hostname(),
      loadAverage: os.loadavg() as [number, number, number],
      memoryTotalBytes: totalMem,
      memoryUsedBytes: usedMem,
      memoryUsagePercent: Math.round((usedMem / totalMem) * 100 * 10) / 10,
      disks,
      network,
      uptimeSeconds: Math.floor(os.uptime()),
      collectedAt: new Date().toISOString(),
    };
  }

  private getCpuUsage(): number {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;
    for (const cpu of cpus) {
      idle += cpu.times.idle;
      total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
    }

    const idleDiff = idle - this.lastCpuIdle;
    const totalDiff = total - this.lastCpuTotal;

    this.lastCpuIdle = idle;
    this.lastCpuTotal = total;

    if (totalDiff === 0) return 0;
    return Math.round((1 - idleDiff / totalDiff) * 100 * 10) / 10;
  }

  private async getDiskUsage(): Promise<DiskInfo[]> {
    const result = await this.executor.execute('df', [
      '-B1',
      '--output=target,source,size,used,avail,pcent',
      '-x',
      'tmpfs',
      '-x',
      'devtmpfs',
      '-x',
      'overlay',
    ]);

    if (result.exitCode !== 0) return [];

    const lines = result.stdout.trim().split('\n').slice(1); // Skip header
    return lines
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 6) return null;
        const totalBytes = Number.parseInt(parts[2], 10);
        const usedBytes = Number.parseInt(parts[3], 10);
        const availableBytes = Number.parseInt(parts[4], 10);
        const usagePercent = Number.parseInt(parts[5], 10);
        if (
          !Number.isFinite(totalBytes) || totalBytes <= 0 ||
          !Number.isFinite(usedBytes) || usedBytes < 0 ||
          !Number.isFinite(availableBytes) || availableBytes < 0 ||
          !Number.isFinite(usagePercent) || usagePercent < 0 || usagePercent > 100
        ) return null;
        return {
          mountPoint: parts[0],
          device: parts[1],
          totalBytes,
          usedBytes,
          availableBytes,
          usagePercent,
        };
      })
      .filter((d): d is DiskInfo => d !== null);
  }

  private async getNetworkTraffic(): Promise<NetworkInfo | null> {
    const result = await this.executor.execute('cat', ['/proc/net/dev']);
    if (result.exitCode !== 0) return null;

    let rxTotal = 0;
    let txTotal = 0;
    let interfaceCount = 0;
    const lines = result.stdout.trim().split('\n').slice(2); // Skip headers

    for (const line of lines) {
      const parts = line.trim().split(/[\s:]+/);
      if (parts.length < 10) continue;
      const iface = parts[0];
      // Skip loopback
      if (iface === 'lo') continue;
      const rxBytes = Number.parseInt(parts[1], 10);
      const txBytes = Number.parseInt(parts[9], 10);
      if (!Number.isFinite(rxBytes) || rxBytes < 0 || !Number.isFinite(txBytes) || txBytes < 0) {
        continue;
      }
      rxTotal += rxBytes;
      txTotal += txBytes;
      interfaceCount += 1;
    }
    if (interfaceCount === 0) return null;

    const now = Date.now();
    if (this.lastNetworkTime === 0) {
      this.lastNetworkRx = rxTotal;
      this.lastNetworkTx = txTotal;
      this.lastNetworkTime = now;
      return null;
    }
    if (rxTotal < this.lastNetworkRx || txTotal < this.lastNetworkTx) {
      this.lastNetworkRx = rxTotal;
      this.lastNetworkTx = txTotal;
      this.lastNetworkTime = now;
      return null;
    }
    const elapsed = (now - this.lastNetworkTime) / 1000;
    if (!Number.isFinite(elapsed) || elapsed <= 0) return null;

    const rxPerSec = Math.max(0, (rxTotal - this.lastNetworkRx) / elapsed);
    const txPerSec = Math.max(0, (txTotal - this.lastNetworkTx) / elapsed);

    this.lastNetworkRx = rxTotal;
    this.lastNetworkTx = txTotal;
    this.lastNetworkTime = now;

    return {
      rxBytes: rxTotal,
      txBytes: txTotal,
      rxBytesPerSec: Math.round(rxPerSec),
      txBytesPerSec: Math.round(txPerSec),
    };
  }
}
