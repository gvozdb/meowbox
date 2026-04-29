import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PHP_LOG_DIR } from '../config';

const MAX_TAIL_SESSIONS = parseInt(process.env.LOG_TAIL_MAX_SESSIONS || '', 10) || 10;
const NGINX_LOG_DIR = process.env.NGINX_LOG_DIR || '/var/log/nginx';

/**
 * Allowlist директорий, в которых агент соглашается делать `tail -f`.
 * Собираем из конфигурации (чтобы альтернативный PHP_LOG_DIR работал) +
 * фиксированных системных путей. Пути нормализованы и оканчиваются на `/`,
 * чтобы `startsWith` не давал ложных срабатываний (например
 * `/var/log/nginx-evil/` не начинается с `/var/log/nginx/`).
 */
function buildAllowedPrefixes(): string[] {
  const pm2Home = process.env.PM2_HOME
    || (process.env.HOME ? path.join(process.env.HOME, '.pm2') : path.join(os.homedir() || '/root', '.pm2'));
  const raw = [
    path.resolve(NGINX_LOG_DIR),
    path.resolve(PHP_LOG_DIR),
    path.resolve(pm2Home, 'logs'),
  ];
  return raw.map((p) => (p.endsWith(path.sep) ? p : p + path.sep));
}

const ALLOWED_TAIL_PREFIXES = buildAllowedPrefixes();

interface TailSession {
  id: string;
  filePath: string;
  process: ChildProcess;
}

/**
 * Manages real-time tail -f sessions for log files.
 * Each session spawns a `tail -f` process and streams new lines via callback.
 */
export class LogTailManager {
  private sessions = new Map<string, TailSession>();

  startTail(
    id: string,
    filePath: string,
    onLine: (line: string) => void,
  ): { success: boolean; error?: string } {
    if (this.sessions.has(id)) {
      return { success: false, error: 'Tail session already exists' };
    }
    if (this.sessions.size >= MAX_TAIL_SESSIONS) {
      return { success: false, error: 'Maximum tail sessions reached' };
    }

    // Validate path — only allow known log directories.
    // Используем realpathSync, чтобы симлинки внутри log-директорий
    // (PM2 пишет логи как обычные файлы, но site-юзер может подсунуть
    // симлинк на /etc/shadow в свою logs-папку → tail прочитает что попало).
    let resolvedPath: string;
    try {
      resolvedPath = fs.realpathSync(filePath);
    } catch {
      return { success: false, error: 'Path does not exist or is not accessible' };
    }
    if (!this.isAllowedPath(resolvedPath)) {
      return { success: false, error: 'Path not allowed for tailing' };
    }

    const proc = spawn('tail', ['-f', '-n', '0', resolvedPath], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    let buffer = '';
    proc.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      // Keep last incomplete line in buffer
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line) onLine(line);
      }
    });

    proc.on('error', () => {
      this.sessions.delete(id);
    });

    proc.on('exit', () => {
      this.sessions.delete(id);
    });

    this.sessions.set(id, { id, filePath, process: proc });
    return { success: true };
  }

  stopTail(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;

    session.process.kill('SIGTERM');
    this.sessions.delete(id);
    return true;
  }

  stopAll(): void {
    for (const session of this.sessions.values()) {
      session.process.kill('SIGTERM');
    }
    this.sessions.clear();
  }

  hasSession(id: string): boolean {
    return this.sessions.has(id);
  }

  private isAllowedPath(filePath: string): boolean {
    // Резолвим, чтобы '..' не обошло allowlist.
    const abs = path.resolve(filePath);
    return ALLOWED_TAIL_PREFIXES.some((prefix) => abs.startsWith(prefix));
  }
}
