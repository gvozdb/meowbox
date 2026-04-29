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
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  memoryUsagePercent: number;
  disks: DiskInfo[];
  network: NetworkInfo;
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
        return {
          mountPoint: parts[0],
          device: parts[1],
          totalBytes: parseInt(parts[2], 10) || 0,
          usedBytes: parseInt(parts[3], 10) || 0,
          availableBytes: parseInt(parts[4], 10) || 0,
          usagePercent: parseInt(parts[5], 10) || 0,
        };
      })
      .filter((d): d is DiskInfo => d !== null);
  }

  private async getNetworkTraffic(): Promise<NetworkInfo> {
    const result = await this.executor.execute('cat', ['/proc/net/dev']);
    if (result.exitCode !== 0) {
      return { rxBytes: 0, txBytes: 0, rxBytesPerSec: 0, txBytesPerSec: 0 };
    }

    let rxTotal = 0;
    let txTotal = 0;
    const lines = result.stdout.trim().split('\n').slice(2); // Skip headers

    for (const line of lines) {
      const parts = line.trim().split(/[\s:]+/);
      if (parts.length < 10) continue;
      const iface = parts[0];
      // Skip loopback
      if (iface === 'lo') continue;
      rxTotal += parseInt(parts[1], 10) || 0;
      txTotal += parseInt(parts[9], 10) || 0;
    }

    const now = Date.now();
    const elapsed = (now - this.lastNetworkTime) / 1000 || 1;

    const rxPerSec =
      this.lastNetworkTime > 0
        ? Math.max(0, (rxTotal - this.lastNetworkRx) / elapsed)
        : 0;
    const txPerSec =
      this.lastNetworkTime > 0
        ? Math.max(0, (txTotal - this.lastNetworkTx) / elapsed)
        : 0;

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
