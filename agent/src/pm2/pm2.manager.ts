import { CommandExecutor } from '../command-executor';

interface Pm2Process {
  name: string;
  pid: number;
  status: string;
  cpu: number;
  memory: number;
  uptime: number;
  restarts: number;
}

export class Pm2Manager {
  private executor: CommandExecutor;

  constructor() {
    this.executor = new CommandExecutor();
  }

  /**
   * Start a Node.js application with PM2.
   */
  async start(params: {
    name: string;
    cwd: string;
    script: string;
    env?: Record<string, string>;
    maxMemory?: string;
  }): Promise<{ success: boolean; error?: string }> {
    const args = [
      'start',
      params.script,
      '--name',
      params.name,
      '--cwd',
      params.cwd,
      '--max-memory-restart',
      params.maxMemory || '256M',
      '--no-autorestart',
    ];

    // Pass environment variables
    if (params.env) {
      for (const [key, value] of Object.entries(params.env)) {
        // Validate env key to prevent injection
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          return { success: false, error: `Invalid env variable name: ${key}` };
        }
        // Defense-in-depth: запрещаем NUL/CR/LF в значении. execFile
        // защищает от shell-injection, но \n в значении может быть
        // мис-парсен PM2 как разделитель аргументов или попасть в логи
        // в виде «лишних строк» (log injection).
        if (typeof value !== 'string' || /[\x00\r\n]/.test(value)) {
          return { success: false, error: `Invalid env variable value for ${key}` };
        }
        args.push('--env', `${key}=${value}`);
      }
    }

    const result = await this.executor.execute('pm2', args);
    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr };
    }

    // Save PM2 process list for auto-restart on reboot
    await this.executor.execute('pm2', ['save']);

    return { success: true };
  }

  /**
   * Stop a PM2 process.
   */
  async stop(name: string): Promise<{ success: boolean; error?: string }> {
    const result = await this.executor.execute('pm2', ['stop', name]);
    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr };
    }
    return { success: true };
  }

  /**
   * Restart a PM2 process.
   */
  async restart(name: string): Promise<{ success: boolean; error?: string }> {
    const result = await this.executor.execute('pm2', ['restart', name]);
    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr };
    }
    return { success: true };
  }

  /**
   * Reload a PM2 process (zero-downtime).
   */
  async reload(name: string): Promise<{ success: boolean; error?: string }> {
    const result = await this.executor.execute('pm2', ['reload', name]);
    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr };
    }
    return { success: true };
  }

  /**
   * Delete a PM2 process.
   */
  async delete(name: string): Promise<{ success: boolean; error?: string }> {
    const result = await this.executor.execute('pm2', ['delete', name]);
    await this.executor.execute('pm2', ['save']);
    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr };
    }
    return { success: true };
  }

  /**
   * Get status of a specific PM2 process.
   */
  async getProcess(name: string): Promise<Pm2Process | null> {
    const result = await this.executor.execute('pm2', ['jlist']);
    if (result.exitCode !== 0) return null;

    try {
      const processes = JSON.parse(result.stdout);
      const proc = processes.find(
        (p: { name: string }) => p.name === name,
      );

      if (!proc) return null;

      return {
        name: proc.name,
        pid: proc.pid,
        status: proc.pm2_env?.status || 'unknown',
        cpu: proc.monit?.cpu || 0,
        memory: proc.monit?.memory || 0,
        uptime: proc.pm2_env?.pm_uptime || 0,
        restarts: proc.pm2_env?.restart_time || 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get all PM2 processes.
   */
  async listProcesses(): Promise<Pm2Process[]> {
    const result = await this.executor.execute('pm2', ['jlist']);
    if (result.exitCode !== 0) return [];

    try {
      const processes = JSON.parse(result.stdout);
      return processes.map(
        (proc: {
          name: string;
          pid: number;
          monit?: { cpu?: number; memory?: number };
          pm2_env?: {
            status?: string;
            pm_uptime?: number;
            restart_time?: number;
          };
        }) => ({
          name: proc.name,
          pid: proc.pid,
          status: proc.pm2_env?.status || 'unknown',
          cpu: proc.monit?.cpu || 0,
          memory: proc.monit?.memory || 0,
          uptime: proc.pm2_env?.pm_uptime || 0,
          restarts: proc.pm2_env?.restart_time || 0,
        }),
      );
    } catch {
      return [];
    }
  }

  /**
   * Get logs for a PM2 process.
   */
  async getLogs(
    name: string,
    lines: number = 100,
  ): Promise<{ stdout: string; stderr: string }> {
    const outResult = await this.executor.execute('pm2', [
      'logs',
      name,
      '--lines',
      String(lines),
      '--nostream',
      '--raw',
    ]);
    return { stdout: outResult.stdout, stderr: outResult.stderr };
  }
}
