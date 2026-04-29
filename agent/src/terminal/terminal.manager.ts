import * as pty from 'node-pty';
import { randomBytes } from 'crypto';
import { TERMINAL } from '../config';

interface TerminalSession {
  id: string;
  pty: pty.IPty;
  createdAt: number;
}

// Лимиты теперь в agent/src/config.ts — чтобы admin мог крутить без пересборки.
const MAX_SESSIONS = TERMINAL.MAX_SESSIONS;
const SESSION_TIMEOUT_MS = TERMINAL.SESSION_TIMEOUT_MS;

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Periodic cleanup of stale sessions
    this.cleanupInterval = setInterval(
      () => this.cleanupStaleSessions(),
      TERMINAL.CLEANUP_INTERVAL_MS,
    );
  }

  /**
   * Spawn a new PTY session. Returns sessionId.
   * onData callback streams PTY output back to the caller.
   */
  open(
    onData: (sessionId: string, data: string) => void,
    cols = 80,
    rows = 24,
    user?: string,
  ): string {
    if (this.sessions.size >= MAX_SESSIONS) {
      // Evict oldest session
      const oldest = [...this.sessions.entries()].sort(
        (a, b) => a[1].createdAt - b[1].createdAt,
      )[0];
      if (oldest) {
        this.close(oldest[0]);
      }
    }

    const sessionId = randomBytes(16).toString('hex');

    // Валидируем user перед передачей в `su` — даже при execFile/spawn без
    // shell, сам su трактует `--` и `-c` как аргументы. Разрешаем только
    // стандартный Linux-username (POSIX NAME_REGEX).
    if (user !== undefined) {
      if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) {
        throw new Error('Invalid username for terminal session');
      }
    }

    // If a user is specified, spawn shell as that user via su
    const shell = user ? '/bin/su' : (process.env.SHELL || '/bin/bash');
    const args = user ? ['-', user] : [];

    // Env-whitelist: НЕ пробрасываем `...process.env` — агент крутится с
    // AGENT_SECRET, DB-паролями, токенами бэкапов и прочим секретным дерьмом
    // в окружении. Терминал-сессия (даже ADMIN'овская) не должна их видеть.
    // Берём только безопасные LANG/LC/PATH/TERM, остальное — ёбаным нахуй.
    const env = this.buildTerminalEnv(user);

    const term = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: user ? '/' : (process.env.HOME || '/'),
      env,
    });

    term.onData((data) => {
      onData(sessionId, data);
    });

    term.onExit(() => {
      this.sessions.delete(sessionId);
    });

    this.sessions.set(sessionId, {
      id: sessionId,
      pty: term,
      createdAt: Date.now(),
    });

    return sessionId;
  }

  /**
   * Write data (user input) to the PTY stdin.
   */
  write(sessionId: string, data: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.pty.write(data);
    return true;
  }

  /**
   * Resize the PTY window.
   */
  resize(sessionId: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.pty.resize(cols, rows);
    return true;
  }

  /**
   * Close and destroy a PTY session.
   */
  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    try {
      session.pty.kill();
    } catch {
      // Already exited
    }
    this.sessions.delete(sessionId);
  }

  /**
   * Close all sessions. Called on agent shutdown.
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    for (const [id] of this.sessions) {
      this.close(id);
    }
  }

  /**
   * Формируем минимальный env для PTY. Whitelist'уем только безопасные ключи.
   * При `user` — вообще не пробрасываем агентский HOME/USER, su выставит свои.
   * Динамически пропускаем LC_* (LC_ALL, LC_CTYPE, LC_COLLATE, …) — стандартная
   * Unix-локаль, без неё у юзера будут кракозябры в non-ASCII.
   */
  private buildTerminalEnv(user?: string): Record<string, string> {
    const allow = new Set([
      'PATH',
      'TERM',
      'LANG',
      'LANGUAGE',
      'TZ',
    ]);
    // Если su-шимся под юзера — su сам пересоберёт HOME/USER/LOGNAME/SHELL.
    // Если стартуем shell без user — оставляем HOME/SHELL/USER от процесса.
    if (!user) {
      allow.add('HOME');
      allow.add('SHELL');
      allow.add('USER');
      allow.add('LOGNAME');
    }

    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (allow.has(k) || k.startsWith('LC_')) {
        out[k] = v;
      }
    }
    // Гарантированные дефолты (если в процессе не было).
    if (!out.PATH) out.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
    out.TERM = 'xterm-256color';
    out.COLORTERM = 'truecolor';
    return out;
  }

  private cleanupStaleSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.createdAt > SESSION_TIMEOUT_MS) {
        console.log(`[Terminal] Cleaning up stale session: ${id}`);
        this.close(id);
      }
    }
  }
}
