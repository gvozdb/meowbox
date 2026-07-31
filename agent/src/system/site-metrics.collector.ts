import { CommandExecutor } from '../command-executor';
import * as fs from 'fs/promises';
import { TIMEOUTS } from '../config';
import { siteDomainLogBase } from '@meowbox/shared';
import {
  resolveSiteDomainRoot,
  validateRuntimeKey,
} from '../runtime/site-domain-runtime';

export interface SiteMetrics {
  cpuPercent: number;
  memoryBytes: number;
  diskBytes: number;
  requestCount: number;
  scope: 'domain';
  runtimeKey: string;
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
    siteDomainId: string;
    systemUser: string;
    rootPath: string;
    preset: string;
    phpVersion?: string | null;
    appPort?: number | null;
    domain: string;
    siteName: string;
    filesRelPath: string;
    runtimeKey: string;
  }): Promise<{ success: boolean; data?: SiteMetrics; error?: string }> {
    try {
      const runtimeKey = validateRuntimeKey(params.runtimeKey);
      const domainRoot = resolveSiteDomainRoot(
        params.rootPath,
        params.filesRelPath,
      );
      const [process, disk, requests] = await Promise.all([
        this.getProcessMetrics({ ...params, runtimeKey }),
        this.getDiskUsage(domainRoot),
        this.getRequestCount(params),
      ]);

      return {
        success: true,
        data: {
          cpuPercent: process.cpu,
          memoryBytes: process.mem,
          diskBytes: disk,
          requestCount: requests,
          scope: 'domain',
          runtimeKey,
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
    preset?: string;
    phpVersion?: string | null;
    appPort?: number | null;
    runtimeKey: string;
  }): Promise<{ cpu: number; mem: number }> {
    try {
      // Find processes belonging to the site user
      const result = await this.cmd.execute('ps', [
        '-u', params.systemUser,
        '-o', 'pcpu=,rss=,args=',
        '--no-headers',
      ], { timeout: 5000 });

      let totalCpu = 0;
      let totalMemKb = 0;

      for (const line of result.stdout.trim().split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          const command = parts.slice(2).join(' ');
          const poolName = params.runtimeKey.replace(/\./g, '_');
          const nodeName = `site-${params.runtimeKey}`;
          if (!command.includes(params.runtimeKey) && !command.includes(poolName) && !command.includes(nodeName)) {
            continue;
          }
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
    /** Web-root внутри homedir. Дефолт `www`. Может быть `www/public`. */
    filesRelPath?: string;
  }): Promise<{ success: boolean; data?: StorageBreakdown; error?: string }> {
    try {
      const webRoot = resolveSiteDomainRoot(params.rootPath, params.filesRelPath || 'www');
      // wwwBytes — занятое место под web-файлами (поле имени историческое:
      // metric называется "www", но сейчас может ссылаться на любой webRel).
      const sizes = await Promise.all([
        this.getDiskUsage(webRoot),
        this.getDiskUsage(`${params.rootPath}/logs`),
        this.getDiskUsage(`${params.rootPath}/tmp`),
      ]);
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
    /** Web-root внутри homedir. Дефолт `www`. */
    filesRelPath?: string;
  }): Promise<{ success: boolean; data?: TopFile[]; error?: string }> {
    const limit = params.limit || 20;
    try {
      const webRoot = resolveSiteDomainRoot(params.rootPath, params.filesRelPath || 'www');
      // du -S gives size of each directory excluding subdirs, but we want files only
      // Use du -ab and then filter out directories via fs.lstat on top candidates
      const result = await this.cmd.execute('du', [
        '-ab', '--max-depth=5', webRoot,
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
  private async getRequestCount(params: {
    siteName: string;
    domain: string;
  }): Promise<number> {
    const nginxLogDir = process.env.NGINX_LOG_DIR || '/var/log/nginx';
    const logPath =
      `${nginxLogDir}/${siteDomainLogBase(params)}-access.log`;
    try {
      await fs.access(logPath);
      const result = await this.cmd.execute(
        'wc',
        ['-l', logPath],
        { timeout: TIMEOUTS.METRICS_FAST },
      );
      const match = result.stdout.match(/^(\d+)/);
      if (match) return parseInt(match[1], 10);
    } catch {
      return 0;
    }
    return 0;
  }
}
