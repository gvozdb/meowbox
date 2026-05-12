import { CommandExecutor } from '../command-executor';

/**
 * SSH executor — управление демоном OpenSSH (`openssh-server`).
 *
 * Сервис системный: на любом Ubuntu/Debian openssh-server установлен из коробки
 * (иначе мы бы не смогли зайти и поставить панель). Поэтому:
 *   - `install` — идемпотентен (apt install -y openssh-server), но обычно
 *     просто проверяет, что пакет есть.
 *   - `uninstall` запрещён на уровне catalog/API — сюда не дойдёт. Если дойдёт
 *     каким-то багом — бросаем ошибку.
 *
 * Редактирование `sshd_config` живёт в server-config.executor.ts с pre-validation
 * через `sshd -t -f` — критично, ошибка может убить SSH-доступ.
 */
export interface ServerStatus {
  installed: boolean;
  version: string | null;
}

export class SshExecutor {
  constructor(private readonly cmd: CommandExecutor) {}

  async serverStatus(): Promise<ServerStatus> {
    // dpkg-query exit=1 если пакет отсутствует — это валидный сценарий.
    const r = await this.cmd.execute('dpkg-query', ['-s', 'openssh-server'], { allowFailure: true });
    if (r.exitCode !== 0 || !r.stdout) return { installed: false, version: null };
    const status = /^Status:\s*(.+)$/m.exec(r.stdout)?.[1]?.trim() || '';
    if (!/install ok installed/.test(status)) return { installed: false, version: null };
    const version = /^Version:\s*(.+)$/m.exec(r.stdout)?.[1]?.trim() || null;
    return { installed: true, version };
  }

  async serverInstall(): Promise<{ version: string }> {
    // Идемпотентно — apt-get не пересоздаёт пакет, если он уже стоит.
    const update = await this.cmd.execute(
      'apt-get',
      ['-o', 'Acquire::Retries=3', 'update'],
      { timeout: 180_000, env: { DEBIAN_FRONTEND: 'noninteractive' }, allowFailure: true },
    );
    if (update.exitCode !== 0) {
      throw new Error(`apt-get update failed: ${update.stderr || update.stdout}`);
    }
    const install = await this.cmd.execute(
      'apt-get',
      ['install', '-y', '--no-install-recommends', 'openssh-server'],
      { timeout: 600_000, env: { DEBIAN_FRONTEND: 'noninteractive' }, allowFailure: true },
    );
    if (install.exitCode !== 0) {
      throw new Error(`apt-get install openssh-server failed: ${install.stderr || install.stdout}`);
    }
    await this.cmd.execute('systemctl', ['enable', '--now', 'ssh.service'], { allowFailure: true })
      .catch(() => {});
    const status = await this.serverStatus();
    if (!status.installed) throw new Error('openssh-server не установился (dpkg-query != installed)');
    return { version: status.version || 'unknown' };
  }
}
