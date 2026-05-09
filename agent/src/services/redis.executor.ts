import { CommandExecutor } from '../command-executor';
import { promises as fs } from 'fs';
import * as path from 'path';

/**
 * Redis executor.
 *
 * Архитектура аналогична Manticore: per-site daemon, изолированный по юзеру.
 * Доступ через unix-socket (TCP отключён `port 0`) — пароли не нужны,
 * изоляция за счёт прав на socket-файл (770, owner=siteUser).
 *
 * Серверный уровень:
 *   - apt install redis-server
 *   - системный демон отключён (`systemctl disable --now redis-server`)
 *   - template unit: /etc/systemd/system/redis@.service (наш, не пакетный)
 *
 * Сайтовый уровень:
 *   - data_dir: /var/lib/redis/{siteName}/
 *   - config:   /var/lib/redis/{siteName}/redis.conf
 *   - socket:   /var/www/{siteName}/tmp/redis.sock
 *   - pid:      /var/www/{siteName}/tmp/redis.pid
 *   - logs:     /var/www/{siteName}/logs/redis.log
 *   - .env:     /var/www/{siteName}/.meowbox/redis/.env
 *   - override: /etc/systemd/system/redis@{siteName}.service.d/override.conf (MemoryMax)
 */

const SAFE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const TEMPLATE_UNIT_PATH = '/etc/systemd/system/redis@.service';
const DATA_BASE = '/var/lib/redis';

export interface ServerStatus {
  installed: boolean;
  version: string | null;
}

export interface SiteEnableParams {
  siteName: string;
  systemUser: string;
  rootPath: string;
  memoryMaxMb: number;
}

export interface SiteContextParams {
  siteName: string;
  systemUser?: string;
  rootPath?: string;
}

export interface SiteMetrics {
  usedMemory: number;
  usedMemoryPeak: number;
  maxMemory: number;
  connectedClients: number;
  keysCount: number;
  commandsTotal: number;
  diskBytes: number;
  uptimeSec: number;
}

export class RedisExecutor {
  constructor(private readonly cmd: CommandExecutor) {}

  // =====================================================================
  // Server level
  // =====================================================================

  async serverStatus(): Promise<ServerStatus> {
    // ВАЖНО: НЕ использовать `-f=${...}` — CommandExecutor блокирует `{` и `}`
    // в аргументах (validateArgs forbidden chars). Используем `-s` — он печатает
    // полный control-блок, парсим Status: и Version: построчно.
    // dpkg-query exit=1 если пакет не установлен — валидно.
    const r = await this.cmd.execute('dpkg-query', ['-s', 'redis-server'], { allowFailure: true });

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
      ['install', '-y', '--no-install-recommends', 'redis-server'],
      { timeout: 600_000, env: { DEBIAN_FRONTEND: 'noninteractive' }, allowFailure: true },
    );
    if (install.exitCode !== 0) {
      throw new Error(`apt-get install redis-server failed: ${install.stderr || install.stdout}`);
    }

    // Системный redis-server демон не нужен — мы делаем per-site инстансы.
    // disable может фейлиться на свежей установке (юнит ещё не загружен) — best-effort.
    await this.cmd.execute('systemctl', ['disable', '--now', 'redis-server'], { allowFailure: true })
      .catch(() => {});

    await this.installTemplateUnit();

