import { CommandExecutor } from '../command-executor';
import { promises as fs } from 'fs';
import * as path from 'path';

/**
 * Manticore Search executor.
 *
 * Серверный уровень:
 *   - apt install manticore (репозиторий уже подключён системой / стандартный Debian)
 *   - global-демон отключён (`systemctl disable --now manticore`) — мы крутим
 *     per-site инстансы через template-unit `manticore@.service`
 *   - template unit: /etc/systemd/system/manticore@.service
 *
 * Сайтовый уровень (per-site daemon):
 *   - data_dir: /var/lib/manticore/{siteName}/
 *   - config:   /var/lib/manticore/{siteName}/manticore.conf
 *   - sockets:  /var/www/{siteName}/tmp/manticore.sock + manticore-http.sock
 *   - logs:     /var/www/{siteName}/logs/manticore*.log
 *   - .env:     /var/www/{siteName}/.meowbox/manticore/.env
 *   - systemd: manticore@{siteName}.service
 *   - per-site override: /etc/systemd/system/manticore@{siteName}.service.d/override.conf
 *     (MemoryMax)
 *   - User=site_{siteName} (per-site Linux user)
 *
 * Безопасность: имя сайта валидируем регэкспом — оно попадает в путь и в имя
 * systemd-инстанса. Ничего шеллом не интерпретируется (execFile + allowlist).
 */

const SAFE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const TEMPLATE_UNIT_PATH = '/etc/systemd/system/manticore@.service';
const DATA_BASE = '/var/lib/manticore';

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
  tables: number;
  documents: number;
  diskBytes: number;
  uptimeSec: number;
}

export class ManticoreExecutor {
  constructor(private readonly cmd: CommandExecutor) {}

  // =====================================================================
  // Server level
  // =====================================================================

  async serverStatus(): Promise<ServerStatus> {
    // ВАЖНО: НЕ использовать `-f=${...}` — CommandExecutor блокирует `{` и `}`
    // в аргументах (validateArgs forbidden chars). Используем `-s` — печатает
    // полный control-блок, парсим Status: и Version: построчно.
    const r = await this.cmd.execute('dpkg-query', ['-s', 'manticore'], { allowFailure: true });

    if (r.exitCode !== 0 || !r.stdout) return { installed: false, version: null };

    const status = /^Status:\s*(.+)$/m.exec(r.stdout)?.[1]?.trim() || '';
    if (!/install ok installed/.test(status)) return { installed: false, version: null };

    const version = /^Version:\s*(.+)$/m.exec(r.stdout)?.[1]?.trim() || null;
    return { installed: true, version };
  }

  async serverInstall(): Promise<{ version: string }> {
    // Manticore нет в стандартных репах Ubuntu/Debian — нужно сначала
    // подцепить их APT-репозиторий через .deb-метапакет.
    // https://manticoresearch.com/install/

    // 1) Если репо ещё не стоит — поставить.
    const repoCheck = await this.cmd.execute('dpkg-query', ['-s', 'manticore-repo'], { allowFailure: true });
    const repoInstalled = repoCheck.exitCode === 0
      && /^Status:\s*install ok installed/m.test(repoCheck.stdout);

    if (!repoInstalled) {
      const repoDeb = '/tmp/manticore-repo.noarch.deb';
      // Скачиваем .deb с репо
      const dl = await this.cmd.execute(
        'wget',
        [
          '-q',
          '-O', repoDeb,
          'https://repo.manticoresearch.com/manticore-repo.noarch.deb',
        ],
        { timeout: 120_000, allowFailure: true },
      );
      if (dl.exitCode !== 0) {
        throw new Error(`Не удалось скачать manticore-repo: ${dl.stderr || dl.stdout || 'wget failed'}`);
      }

      // Устанавливаем .deb (он только кладёт sources.list.d/manticore.list + GPG-ключ)
      const repoInstall = await this.cmd.execute(
        'dpkg',
        ['-i', repoDeb],
        { timeout: 60_000, env: { DEBIAN_FRONTEND: 'noninteractive' }, allowFailure: true },
      );
      if (repoInstall.exitCode !== 0) {
        throw new Error(`dpkg -i manticore-repo failed: ${repoInstall.stderr || repoInstall.stdout}`);
      }

      // Подчистим скачанный .deb — он больше не нужен.
      await this.cmd.execute('rm', ['-f', repoDeb], { allowFailure: true }).catch(() => {});
    }

    // 2) apt-get update — теперь с подключённым manticore-репо
    const update = await this.cmd.execute(
      'apt-get',
      ['-o', 'Acquire::Retries=3', 'update'],
      { timeout: 180_000, env: { DEBIAN_FRONTEND: 'noninteractive' }, allowFailure: true },
    );
    if (update.exitCode !== 0) {
      throw new Error(`apt-get update failed: ${update.stderr || update.stdout}`);
    }

    // 3) Сам Manticore
    const install = await this.cmd.execute(
      'apt-get',
      ['install', '-y', '--no-install-recommends', 'manticore'],
      { timeout: 600_000, env: { DEBIAN_FRONTEND: 'noninteractive' }, allowFailure: true },
    );
    if (install.exitCode !== 0) {
      throw new Error(`apt-get install manticore failed: ${install.stderr || install.stdout}`);
    }

    // 4) Disable global manticore daemon — мы крутим per-site инстансы.
    await this.cmd.execute('systemctl', ['disable', '--now', 'manticore'], { allowFailure: true })
      .catch(() => {});

    // 5) Установить template-unit
    await this.installTemplateUnit();

    // 6) Зафиксировать версию
    const status = await this.serverStatus();
    if (!status.installed) throw new Error('Manticore не установился (dpkg-query != installed)');
    return { version: status.version || 'unknown' };
  }

