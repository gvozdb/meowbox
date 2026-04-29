import { CommandExecutor } from '../command-executor';
import * as fs from 'fs/promises';
import { TIMEOUTS, SITES_BASE_PATH } from '../config';

export interface SiteMetrics {
  cpuPercent: number;
  memoryBytes: number;
  diskBytes: number;
  requestCount: number;
}

export interface StorageBreakdown {
  wwwBytes: number;
  logsBytes: number;
  tmpBytes: number;
  totalBytes: number;
}

export interface TopFile {
  size: number;
  path: string;
}

export interface ServerDisk {
  total: number;
  used: number;
  percent: number;
}

export class SiteMetricsCollector {
  constructor(private readonly cmd: CommandExecutor) {}

  /**
   * Collect per-site metrics: CPU, memory (from PHP-FPM pool or PM2 process),
   * disk usage, and request count from nginx access log.
   */
  async collect(params: {
    systemUser: string;
    rootPath: string;
    siteType: string;
    phpVersion?: string;
    appPort?: number;
    domain: string;
  }): Promise<{ success: boolean; data?: SiteMetrics; error?: string }> {
    try {
      const [process, disk, requests] = await Promise.all([
        this.getProcessMetrics(params),
        this.getDiskUsage(params.rootPath),
        this.getRequestCount(params.systemUser),
      ]);

      return {
        success: true,
        data: {
          cpuPercent: process.cpu,
          memoryBytes: process.mem,
          diskBytes: disk,
          requestCount: requests,
        },
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Get CPU and memory usage for the site's processes.
   * For PHP sites: measure the PHP-FPM pool processes.
   * For Node.js sites: measure PM2-managed processes.
   */
  private async getProcessMetrics(params: {
    systemUser: string;
    siteType: string;
    phpVersion?: string;
    appPort?: number;
  }): Promise<{ cpu: number; mem: number }> {
    try {
      // Find processes belonging to the site user
      const result = await this.cmd.execute('ps', [
        '-u', params.systemUser,
        '-o', 'pcpu=,rss=',
        '--no-headers',
      ], { timeout: 5000 });

      let totalCpu = 0;
      let totalMemKb = 0;

      for (const line of result.stdout.trim().split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          totalCpu += parseFloat(parts[0]) || 0;
          totalMemKb += parseInt(parts[1], 10) || 0;
        }
      }

      return {
        cpu: Math.round(totalCpu * 10) / 10,
        mem: totalMemKb * 1024, // Convert KB to bytes
      };
    } catch {
      return { cpu: 0, mem: 0 };
    }
  }

  /**
   * Get disk usage for the site directory.
   */
  private async getDiskUsage(rootPath: string): Promise<number> {
    try {
      const result = await this.cmd.execute('du', ['-sb', rootPath], { timeout: TIMEOUTS.METRICS });
      const match = result.stdout.match(/^(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    } catch {
      return 0;
    }
  }

  async getStorageBreakdown(params: {
    rootPath: string;
  }): Promise<{ success: boolean; data?: StorageBreakdown; error?: string }> {
    try {
      const dirs = ['www', 'logs', 'tmp'];
      const sizes = await Promise.all(
        dirs.map((d) => this.getDiskUsage(`${params.rootPath}/${d}`)),
      );
      const [wwwBytes, logsBytes, tmpBytes] = sizes;
      return {
        success: true,
        data: { wwwBytes, logsBytes, tmpBytes, totalBytes: wwwBytes + logsBytes + tmpBytes },
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async getTopFiles(params: {
    rootPath: string;
    limit?: number;
  }): Promise<{ success: boolean; data?: TopFile[]; error?: string }> {
    const limit = params.limit || 20;
    try {
      // du -S gives size of each directory excluding subdirs, but we want files only
      // Use du -ab and then filter out directories via fs.lstat on top candidates
      const result = await this.cmd.execute('du', [
        '-ab', '--max-depth=5', `${params.rootPath}/www`,
      ], { timeout: TIMEOUTS.SHORT });

      const entries: { size: number; absPath: string; relPath: string }[] = [];
      for (const line of result.stdout.trim().split('\n')) {
        const match = line.match(/^(\d+)\t(.+)$/);
        if (!match) continue;
        const size = parseInt(match[1], 10);
        const absPath = match[2];
        if (size === 0) continue;
        entries.push({ size, absPath, relPath: absPath.replace(`${params.rootPath}/`, '') });
      }

      // Sort desc, take top candidates (3x limit to account for dirs)
      entries.sort((a, b) => b.size - a.size);
      const candidates = entries.slice(0, limit * 3);

      // Filter to files only
      const files: TopFile[] = [];
      for (const entry of candidates) {
        if (files.length >= limit) break;
        try {
          const stat = await fs.lstat(entry.absPath);
          if (stat.isFile()) {
            files.push({ size: entry.size, path: entry.relPath });
          }
        } catch {
          // Skip inaccessible entries
        }
      }

      return { success: true, data: files };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async getServerDiskUsage(): Promise<{ success: boolean; data?: ServerDisk; error?: string }> {
    try {
      const result = await this.cmd.execute('df', ['-B1', '/'], { timeout: 5000 });
      const lines = result.stdout.trim().split('\n');
      if (lines.length < 2) return { success: false, error: 'df returned no data' };
      const parts = lines[1].split(/\s+/);
      const total = parseInt(parts[1], 10) || 0;
      const used = parseInt(parts[2], 10) || 0;
      const percent = total > 0 ? Math.round((used / total) * 100) : 0;
      return { success: true, data: { total, used, percent } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Get request count from nginx access log for the site.
   * Reads the site-specific access log.
   */
  private async getRequestCount(systemUser: string): Promise<number> {
    // Access log: {SITES_BASE_PATH}/{systemUser}/logs/access.log
    const logPath = `${SITES_BASE_PATH}/${systemUser}/logs/access.log`;
    try {
      await fs.access(logPath);
      // Count lines in the access log (each line = 1 request)
      const result = await this.cmd.execute('wc', ['-l', logPath], { timeout: TIMEOUTS.METRICS_FAST });
      const match = result.stdout.match(/^(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    } catch {
      return 0;
    }
  }
}