    const status = await this.serverStatus();
    if (!status.installed) throw new Error('redis-server не установился (dpkg-query != installed)');
    return { version: status.version || 'unknown' };
  }

  async serverUninstall(): Promise<void> {
    await this.cmd.execute('systemctl', ['disable', '--now', 'redis-server'], { allowFailure: true })
      .catch(() => {});
    await fs.unlink(TEMPLATE_UNIT_PATH).catch(() => {});
    await this.cmd.execute('systemctl', ['daemon-reload'], { allowFailure: true }).catch(() => {});

    const r = await this.cmd.execute(
      'apt-get',
      ['remove', '-y', 'redis-server'],
      { timeout: 300_000, env: { DEBIAN_FRONTEND: 'noninteractive' }, allowFailure: true },
    );
    if (r.exitCode !== 0) {
      throw new Error(`apt-get remove redis-server failed: ${r.stderr || r.stdout}`);
    }
  }

  // =====================================================================
  // Site level
  // =====================================================================

  async siteEnable(p: SiteEnableParams): Promise<void> {
    this.assertSafeName(p.siteName);
    if (!p.systemUser) throw new Error('systemUser is required');
    if (!p.rootPath || !p.rootPath.startsWith('/')) {
      throw new Error('rootPath must be absolute');
    }

    const dataDir = path.join(DATA_BASE, p.siteName);
    const tmpDir = path.join(p.rootPath, 'tmp');
    const logsDir = path.join(p.rootPath, 'logs');
    const configPath = path.join(dataDir, 'redis.conf');

    await this.cmd.execute('mkdir', ['-p', dataDir]);
    await this.cmd.execute('chown', [`${p.systemUser}:${p.systemUser}`, dataDir]);
    await this.cmd.execute('chmod', ['750', dataDir]);

    await this.cmd.execute('mkdir', ['-p', tmpDir, logsDir]);
    await this.cmd.execute('chown', ['-R', `${p.systemUser}:${p.systemUser}`, tmpDir, logsDir]);

    const conf = renderRedisConfig({
      siteName: p.siteName,
      tmpDir,
      logsDir,
      dataDir,
      memoryMaxMb: p.memoryMaxMb,
    });
    await fs.writeFile(configPath, conf, { mode: 0o640 });
    await this.cmd.execute('chown', [`${p.systemUser}:${p.systemUser}`, configPath]);

    await this.writeEnvFile(p.systemUser, p.rootPath, p.siteName);

    await this.writeSiteOverride(p.siteName, p.memoryMaxMb);

    await this.installTemplateUnit();

    await this.cmd.execute('systemctl', ['daemon-reload']);
    const r = await this.cmd.execute(
      'systemctl', ['enable', '--now', `redis@${p.siteName}.service`],
      { allowFailure: true },
    );
    if (r.exitCode !== 0) {
      throw new Error(`systemctl enable redis@${p.siteName} failed: ${r.stderr || r.stdout}`);
    }
  }

  async siteDisable(p: SiteContextParams): Promise<void> {
    this.assertSafeName(p.siteName);
    await this.cmd.execute(
      'systemctl', ['disable', '--now', `redis@${p.siteName}.service`],
      { allowFailure: true },
    ).catch(() => {});

    const dataDir = path.join(DATA_BASE, p.siteName);
    await this.cmd.execute('rm', ['-rf', dataDir], { allowFailure: true }).catch(() => {});

    const overrideDir = `/etc/systemd/system/redis@${p.siteName}.service.d`;
    await this.cmd.execute('rm', ['-rf', overrideDir], { allowFailure: true }).catch(() => {});
    await this.cmd.execute('systemctl', ['daemon-reload'], { allowFailure: true }).catch(() => {});

    if (p.rootPath) {
      const envDir = path.join(p.rootPath, '.meowbox', 'redis');
      await this.cmd.execute('rm', ['-rf', envDir], { allowFailure: true }).catch(() => {});

      // Чистим socket/pid файлы — они в tmp сайта
      const tmp = path.join(p.rootPath, 'tmp');
      await this.cmd.execute(
        'rm', ['-f', path.join(tmp, 'redis.sock'), path.join(tmp, 'redis.pid')],
        { allowFailure: true },
      ).catch(() => {});
    }
  }

  async siteStart(p: SiteContextParams): Promise<void> {
    this.assertSafeName(p.siteName);
    const r = await this.cmd.execute(
      'systemctl', ['start', `redis@${p.siteName}.service`],
      { allowFailure: true },
    );
    if (r.exitCode !== 0) {
      throw new Error(`systemctl start redis@${p.siteName} failed: ${r.stderr || r.stdout}`);
    }
  }

  async siteStop(p: SiteContextParams): Promise<void> {
    this.assertSafeName(p.siteName);
    const r = await this.cmd.execute(
      'systemctl', ['stop', `redis@${p.siteName}.service`],
      { allowFailure: true },
    );
    if (r.exitCode !== 0) {
      throw new Error(`systemctl stop redis@${p.siteName} failed: ${r.stderr || r.stdout}`);
    }
  }

  async siteStatus(p: SiteContextParams): Promise<{ status: 'RUNNING' | 'STOPPED' | 'ERROR' }> {
    this.assertSafeName(p.siteName);
    // is-active возвращает 3 если inactive — это валидный ответ.
    const r = await this.cmd.execute(
      'systemctl', ['is-active', `redis@${p.siteName}.service`],
      { allowFailure: true },
    );
    const out = r.stdout.trim();
    if (out === 'active') return { status: 'RUNNING' };
    if (out === 'inactive' || out === 'deactivating') return { status: 'STOPPED' };
    if (out === 'failed') return { status: 'ERROR' };
    return { status: 'STOPPED' };
  }

  async siteReconfigure(siteName: string, memoryMaxMb: number): Promise<void> {
    this.assertSafeName(siteName);

    // Перезаписываем redis.conf — там тоже есть maxmemory
    const dataDir = path.join(DATA_BASE, siteName);
    const configPath = path.join(dataDir, 'redis.conf');

    // Читаем текущий конфиг, обновляем maxmemory
    let existing = '';
    try {
      existing = await fs.readFile(configPath, 'utf8');
    } catch {
      throw new Error(`redis.conf не найден для сайта ${siteName}`);
    }

    const mem = Math.max(16, Math.min(4096, Math.floor(memoryMaxMb)));
    const updated = existing.replace(/^maxmemory\s+\S+/m, `maxmemory ${mem}mb`);
    if (!/^maxmemory\s+/m.test(updated)) {
      throw new Error('Не нашёл строку maxmemory в redis.conf');
    }
    await fs.writeFile(configPath, updated, { mode: 0o640 });

    // Обновляем systemd MemoryMax (защита на уровне cgroup)
    await this.writeSiteOverride(siteName, memoryMaxMb);
    await this.cmd.execute('systemctl', ['daemon-reload']);

    const isActive = await this.siteStatus({ siteName });
    if (isActive.status === 'RUNNING') {
      // Применить новый maxmemory без рестарта (CONFIG SET) — keep данные в памяти
      const sock = await this.findSocket(siteName);
      if (sock) {
        // CONFIG SET может фейлиться (auth/AUTH, версия) — fallback на рестарт.
        await this.cmd.execute('redis-cli', [
          '-s', sock, 'CONFIG', 'SET', 'maxmemory', `${mem}mb`,
        ], { allowFailure: true }).catch(() => { /* fallback — рестарт ниже */ });
      }
      // Если CONFIG SET не сработал — нужен рестарт; тут решает админ.
      // Делаем мягкий restart для гарантии полного применения override.
      await this.cmd.execute('systemctl', ['restart', `redis@${siteName}.service`]);
    }
  }

  async siteMetrics(p: { siteName: string; rootPath: string }): Promise<SiteMetrics> {
    this.assertSafeName(p.siteName);
    const dataDir = path.join(DATA_BASE, p.siteName);
    const sock = path.join(p.rootPath, 'tmp', 'redis.sock');

    const sockExists = await fs.access(sock).then(() => true).catch(() => false);

    let usedMemory = 0;
    let usedMemoryPeak = 0;
    let maxMemory = 0;
    let connectedClients = 0;
    let keysCount = 0;
    let commandsTotal = 0;
    let uptimeSec = 0;

    if (sockExists) {
      try {
        const r = await this.cmd.execute(
          'redis-cli', ['-s', sock, 'INFO'],
          { timeout: 10_000, allowFailure: true },
        );
        if (r.exitCode === 0) {
          const lines = r.stdout.split('\n').map((l) => l.trim());
          const map: Record<string, string> = {};
          for (const line of lines) {
            const idx = line.indexOf(':');
            if (idx > 0) map[line.substring(0, idx)] = line.substring(idx + 1);
          }
          usedMemory = parseInt(map.used_memory || '0', 10) || 0;
          usedMemoryPeak = parseInt(map.used_memory_peak || '0', 10) || 0;
          maxMemory = parseInt(map.maxmemory || '0', 10) || 0;
          connectedClients = parseInt(map.connected_clients || '0', 10) || 0;
          commandsTotal = parseInt(map.total_commands_processed || '0', 10) || 0;
          uptimeSec = parseInt(map.uptime_in_seconds || '0', 10) || 0;

          // db0:keys=N → keysCount
          for (const key of Object.keys(map)) {
            if (/^db\d+$/.test(key)) {
              const m = map[key].match(/keys=(\d+)/);
              if (m) keysCount += parseInt(m[1], 10) || 0;
            }
          }
        }
      } catch {
        // best-effort
      }
    }

    let diskBytes = 0;
    // du может вернуть >0 при permission denied на отдельных файлах — это норма.
    const du = await this.cmd.execute('du', ['-sb', dataDir], { allowFailure: true });
    if (du.exitCode === 0) {
      const m = du.stdout.match(/^(\d+)/);
      if (m) diskBytes = parseInt(m[1], 10);
    }

    return { usedMemory, usedMemoryPeak, maxMemory, connectedClients, keysCount, commandsTotal, diskBytes, uptimeSec };
  }

  async siteLogs(p: { siteName: string; rootPath: string; lines: number }): Promise<{ content: string }> {
    this.assertSafeName(p.siteName);
    const logFile = path.join(p.rootPath, 'logs', 'redis.log');
    const exists = await fs.access(logFile).then(() => true).catch(() => false);
    if (!exists) {
      const r = await this.cmd.execute('journalctl', [
        '-u', `redis@${p.siteName}.service`,
        '-n', String(Math.max(1, Math.min(5000, p.lines))),
        '--no-pager',
      ], { allowFailure: true });
      return { content: r.stdout || '(нет логов)' };
    }
    const r = await this.cmd.execute('tail', ['-n', String(Math.max(1, Math.min(5000, p.lines))), logFile]);
    return { content: r.stdout || '' };
  }

  // =====================================================================
  // Internals
  // =====================================================================

  private assertSafeName(name: string): void {
    if (!name || !SAFE_NAME.test(name)) {
      throw new Error(`Unsafe site name: ${name}`);
    }
  }

  private async findSocket(siteName: string): Promise<string | null> {
    // socket лежит в /var/www/{siteName}/tmp/redis.sock (siteName === systemUser)
    const candidate = `/var/www/${siteName}/tmp/redis.sock`;
    return (await fs.access(candidate).then(() => true).catch(() => false)) ? candidate : null;
  }

  private async installTemplateUnit(): Promise<void> {
    const content = TEMPLATE_UNIT_CONTENT;
    let existing = '';
    try {
      existing = await fs.readFile(TEMPLATE_UNIT_PATH, 'utf8');
    } catch {
      // no-op
    }
    if (existing.trim() === content.trim()) return;
    await fs.writeFile(TEMPLATE_UNIT_PATH, content, { mode: 0o644 });
    await this.cmd.execute('systemctl', ['daemon-reload']);
  }

  private async writeSiteOverride(siteName: string, memoryMaxMb: number): Promise<void> {
    const dir = `/etc/systemd/system/redis@${siteName}.service.d`;
    const file = path.join(dir, 'override.conf');
    await this.cmd.execute('mkdir', ['-p', dir]);
    const mem = Math.max(16, Math.min(4096, Math.floor(memoryMaxMb)));
    // cgroup-лимит чуть выше maxmemory (на overhead Redis ~25%) — иначе OOM при пике.
    const cgroupLimit = Math.ceil(mem * 1.4);
    const content = `[Service]\nMemoryMax=${cgroupLimit}M\n`;
    await fs.writeFile(file, content, { mode: 0o644 });
  }

  private async writeEnvFile(systemUser: string, rootPath: string, siteName: string): Promise<void> {
    const meowboxDir = path.join(rootPath, '.meowbox');
    const svcDir = path.join(meowboxDir, 'redis');
    const envFile = path.join(svcDir, '.env');

    await this.cmd.execute('mkdir', ['-p', svcDir]);
    await this.cmd.execute('chown', ['-R', `${systemUser}:${systemUser}`, meowboxDir]);
    await this.cmd.execute('chmod', ['700', meowboxDir]);
    await this.cmd.execute('chmod', ['700', svcDir]);

    const tmp = path.join(rootPath, 'tmp');
    const content = [
      '# Подключение к Redis для этого сайта.',
      '# Файл автоматически создан панелью meowbox; правка вручную бессмысленна.',
      `MEOWBOX_REDIS_SITE=${siteName}`,
      `MEOWBOX_REDIS_SOCKET=${tmp}/redis.sock`,
      `MEOWBOX_REDIS_DATA_DIR=${path.join(DATA_BASE, siteName)}`,
      'MEOWBOX_REDIS_DB=0',
      '',
    ].join('\n');
    await fs.writeFile(envFile, content, { mode: 0o600 });
    await this.cmd.execute('chown', [`${systemUser}:${systemUser}`, envFile]);
    await this.cmd.execute('chmod', ['600', envFile]);
  }
}

