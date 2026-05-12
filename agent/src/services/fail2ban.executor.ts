import { promises as fs } from 'fs';
import * as path from 'path';
import { CommandExecutor } from '../command-executor';

/**
 * Fail2ban executor.
 *
 * Архитектура:
 *   - apt-пакет `fail2ban` ставит /etc/fail2ban/jail.conf (read-only апстрим).
 *   - Пользовательский override живёт в /etc/fail2ban/jail.local
 *     (его читает фай2бан поверх jail.conf — стандартный механизм).
 *   - **Пресеты панели** живут отдельно — в /etc/fail2ban/jail.d/meowbox.local.
 *     Это позволяет:
 *       - не конфликтовать с ручными правками юзера в jail.local;
 *       - перегенерировать пресеты атомарно (один файл);
 *       - явно показать в UI «вот этот блок управляется панелью».
 *
 * Пресеты — список jail-секций, которые юзер выбирает чекбоксами.
 * Apply пересобирает meowbox.local с нуля по выбранным ключам + restart демона.
 */

const PRESETS_PATH = '/etc/fail2ban/jail.d/meowbox.local';
const PRESETS_MARK = '# meowbox-managed: do not edit — overwritten on /services apply';

export interface ServerStatus {
  installed: boolean;
  version: string | null;
}

export interface PresetDefinition {
  key: string;
  name: string;
  description: string;
  /** INI-секция для записи в jail.d/meowbox.local (без `[]` — добавим сами). */
  section: string;
  /** Тело секции в виде «ключ = значение» построчно. */
  body: Record<string, string>;
}

export interface PresetState {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
}

export interface Defaults {
  bantime: string;   // например '1h', '10m', '1d'
  findtime: string;
  maxretry: string;  // число как строка
}

const DEFAULT_DEFAULTS: Defaults = {
  bantime: '1h',
  findtime: '10m',
  maxretry: '5',
};

/**
 * Реестр пресетов. Только sane defaults, всё критичное (logpath, filter) явно
 * задано — чтобы не зависеть от наличия `paths-common.conf` в данной версии
 * fail2ban (на старых Debian пути отличаются).
 *
 * NB: каждый пресет требует наличия соответствующего фильтра в /etc/fail2ban/filter.d/
 * — все они идут в комплекте с пакетом fail2ban, кастомного нам ставить не надо.
 */
export const FAIL2BAN_PRESETS: readonly PresetDefinition[] = [
  {
    key: 'sshd',
    name: 'SSH (sshd)',
    description: 'Брутфорс SSH — банит IP после N неудачных входов в /var/log/auth.log',
    section: 'sshd',
    body: {
      enabled: 'true',
      port: 'ssh',
      filter: 'sshd',
      logpath: '/var/log/auth.log',
      backend: 'auto',
    },
  },
  {
    key: 'nginx-http-auth',
    name: 'Nginx HTTP Auth (401)',
    description: 'Брутфорс basic auth — банит по 401 в access.log nginx',
    section: 'nginx-http-auth',
    body: {
      enabled: 'true',
      filter: 'nginx-http-auth',
      port: 'http,https',
      logpath: '/var/log/nginx/*error.log',
    },
  },
  {
    key: 'nginx-limit-req',
    name: 'Nginx Rate Limit',
    description: 'Превышение nginx limit_req — банит DDoS-like клиентов',
    section: 'nginx-limit-req',
    body: {
      enabled: 'true',
      filter: 'nginx-limit-req',
      port: 'http,https',
      logpath: '/var/log/nginx/*error.log',
    },
  },
  {
    key: 'nginx-botsearch',
    name: 'Nginx Bot Search',
    description: 'Сканеры уязвимостей (wp-admin, /.env, phpmyadmin)',
    section: 'nginx-botsearch',
    body: {
      enabled: 'true',
      filter: 'nginx-botsearch',
      port: 'http,https',
      logpath: '/var/log/nginx/*access.log',
    },
  },
  {
    key: 'nginx-badbots',
    name: 'Nginx Bad Bots',
    description: 'Известные вредные user-agent (по filter.d/nginx-badbots)',
    section: 'nginx-badbots',
    body: {
      enabled: 'true',
      filter: 'nginx-badbots',
      port: 'http,https',
      logpath: '/var/log/nginx/*access.log',
      maxretry: '2',
    },
  },
  {
    key: 'recidive',
    name: 'Recidive (повторные)',
    description: 'Долгий бан (1 неделя) для тех, кого уже банили — читает fail2ban.log',
    section: 'recidive',
    body: {
      enabled: 'true',
      filter: 'recidive',
      logpath: '/var/log/fail2ban.log',
      action: '%(action_)s',
      bantime: '1w',
      findtime: '1d',
      maxretry: '5',
    },
  },
] as const;

export class Fail2banExecutor {
  constructor(private readonly cmd: CommandExecutor) {}

  // =====================================================================
  // Server level
  // =====================================================================

