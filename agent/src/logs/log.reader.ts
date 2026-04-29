import * as fs from 'fs/promises';
import * as path from 'path';
import { CommandExecutor } from '../command-executor';
import { artifactAnchor } from '@meowbox/shared';

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
    systemUser: string;
    domain: string;
    type: 'access' | 'error' | 'php' | 'app';
    siteName?: string;
    lines?: number;
  }): Promise<{ success: boolean; data?: LogReadResult; error?: string }> {
    const maxLines = Math.min(params.lines || 200, 1000);
    const logPath = this.resolveLogPath(params);

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
    systemUser: string;
    domain: string;
    siteName?: string;
  }): Promise<{ success: boolean; data?: Array<{ type: string; path: string; sizeBytes: number }> }> {
    const types: Array<'access' | 'error' | 'php' | 'app'> = ['access', 'error', 'php', 'app'];
    const available: Array<{ type: string; path: string; sizeBytes: number }> = [];

    for (const type of types) {
      const logPath = this.resolveLogPath({ ...params, type });
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

  /**
   * Resolve the path to a site log file.
   * Пути к логам якорятся на `siteName` (Site.name = Linux-юзер) если он
   * передан — новая схема. Fallback на `domain` — для сайтов, которые ещё
   * не мигрировали на новую схему именования артефактов.
   */
  resolveLogPath(params: {
    domain: string;
    type: string;
    siteName?: string;
    systemUser?: string;
  }): string | null {
    const anchor = artifactAnchor({ siteName: params.siteName, domain: params.domain });
    switch (params.type) {
      case 'access':
        return `/var/log/nginx/${anchor}-access.log`;
      case 'error':
        return `/var/log/nginx/${anchor}-error.log`;
      case 'php':
        return `/var/log/php/${anchor}-error.log`;
      case 'app':
        if (params.siteName) {
          return `${process.env.HOME || '/root'}/.pm2/logs/${params.siteName}-out.log`;
        }
        return null;
      default:
        return null;
    }
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