const TEMPLATE_UNIT_CONTENT = `[Unit]
Description=Redis (per-site instance for %i, meowbox)
Documentation=https://redis.io/documentation
After=network.target

[Service]
Type=simple
User=%i
Group=%i
ExecStart=/usr/bin/redis-server /var/lib/redis/%i/redis.conf --supervised systemd
ExecStop=/bin/kill -TERM $MAINPID
Restart=on-failure
RestartSec=5
LimitNOFILE=65536
MemoryMax=128M
ProtectSystem=full
ProtectHome=read-only
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
`;

interface RenderConfigParams {
  siteName: string;
  tmpDir: string;
  logsDir: string;
  dataDir: string;
  memoryMaxMb: number;
}

function renderRedisConfig(p: RenderConfigParams): string {
  const mem = Math.max(16, Math.min(4096, Math.floor(p.memoryMaxMb)));
  // unix-socket only, без TCP (port 0). Изоляция через права на socket-файл.
  return `# meowbox per-site Redis config for ${p.siteName}
# Generated automatically.

# ---- Networking: только unix-socket, TCP отключён ----
port 0
unixsocket ${p.tmpDir}/redis.sock
unixsocketperm 770

# ---- Process ----
daemonize no
supervised systemd
pidfile ${p.tmpDir}/redis.pid

# ---- Logging ----
logfile ${p.logsDir}/redis.log
loglevel notice

# ---- Persistence: только RDB-снапшот по триггеру, без AOF ----
# Если нужен AOF — поправь руками или попроси у разраба переключатель в панели.
dir ${p.dataDir}
dbfilename dump.rdb
appendonly no
save 900 1
save 300 10
save 60 10000

# ---- Memory ----
maxmemory ${mem}mb
maxmemory-policy allkeys-lru

# ---- Misc ----
timeout 0
tcp-keepalive 300
databases 16
`;
}
