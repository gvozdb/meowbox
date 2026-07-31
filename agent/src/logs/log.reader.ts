import * as fs from 'fs/promises';
import * as path from 'path';
import { CommandExecutor } from '../command-executor';
import { siteDomainLogBase } from '@meowbox/shared';
import { PHP_LOG_DIR } from '../config';
import { validateRuntimeKey } from '../runtime/site-domain-runtime';

// Совместимо с log.tail.ts — обе подсистемы должны смотреть в одну директорию,
// иначе на нестандартных дистрибутивах (например, /var/log/nginx-extra) часть
// фич отвалится. Дефолт — стандартный путь Debian/Ubuntu.
const NGINX_LOG_DIR = process.env.NGINX_LOG_DIR || '/var/log/nginx';

export interface LogReadResult {
  type: string;
  path: string;
  lines: string[];
  totalLines: number;
}

export interface SystemLogSource {
  id: string;
  name: string;
  types: string[];
}

const SYSTEM_LOG_SOURCES: SystemLogSource[] = [
  { id: 'nginx', name: 'Nginx', types: ['access', 'error'] },
  { id: 'php-fpm', name: 'PHP-FPM', types: ['error'] },
  { id: 'mariadb', name: 'MariaDB', types: ['error'] },
  { id: 'postgresql', name: 'PostgreSQL', types: ['error'] },
  { id: 'redis', name: 'Redis', types: ['error'] },
];

/**
 * Reads site and system log files safely.
 */
export class LogReader {
  constructor(private readonly cmdExec: CommandExecutor) {}

  /**
   * Read the last N lines of a site log file.
   */
  async read(params: {
    siteDomainId: string;
    systemUser: string;
    domain: string;
    type: 'access' | 'error' | 'php' | 'app';
    siteName: string;
    runtimeKey: string;
    lines?: number;
  }): Promise<{ success: boolean; data?: LogReadResult; error?: string }> {
    const maxLines = Math.min(params.lines || 200, 1000);
    const logPaths = this.resolveLogPathCandidates(params);
    const logPath = await this.firstExistingPath(logPaths) || logPaths[0] || null;

    if (!logPath) {
      return { success: false, error: `Unknown log type: ${params.type}` };
    }

    try {
      await fs.access(logPath);
      const content = await fs.readFile(logPath, 'utf-8');
      const allLines = content.split('\n').filter(Boolean);
      const total = allLines.length;
      const tail = allLines.slice(-maxLines);

      return {
        success: true,
        data: {
          type: params.type,
          path: logPath,
          lines: tail,
          totalLines: total,
        },
      };
    } catch {
      return {
        success: true,
        data: {
          type: params.type,
          path: logPath,
          lines: [],
          totalLines: 0,
        },
      };
    }
  }

  /**
   * List available log files for a site.
   */
  async listAvailable(params: {
    siteDomainId: string;
    systemUser: string;
    domain: string;
    siteName: string;
    runtimeKey: string;
  }): Promise<{ success: boolean; data?: Array<{ type: string; path: string; sizeBytes: number }> }> {
    const types: Array<'access' | 'error' | 'php' | 'app'> = ['access', 'error', 'php', 'app'];
    const available: Array<{ type: string; path: string; sizeBytes: number }> = [];

    for (const type of types) {
      const logPath = await this.firstExistingPath(this.resolveLogPathCandidates({ ...params, type }));
      if (!logPath) continue;

      try {
        const stat = await fs.stat(logPath);
        available.push({
          type,
          path: logPath,
          sizeBytes: stat.size,
        });
      } catch {
        // File doesn't exist — skip
      }
    }

    return { success: true, data: available };
  }