  async serverUninstall(): Promise<void> {
    // Не удаляем data_dir сайтов — disable должен был это сделать.
    // Не делаем purge, чтобы конфиги пакета остались на случай повторной установки.
    await this.cmd.execute('systemctl', ['disable', '--now', 'manticore'], { allowFailure: true })
      .catch(() => {});
    await fs.unlink(TEMPLATE_UNIT_PATH).catch(() => {});
    await this.cmd.execute('systemctl', ['daemon-reload'], { allowFailure: true }).catch(() => {});

    const r = await this.cmd.execute(
      'apt-get',
      ['remove', '-y', 'manticore'],
      { timeout: 300_000, env: { DEBIAN_FRONTEND: 'noninteractive' }, allowFailure: true },
    );
    if (r.exitCode !== 0) {
      throw new Error(`apt-get remove manticore failed: ${r.stderr || r.stdout}`);
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
    const envDir = path.join(p.rootPath, '.meowbox', 'manticore');
    const configPath = path.join(dataDir, 'manticore.conf');

    // 1) Создать data_dir + binlog/ с правильным владельцем.
    //    Manticore при старте требует binlog_path-директорию заранее
    //    (FATAL: failed to open '.../binlog/binlog.lock'), сам её не создаёт.
    const binlogDir = path.join(dataDir, 'binlog');
    await this.cmd.execute('mkdir', ['-p', dataDir, binlogDir]);
    await this.cmd.execute('chown', ['-R', `${p.systemUser}:${p.systemUser}`, dataDir]);
    await this.cmd.execute('chmod', ['750', dataDir]);
    await this.cmd.execute('chmod', ['750', binlogDir]);

    // 2) Гарантировать tmp/logs (на случай если их ещё нет)
    await this.cmd.execute('mkdir', ['-p', tmpDir, logsDir]);
    await this.cmd.execute('chown', ['-R', `${p.systemUser}:${p.systemUser}`, tmpDir, logsDir]);

    // 2.5) Adminer-доступ к Manticore-сокету.
    //   Сокет лежит в `{rootPath}/tmp/manticore.sock`. PHP-FPM пул `meowbox-adminer`
    //   крутится под отдельным юзером (для изоляции от per-site PHP), поэтому без
    //   явного шага он не сможет ни обойти `{rootPath}` (750 site:site), ни залезть
    //   в `tmp/` (700 site:site).
    //
    //   Решение — minimum viable:
    //     a) добавить meowbox-adminer в группу сайта → проходит траверс {rootPath}
    //        с `750 site:site` (gid сайта в supplementary groups).
    //     b) сменить tmp/ с 700 на 750 → теперь группа сайта (включая
    //        meowbox-adminer и www-data) может listing+открывать сокет.
    //   Файлы внутри tmp/ (PHP-сессии и т.п.) пишутся под mode 600 самим PHP —
    //   listing их не раскрывает. www-data уже в этой группе, новый risk surface
    //   нулевой.
    //
    //   Если юзер meowbox-adminer ещё не создан (свежая инсталляция без adminer-пула) —
    //   просто пропускаем; ошибки `id` ловим и не валим siteEnable.
    const adminerUser = await this.cmd.execute('id', ['-u', 'meowbox-adminer'], { allowFailure: true });
    if (adminerUser.exitCode === 0) {
      await this.cmd.execute('usermod', ['-aG', p.systemUser, 'meowbox-adminer'], { allowFailure: true })
        .catch(() => {});
    }
    await this.cmd.execute('chmod', ['750', tmpDir]);

    // 3) Сгенерить конфиг сервера
    const conf = renderManticoreConfig({
      siteName: p.siteName,
      tmpDir,
      logsDir,
      dataDir,
    });
    await fs.writeFile(configPath, conf, { mode: 0o640 });
    await this.cmd.execute('chown', [`${p.systemUser}:${p.systemUser}`, configPath]);

    // 4) Сгенерить .env (.meowbox/manticore/.env)
    await this.writeEnvFile(p.systemUser, p.rootPath, p.siteName);

    // 5) Per-site override: MemoryMax
    await this.writeSiteOverride(p.siteName, p.memoryMaxMb);

    // 6) Гарантировать template unit
    await this.installTemplateUnit();

    // 7) Daemon-reload + enable+start
    await this.cmd.execute('systemctl', ['daemon-reload']);
    const r = await this.cmd.execute(
      'systemctl', ['enable', '--now', `manticore@${p.siteName}.service`],
      { allowFailure: true },
    );
    if (r.exitCode !== 0) {
      throw new Error(`systemctl enable manticore@${p.siteName} failed: ${r.stderr || r.stdout}`);
    }
  }

  async siteDisable(p: SiteContextParams): Promise<void> {
    this.assertSafeName(p.siteName);
    await this.cmd.execute(
      'systemctl', ['disable', '--now', `manticore@${p.siteName}.service`],
      { allowFailure: true },
    ).catch(() => {});

    const dataDir = path.join(DATA_BASE, p.siteName);
    await this.cmd.execute('rm', ['-rf', dataDir], { allowFailure: true }).catch(() => {});

    // override drop-in
    const overrideDir = `/etc/systemd/system/manticore@${p.siteName}.service.d`;
    await this.cmd.execute('rm', ['-rf', overrideDir], { allowFailure: true }).catch(() => {});
    await this.cmd.execute('systemctl', ['daemon-reload'], { allowFailure: true }).catch(() => {});

    // .env-файл сайта
    if (p.rootPath) {
      const envDir = path.join(p.rootPath, '.meowbox', 'manticore');
      await this.cmd.execute('rm', ['-rf', envDir], { allowFailure: true }).catch(() => {});
    }
  }

  async siteStart(p: SiteContextParams): Promise<void> {
    this.assertSafeName(p.siteName);
    const r = await this.cmd.execute(
      'systemctl', ['start', `manticore@${p.siteName}.service`],
      { allowFailure: true },
    );
    if (r.exitCode !== 0) {
      throw new Error(`systemctl start manticore@${p.siteName} failed: ${r.stderr || r.stdout}`);
    }
  }

  async siteStop(p: SiteContextParams): Promise<void> {
    this.assertSafeName(p.siteName);
    const r = await this.cmd.execute(
      'systemctl', ['stop', `manticore@${p.siteName}.service`],
      { allowFailure: true },
    );
    if (r.exitCode !== 0) {
      throw new Error(`systemctl stop manticore@${p.siteName} failed: ${r.stderr || r.stdout}`);
    }
  }

  async siteStatus(p: SiteContextParams): Promise<{ status: 'RUNNING' | 'STOPPED' | 'ERROR' }> {
    this.assertSafeName(p.siteName);
    // is-active возвращает 3 если сервис не активен — это валидный ответ.
    const r = await this.cmd.execute(
      'systemctl', ['is-active', `manticore@${p.siteName}.service`],
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
    await this.writeSiteOverride(siteName, memoryMaxMb);
    await this.cmd.execute('systemctl', ['daemon-reload']);
    // restart, чтобы лимит применился (drop-in MemoryMax не подхватывается на лету)
    const isActive = await this.siteStatus({ siteName });
    if (isActive.status === 'RUNNING') {
      await this.cmd.execute('systemctl', ['restart', `manticore@${siteName}.service`]);
    }
  }

  async siteMetrics(p: { siteName: string; rootPath: string }): Promise<SiteMetrics> {
    this.assertSafeName(p.siteName);
    const dataDir = path.join(DATA_BASE, p.siteName);
    const sock = path.join(p.rootPath, 'tmp', 'manticore.sock');

    // Проверка что сокет существует — иначе demonстопнут или ещё не успел стартануть.
    const sockExists = await fs.access(sock).then(() => true).catch(() => false);

    let tables = 0;
    let documents = 0;
    let uptimeSec = 0;

    if (sockExists) {
      try {
        // SHOW TABLES
        const t = await this.cmd.execute(
          'mysql',
          ['--protocol=socket', '-S', sock, '-e', 'SHOW TABLES;', '--batch', '--skip-column-names'],
          { timeout: 10_000, allowFailure: true },
        );
        if (t.exitCode === 0) {
          const lines = t.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
          tables = lines.length;
          // SUM doc count по каждой таблице
          for (const line of lines) {
            const tableName = line.split(/\s+/)[0];
            if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(tableName)) continue;
            const c = await this.cmd.execute(
              'mysql',
              ['--protocol=socket', '-S', sock, '-e', `SELECT COUNT(*) FROM \`${tableName}\`;`, '--batch', '--skip-column-names'],
              { timeout: 10_000, allowFailure: true },
            );
            const n = parseInt(c.stdout.trim(), 10);
            if (Number.isFinite(n)) documents += n;
          }
        }
        // SHOW STATUS uptime
        const u = await this.cmd.execute(
          'mysql',
          ['--protocol=socket', '-S', sock, '-e', "SHOW STATUS LIKE 'uptime';", '--batch', '--skip-column-names'],
          { timeout: 10_000, allowFailure: true },
        );
        if (u.exitCode === 0) {
          const m = u.stdout.match(/uptime\s+(\d+)/i);
          if (m) uptimeSec = parseInt(m[1], 10);
        }
      } catch {
        // metrics best-effort
      }
    }

    // disk usage data_dir — du может вернуть >0 при permission denied на отдельных файлах.
    let diskBytes = 0;
    const du = await this.cmd.execute('du', ['-sb', dataDir], { allowFailure: true });
    if (du.exitCode === 0) {
      const m = du.stdout.match(/^(\d+)/);
      if (m) diskBytes = parseInt(m[1], 10);
    }

    return { tables, documents, diskBytes, uptimeSec };
  }

  async siteLogs(p: { siteName: string; rootPath: string; lines: number }): Promise<{ content: string }> {
    this.assertSafeName(p.siteName);
    const logFile = path.join(p.rootPath, 'logs', 'manticore.log');
    const exists = await fs.access(logFile).then(() => true).catch(() => false);
    if (!exists) {
      // fallback: journalctl -u manticore@{site}
      const r = await this.cmd.execute('journalctl', [
        '-u', `manticore@${p.siteName}.service`,
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
    const dir = `/etc/systemd/system/manticore@${siteName}.service.d`;
    const file = path.join(dir, 'override.conf');
    await this.cmd.execute('mkdir', ['-p', dir]);
    const mem = Math.max(32, Math.min(4096, Math.floor(memoryMaxMb))); // safety clamp
    const content = `[Service]\nMemoryMax=${mem}M\n`;
    await fs.writeFile(file, content, { mode: 0o644 });
  }

  private async writeEnvFile(systemUser: string, rootPath: string, siteName: string): Promise<void> {
    const meowboxDir = path.join(rootPath, '.meowbox');
    const svcDir = path.join(meowboxDir, 'manticore');
    const envFile = path.join(svcDir, '.env');

    await this.cmd.execute('mkdir', ['-p', svcDir]);
    await this.cmd.execute('chown', ['-R', `${systemUser}:${systemUser}`, meowboxDir]);
    await this.cmd.execute('chmod', ['700', meowboxDir]);
    await this.cmd.execute('chmod', ['700', svcDir]);

    const tmp = path.join(rootPath, 'tmp');
    const content = [
      '# Подключение к Manticore Search для этого сайта.',
      '# Файл автоматически создан панелью meowbox; правка вручную бессмысленна.',
      `MEOWBOX_MANTICORE_SITE=${siteName}`,
      `MEOWBOX_MANTICORE_SOCKET=${tmp}/manticore.sock`,
      `MEOWBOX_MANTICORE_HTTP_SOCKET=${tmp}/manticore-http.sock`,
      `MEOWBOX_MANTICORE_DATA_DIR=${path.join(DATA_BASE, siteName)}`,
      '',
    ].join('\n');
    await fs.writeFile(envFile, content, { mode: 0o600 });
    await this.cmd.execute('chown', [`${systemUser}:${systemUser}`, envFile]);
    await this.cmd.execute('chmod', ['600', envFile]);
  }
}

const TEMPLATE_UNIT_CONTENT = `[Unit]
Description=Manticore Search (per-site instance for %i)
Documentation=https://manual.manticoresearch.com/
After=network.target

[Service]
Type=simple
User=%i
Group=%i
ExecStart=/usr/bin/searchd --config /var/lib/manticore/%i/manticore.conf --nodetach
ExecReload=/bin/kill -HUP $MAINPID
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
}

function renderManticoreConfig(p: RenderConfigParams): string {
  // Per-site searchd config. Без `index` блоков — RT-таблицы юзер создаёт сам
  // через CREATE TABLE из своего PHP-кода.
  return `# meowbox per-site Manticore config for ${p.siteName}
# Generated automatically. RT-таблицы создаются динамически через SQL — здесь не объявляются.

searchd {
    listen = ${p.tmpDir}/manticore.sock:mysql41
    listen = ${p.tmpDir}/manticore-http.sock:http
    log = ${p.logsDir}/manticore.log
    query_log = ${p.logsDir}/manticore-query.log
    pid_file = ${p.dataDir}/searchd.pid
    data_dir = ${p.dataDir}
    binlog_path = ${p.dataDir}/binlog
    network_timeout = 5s
    max_filter_values = 8192
}
`;
}