  async serverStatus(): Promise<ServerStatus> {
    const r = await this.cmd.execute('dpkg-query', ['-s', 'fail2ban'], { allowFailure: true });
    if (r.exitCode !== 0 || !r.stdout) return { installed: false, version: null };
    const status = /^Status:\s*(.+)$/m.exec(r.stdout)?.[1]?.trim() || '';
    if (!/install ok installed/.test(status)) return { installed: false, version: null };
    const version = /^Version:\s*(.+)$/m.exec(r.stdout)?.[1]?.trim() || null;
    return { installed: true, version };
  }

  async serverInstall(): Promise<{ version: string }> {
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
      ['install', '-y', '--no-install-recommends', 'fail2ban'],
      { timeout: 600_000, env: { DEBIAN_FRONTEND: 'noninteractive' }, allowFailure: true },
    );
    if (install.exitCode !== 0) {
      throw new Error(`apt-get install fail2ban failed: ${install.stderr || install.stdout}`);
    }
    await this.cmd.execute('systemctl', ['enable', '--now', 'fail2ban.service'], { allowFailure: true })
      .catch(() => {});
    const status = await this.serverStatus();
    if (!status.installed) throw new Error('fail2ban не установился (dpkg-query != installed)');
    return { version: status.version || 'unknown' };
  }

  async serverUninstall(): Promise<void> {
    await this.cmd.execute('systemctl', ['disable', '--now', 'fail2ban.service'], { allowFailure: true })
      .catch(() => {});
    // Удаляем наш файл пресетов — чтобы при повторной установке начать с нуля.
    await fs.unlink(PRESETS_PATH).catch(() => {});
    const r = await this.cmd.execute(
      'apt-get',
      ['purge', '-y', 'fail2ban'],
      { timeout: 300_000, env: { DEBIAN_FRONTEND: 'noninteractive' }, allowFailure: true },
    );
    if (r.exitCode !== 0) {
      throw new Error(`apt-get purge fail2ban failed: ${r.stderr || r.stdout}`);
    }
  }

  // =====================================================================
  // Presets
  // =====================================================================

  /** Текущее состояние пресетов: какие включены, текущие DEFAULT-параметры. */
  async getPresetsState(): Promise<{ presets: PresetState[]; defaults: Defaults; managedFilePath: string; managedFileExists: boolean }> {
    const enabled = await this.readEnabledKeys();
    const defaults = await this.readDefaults();
    const managedFileExists = await fs.access(PRESETS_PATH).then(() => true).catch(() => false);
    return {
      managedFilePath: PRESETS_PATH,
      managedFileExists,
      defaults,
      presets: FAIL2BAN_PRESETS.map((p) => ({
        key: p.key,
        name: p.name,
        description: p.description,
        enabled: enabled.has(p.section),
      })),
    };
  }

  /**
   * Применить выбранные пресеты: перезаписать meowbox.local + рестарт.
   * Atomic: пишем в tmp → rename. Перед рестартом проверяем валидность
   * через `fail2ban-client -d -c /etc/fail2ban` (но т.к. fail2ban-client читает
   * всю директорию, проще сделать post-restart rollback при падении).
   */
  async applyPresets(enabledKeys: string[], defaults?: Partial<Defaults>): Promise<{ path: string; restart: { unit: string; ok: boolean; output: string } }> {
    const finalDefaults: Defaults = {
      bantime: this.sanitizeIniValue(defaults?.bantime) || DEFAULT_DEFAULTS.bantime,
      findtime: this.sanitizeIniValue(defaults?.findtime) || DEFAULT_DEFAULTS.findtime,
      maxretry: this.sanitizeIniValue(defaults?.maxretry) || DEFAULT_DEFAULTS.maxretry,
    };
    // Фильтруем только известные пресеты — игнорим мусор от клиента.
    const allowed = new Set(FAIL2BAN_PRESETS.map((p) => p.key));
    const selected = FAIL2BAN_PRESETS.filter((p) => allowed.has(p.key) && enabledKeys.includes(p.key));

    const content = this.renderPresetsFile(selected, finalDefaults);

    // Бэкап текущего файла, если есть.
    let backupPath = '';
    if (await fs.access(PRESETS_PATH).then(() => true).catch(() => false)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      backupPath = `${PRESETS_PATH}.meowbox.bak.${ts}`;
      await fs.copyFile(PRESETS_PATH, backupPath).catch(() => { backupPath = ''; });
    }

    // Atomic write
    await fs.mkdir(path.dirname(PRESETS_PATH), { recursive: true }).catch(() => {});
    const tmp = `${PRESETS_PATH}.meowbox.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmp, content, { encoding: 'utf-8', mode: 0o644 });
    await fs.chmod(tmp, 0o644).catch(() => {});
    await fs.rename(tmp, PRESETS_PATH);

    // Restart — если падает, откатываем из бэкапа (или удаляем, если бэкапа не было).
    const r = await this.cmd.execute('systemctl', ['restart', 'fail2ban.service'], {
      timeout: 60_000,
      allowFailure: true,
    });
    if (r.exitCode !== 0) {
      // Rollback
      if (backupPath) {
        await fs.copyFile(backupPath, PRESETS_PATH).catch(() => {});
      } else {
        await fs.unlink(PRESETS_PATH).catch(() => {});
      }
      // Снова рестарт — чтобы вернуть демон в рабочее состояние.
      await this.cmd.execute('systemctl', ['restart', 'fail2ban.service'], {
        timeout: 60_000,
        allowFailure: true,
      }).catch(() => {});
      const status = await this.cmd.execute('systemctl', ['status', 'fail2ban.service', '--no-pager', '--lines=30'], {
        timeout: 15_000,
        allowFailure: true,
      });
      throw new Error(
        `systemctl restart fail2ban failed (exit ${r.exitCode}), пресеты откатили. ` +
        `stderr: ${r.stderr.trim()}\n--- status ---\n${status.stdout}`,
      );
    }

    return {
      path: PRESETS_PATH,
      restart: { unit: 'fail2ban.service', ok: true, output: r.stdout || r.stderr || '' },
    };
  }

  /**
   * Рендер meowbox.local. Строгий формат, без user-input в местах, где это
   * может сломать INI (sanitize применяется к defaults).
   */
  private renderPresetsFile(selected: readonly PresetDefinition[], defaults: Defaults): string {
    const lines: string[] = [];
    lines.push(PRESETS_MARK);
    lines.push(`# Generated by meowbox panel at ${new Date().toISOString()}`);
    lines.push('');
    lines.push('[DEFAULT]');
    lines.push(`bantime = ${defaults.bantime}`);
    lines.push(`findtime = ${defaults.findtime}`);
    lines.push(`maxretry = ${defaults.maxretry}`);
    lines.push('');
    for (const p of selected) {
      lines.push(`[${p.section}]`);
      for (const [k, v] of Object.entries(p.body)) {
        lines.push(`${k} = ${v}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  /** Парсит meowbox.local — возвращает множество секций где enabled=true. */
  private async readEnabledKeys(): Promise<Set<string>> {
    const out = new Set<string>();
    const buf = await fs.readFile(PRESETS_PATH, 'utf-8').catch(() => '');
    if (!buf) return out;
    let currentSection: string | null = null;
    for (const raw of buf.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      const sec = /^\[([^\]]+)\]$/.exec(line);
      if (sec) {
        currentSection = sec[1].trim();
        continue;
      }
      if (!currentSection || currentSection === 'DEFAULT') continue;
      const kv = /^(\w[\w.-]*)\s*=\s*(.+?)$/.exec(line);
      if (!kv) continue;
      if (kv[1].toLowerCase() === 'enabled' && /^true$/i.test(kv[2].trim())) {
        out.add(currentSection);
      }
    }
    return out;
  }

  private async readDefaults(): Promise<Defaults> {
    const buf = await fs.readFile(PRESETS_PATH, 'utf-8').catch(() => '');
    const out: Defaults = { ...DEFAULT_DEFAULTS };
    if (!buf) return out;
    let inDefault = false;
    for (const raw of buf.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      const sec = /^\[([^\]]+)\]$/.exec(line);
      if (sec) {
        inDefault = sec[1].trim() === 'DEFAULT';
        continue;
      }
      if (!inDefault) continue;
      const kv = /^(\w[\w.-]*)\s*=\s*(.+?)$/.exec(line);
      if (!kv) continue;
      const k = kv[1].toLowerCase();
      const v = kv[2].trim();
      if (k === 'bantime') out.bantime = v;
      else if (k === 'findtime') out.findtime = v;
      else if (k === 'maxretry') out.maxretry = v;
    }
    return out;
  }

  /**
   * Sanitize: разрешаем только то, что валидно как fail2ban-time / число.
   * `1h`, `10m`, `1d`, `1w`, `3600`. Запрещаем переводы строк, кавычки, секционные
   * скобки — иначе можно инжектнуть [секция] и перекрыть DEFAULT.
   */
  private sanitizeIniValue(v: string | undefined | null): string {
    if (!v) return '';
    const t = String(v).trim();
    if (!t) return '';
    if (!/^[A-Za-z0-9_.\-:]{1,32}$/.test(t)) return '';
    return t;
  }

  /**
   * Возвращает `fail2ban-client status` — список активных jail'ов + сколько IP в бане.
   * Полезно для UI «текущая защита».
   */
  async clientStatus(): Promise<{ raw: string; jails: string[] }> {
    const r = await this.cmd.execute('fail2ban-client', ['status'], { timeout: 15_000, allowFailure: true });
    if (r.exitCode !== 0) {
      return { raw: r.stderr || r.stdout, jails: [] };
    }
    // Output: "...  Jail list:    sshd, nginx-http-auth"
    const m = /Jail list:\s*(.*)$/m.exec(r.stdout);
    const jails = m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
    return { raw: r.stdout, jails };
  }
}