  /**
   * Read system service logs via journalctl or log files.
   */
  async readSystemLog(params: {
    service: string;
    type: string;
    lines?: number;
  }): Promise<{ success: boolean; data?: LogReadResult; error?: string }> {
    const maxLines = Math.min(params.lines || 200, 1000);
    const source = SYSTEM_LOG_SOURCES.find(s => s.id === params.service);
    if (!source) {
      return { success: false, error: `Unknown system service: ${params.service}` };
    }
    if (!source.types.includes(params.type)) {
      return { success: false, error: `Log type '${params.type}' not available for ${params.service}` };
    }

    // Nginx global logs — read from files directly
    if (params.service === 'nginx') {
      const logPath = params.type === 'access'
        ? path.join(NGINX_LOG_DIR, 'access.log')
        : path.join(NGINX_LOG_DIR, 'error.log');
      return this.readLogFile(logPath, params.type, maxLines);
    }

    // Other services — use journalctl
    const unitName = this.resolveSystemdUnit(params.service);
    if (!unitName) {
      return { success: false, error: `Cannot resolve systemd unit for: ${params.service}` };
    }

    try {
      const result = await this.cmdExec.execute('journalctl', [
        '-u', unitName,
        '-n', String(maxLines),
        '--no-pager',
        '-o', 'short-iso',
      ]);

      const lines = result.stdout.split('\n').filter(Boolean);
      return {
        success: true,
        data: {
          type: params.type,
          path: `journalctl -u ${unitName}`,
          lines,
          totalLines: lines.length,
        },
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Get list of available system log sources.
   */
  getSystemSources(): SystemLogSource[] {
    return SYSTEM_LOG_SOURCES;
  }

  resolveLogPath(params: {
    domain: string;
    type: string;
    siteName: string;
    runtimeKey: string;
  }): string | null {
    return this.resolveLogPathCandidates(params)[0] || null;
  }

  private resolveLogPathCandidates(params: {
    domain: string;
    type: string;
    siteName: string;
    runtimeKey: string;
  }): string[] {
    switch (params.type) {
      case 'access':
        return this.nginxLogCandidates(params, 'access');
      case 'error':
        return this.nginxLogCandidates(params, 'error');
      case 'php':
        return this.phpLogCandidates(params);
      case 'app':
        return this.appLogCandidates(params);
      default:
        return [];
    }
  }

  private nginxLogCandidates(
    params: { domain: string; siteName: string },
    type: 'access' | 'error',
  ): string[] {
    const base = siteDomainLogBase(params);
    return [path.join(NGINX_LOG_DIR, `${base}-${type}.log`)];
  }

  private phpLogCandidates(params: { runtimeKey: string }): string[] {
    const runtimeKey = validateRuntimeKey(params.runtimeKey);
    return [path.join(PHP_LOG_DIR, `${runtimeKey}-error.log`)];
  }

  private appLogCandidates(params: { runtimeKey: string }): string[] {
    const pm2Dir = `${process.env.HOME || '/root'}/.pm2/logs`;
    const runtimeKey = validateRuntimeKey(params.runtimeKey);
    return [path.join(pm2Dir, `site-${runtimeKey}-out.log`)];
  }

  private async firstExistingPath(paths: string[]): Promise<string | null> {
    for (const file of paths) {
      try {
        await fs.access(file);
        return file;
      } catch {
        // Try next domain-owned candidate.
      }
    }
    return null;
  }

  private async readLogFile(
    logPath: string,
    type: string,
    maxLines: number,
  ): Promise<{ success: boolean; data?: LogReadResult; error?: string }> {
    try {
      await fs.access(logPath);
      const content = await fs.readFile(logPath, 'utf-8');
      const allLines = content.split('\n').filter(Boolean);
      const total = allLines.length;
      const tail = allLines.slice(-maxLines);
      return {
        success: true,
        data: { type, path: logPath, lines: tail, totalLines: total },
      };
    } catch {
      return {
        success: true,
        data: { type, path: logPath, lines: [], totalLines: 0 },
      };
    }
  }

  private resolveSystemdUnit(service: string): string | null {
    switch (service) {
      case 'php-fpm': return 'php*-fpm';
      case 'mariadb': return 'mariadb';
      case 'postgresql': return 'postgresql';
      case 'redis': return 'redis-server';
      default: return null;
    }
  }
}
