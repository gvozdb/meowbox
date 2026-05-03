/**
 * SSH-bridge к серверу-источнику hostPanel.
 *
 * Используем `sshpass -p` (дополнительная зависимость, ставится system-миграцией)
 * чтобы агент мог выполнять команды без интерактивного ввода. Альтернатива —
 * SSH-ключи (генерация + копирование `authorized_keys` через первый
 * sshpass-запрос), но это меняет состояние источника. Spec'а требует READ-ONLY,
 * так что оставляем sshpass на момент миграции (он не пишет на источник).
 *
 * SECURITY:
 *   - Пароль никогда не попадает в argv (sshpass поддерживает -e (env-var)
 *     и -f (файл)). Используем -e через `SSHPASS=<password>` в env.
 *   - StrictHostKeyChecking=no + UserKnownHostsFile=/dev/null — иначе придётся
 *     хранить known_hosts. Migration — одноразовая операция, MITM-risk
 *     приемлем (юзер знает IP сервера-источника заранее).
 *   - Пользовательский ввод (`host`, `port`, `user`) валидирован на API-стороне
 *     (DTO regex). Здесь повторно проверяем длину/формат как defense-in-depth.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import { promises as fs, createWriteStream, WriteStream, openSync, closeSync } from 'fs';
import * as os from 'os';

import { CommandExecutor } from '../../command-executor';

export interface SshSourceConfig {
  host: string;
  port: number;
  user: string;
  password: string;
}

const SSH_OPTS = [
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null',
  '-o', 'GlobalKnownHostsFile=/dev/null',
  '-o', 'LogLevel=ERROR',
  '-o', 'PreferredAuthentications=password',
  '-o', 'PubkeyAuthentication=no',
  '-o', 'ConnectTimeout=15',
  // Keepalive: каждые 30s ssh шлёт `keepalive request`. После 3 неудач
  // (90s без ответа) ssh-клиент закрывает сессию с ошибкой.
  // Без ServerAliveCountMax дефолт = 3, но прописываем явно — чтобы NAT
  // на стороне источника не ел соединение «молча» (TCP retransmit может
  // не подняться часами, sshd на источнике не узнает что мы живы).
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'TCPKeepAlive=yes',
];

const HOST_RE = /^[a-zA-Z0-9.\-:]+$/;          // IPv4/hostname (IPv6 — отдельно если нужно)
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

/**
 * spec §2.1: «Read-only к источнику. Запрещено: любые INSERT/UPDATE/DELETE,
 * DROP, TRUNCATE, rm, mv, chmod, service stop, apt». Здесь — низкоуровневый
 * статический фильтр поверх любой команды, которая шлётся на источник через
 * sshpass+ssh. НЕ replacement для проверки на стороне master/agent — это
 * последний рубеж защиты.
 */
const FORBIDDEN_SQL_KEYWORDS = /\b(INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|DROP\s+(DATABASE|TABLE|USER|INDEX|SCHEMA)|TRUNCATE\b|ALTER\s+(DATABASE|TABLE|USER)|GRANT\s+|REVOKE\s+|REPLACE\s+INTO|RENAME\s+TABLE|CREATE\s+(DATABASE|TABLE|USER|INDEX))\b/i;
// Список mutation-бинарей. `crontab` НЕ в списке: на источнике мы вызываем
// только `crontab -l` / `crontab -u <user> -l` для чтения. Запись через
// `crontab -` идёт ТОЛЬКО локально (system-cron.service.ts), не через
// SshSourceBridge. Если кто-то добавит ssh-вызов crontab с stdin —
// он попадёт под `tee` / прямое перенаправление в файл, что мы блокируем.
const FORBIDDEN_SHELL_BINS = /(?:^|[\s;&|`(])(?:rm|mv|cp\s+-[^\s]*[uf]|chmod|chown|chgrp|systemctl|service|apt|apt-get|dpkg|yum|dnf|pkg|killall|pkill|reboot|shutdown|halt|poweroff|fdisk|mkfs|dd\s+if=|mount|umount|useradd|userdel|usermod|groupadd|groupdel|passwd\s|tee\s|>\s*\/(?!dev\/null|tmp\/[^/]))/i;

export function assertSourceCommandReadOnly(command: string): void {
  // mysqldump / mysql -B -N -e SELECT ... — это read-only. Но если внутри
  // команды есть SQL-кейворд из write-list — это write-операция.
  if (FORBIDDEN_SQL_KEYWORDS.test(command)) {
    throw new Error(
      `SSH command rejected: write SQL detected. Source is read-only (spec §2.1)`,
    );
  }
  // Bash-binaries, которые мутируют состояние source. Список покрывает
  // основные кейсы — не пытается быть исчерпывающим (defense-in-depth).
  if (FORBIDDEN_SHELL_BINS.test(command)) {
    throw new Error(
      `SSH command rejected: mutation binary detected (rm/chmod/systemctl/...). Source is read-only (spec §2.1)`,
    );
  }
}

export class SshSourceBridge {
  private readonly executor = new CommandExecutor();

  /** Доступ к конфигу для pipe-helper'ов (read-only). Пароль возвращается. */
  getConfig(): SshSourceConfig {
    return this.cfg;
  }

  constructor(private readonly cfg: SshSourceConfig) {
    if (!HOST_RE.test(cfg.host)) {
      throw new Error(`Invalid SSH host: "${cfg.host}"`);
    }
    if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
      throw new Error(`Invalid SSH port: ${cfg.port}`);
    }
    if (!USER_RE.test(cfg.user)) {
      throw new Error(`Invalid SSH user: "${cfg.user}"`);
    }
    // Пароль не валидируем формат (любой printable), но запрещаем control chars
    if (/[\x00\r\n]/.test(cfg.password)) {
      throw new Error('SSH password contains control characters');
    }
  }

  /** Полные SSH-args без подстановки команды — для встраивания в rsync `-e`. */
  private sshArgs(): string[] {
    return [...SSH_OPTS, '-p', String(this.cfg.port)];
  }

  /** Целевой селектор для ssh: user@host. */
  private target(): string {
    return `${this.cfg.user}@${this.cfg.host}`;
  }

  /**
   * Запускает `sshpass -e ssh ...` и возвращает stdout/stderr/exitCode.
   * Пароль передаётся через env SSHPASS, в argv его нет.
   *
   * spec §2.1: на источнике RAID-OFF / READ-ONLY allowlist. Хотя discover.ts
   * и run-item.ts собирают команды из своих хелперов (mysqldump, du, find,
   * mysql -B -N -e SELECT ...), мы дополнительно блокируем явные
   * write-mutation паттерны как defense-in-depth — на случай регрессий
   * в коде или попытки оператора подсунуть вредоносный плагин.
   */
  async run(
    command: string,
    opts: { timeout?: number; trim?: boolean } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (/[\x00\r]/.test(command)) {
      throw new Error('SSH command contains forbidden control chars');
    }
    assertSourceCommandReadOnly(command);
    const args = ['-e', 'ssh', ...this.sshArgs(), this.target(), command];
    // Последний arg (command) — это shell-команда для удалённого хоста.
    // Локальный execFile её не интерпретирует, shell-операторы (`&&`, `|`, `${}`)
    // там легитимны. assertSourceCommandReadOnly уже отсёк опасные write-ops.
    const r = await this.executor.execute('sshpass', args, {
      env: { SSHPASS: this.cfg.password },
      timeout: opts.timeout ?? 60_000,
      unsafeShellMetaArgs: [args.length - 1],
    });
    return {
      stdout: opts.trim === false ? r.stdout : r.stdout.trim(),
      stderr: r.stderr,
      exitCode: r.exitCode,
    };
  }

  /** Удобный shortcut: получить содержимое файла с источника (или null если нет). */
  async readFile(remotePath: string): Promise<string | null> {
    if (/[\x00\r\n;&|`$]/.test(remotePath)) {
      throw new Error(`Invalid remote path: ${remotePath}`);
    }
    const r = await this.run(`test -f '${remotePath}' && cat '${remotePath}' || echo __MEOWBOX_NOFILE__`);
    if (r.exitCode !== 0) return null;
    if (r.stdout === '__MEOWBOX_NOFILE__') return null;
    return r.stdout;
  }

  /** ls для одного каталога. Возвращает имена файлов/папок. */
  async listDir(remotePath: string): Promise<{ name: string; kind: 'file' | 'dir'; bytes: number }[]> {
    if (/[\x00\r\n;&|`$]/.test(remotePath)) {
      throw new Error(`Invalid remote path: ${remotePath}`);
    }
    // -A: include .files; -p: append / for dirs; --max-depth не используем (find для recursive нам не нужен)
    const r = await this.run(
      `find '${remotePath}' -maxdepth 1 -mindepth 1 -printf '%y\\t%s\\t%f\\n' 2>/dev/null || true`,
    );
    const lines = r.stdout.split('\n').filter(Boolean);
    return lines
      .map((l) => {
        const parts = l.split('\t');
        if (parts.length < 3) return null;
        const [type, size, name] = parts;
        if (!name || !type) return null;
        return {
          name,
          kind: type === 'd' ? ('dir' as const) : ('file' as const),
          bytes: Number(size) || 0,
        };
      })
      .filter((x): x is { name: string; kind: 'file' | 'dir'; bytes: number } => x !== null);
  }

  /** du -sb /path — размер директории в байтах. */
  async dirSize(remotePath: string): Promise<number> {
    const r = await this.run(
      `du -sb '${remotePath}' 2>/dev/null | awk '{print $1}' || echo 0`,
      { timeout: 300_000 },
    );
    return Number(r.stdout) || 0;
  }

  /** SSH-args в виде одной строки для `rsync -e "..."`. */
  rsyncSshSpec(): string {
    return `sshpass -e ssh ${this.sshArgs().join(' ')}`;
  }

  /** Возвращает env с SSHPASS — для использования в rsync. */
  rsyncEnv(): NodeJS.ProcessEnv {
    return { SSHPASS: this.cfg.password };
  }

  /** Для mysqldump через ssh — собираем команду. */
  buildMysqldumpRemote(args: {
    user: string;
    password: string;
    host: string;
    port: number;
    database: string;
    extraArgs: string[];
  }): string {
    // На источнике — пишем `.my.cnf`-style options в tmp-file, чтобы пароль не
    // утёк в `ps`. Однако через ssh это сложнее (надо записать → удалить).
    // Альтернатива: --defaults-extra-file=<(echo ...) — bash process substitution.
    // Простейший вариант (для READ-ONLY): MYSQL_PWD env-var, не показывается в ps.
    const safe = (s: string) => s.replace(/[\\$`"]/g, '\\$&');
    const extras = args.extraArgs.map(safe).join(' ');
    // Флаги, которые лечат типовой кейс «MODX dump → MariaDB не парсится»:
    //   --default-character-set=utf8mb4 — старые MySQL-клиенты по умолчанию
    //     используют latin1 для соединения; с utf8mb4-данными это рожает
    //     битые escape-последовательности (`\'`, `\\`) внутри PHP serialized
    //     полей → SQL syntax error на импорте.
    //   --hex-blob — BLOB/BINARY как hex-литералы; иначе байты внутри
    //     INSERT VALUES могут содержать `'` или `\` без эскейпа.
    //   --skip-extended-insert — каждый row в своём INSERT'е. Дороже по
    //     размеру (на 10-30%), но если одна строка кривая, ломается
    //     ровно она, а не весь блок. Главное: ERROR-репорт показывает
    //     конкретный INSERT, оператору сразу видно что не так.
    //   --skip-comments — убирает шапки и `-- DUMP COMPLETED` маркеры,
    //     которые в гибридных версиях MySQL/MariaDB иногда содержат
    //     несовместимые директивы (`/*M!100100 ... */`).
    return (
      `MYSQL_PWD='${safe(args.password)}' mysqldump -h '${safe(args.host)}' ` +
      `-P ${args.port} -u '${safe(args.user)}' --single-transaction --quick ` +
      `--no-tablespaces --default-character-set=utf8mb4 --hex-blob ` +
      `--skip-extended-insert --skip-comments ` +
      `${extras} '${safe(args.database)}'`
    );
  }
}

/**
 * Pipe-трансфер: streamed `ssh src "mysqldump ..." | mysql -u root <dbname>`.
 * Реализуется через child_process с pipe'ами (без участия CommandExecutor —
 * он работает execFile-ом, без shell, без pipe).
 */
export interface PipeDumpArgs {
  ssh: SshSourceBridge;
  remoteCommand: string;
  /** Локальная команда импорта: `mysql -u root <dbname>` или `mariadb -u root <dbname>`. */
  localCommand: string;
  localArgs: string[];
  onLog?: (line: string) => void;
  timeoutMs?: number;
  /**
   * Stall-watchdog: если за это время через pipe не прошло НИ ОДНОГО байта
   * (ни stdout, ни stderr) — субпроцессы получают SIGTERM с ошибкой
   * «stalled for N seconds». Это спасает от ситуации, когда mysqldump
   * висит на чтении большой таблицы или sshd на источнике потерял
   * сетевой пакет, а TCP-keepalive ещё не сработал. По дефолту 600s (10 мин).
   * Передай 0 чтобы отключить.
   */
  stallTimeoutMs?: number;
  /**
   * Soft-cancel: каждые 2с проверяется — если true, шлём SIGTERM обоим
   * субпроцессам (ssh-источник + локальный mariadb).
   */
  isCancelled?: () => boolean;
}

export function pipeDump(args: PipeDumpArgs): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    // spec §2.1 read-only enforcement — то же самое что в SshSourceBridge.run.
    try {
      assertSourceCommandReadOnly(args.remoteCommand);
    } catch (e) {
      reject(e as Error);
      return;
    }
    const cfg = args.ssh.getConfig();
    const sshArgs = [
      '-e',
      'ssh',
      ...SSH_OPTS,
      '-p',
      String(cfg.port),
      `${cfg.user}@${cfg.host}`,
      args.remoteCommand,
    ];
    const sshProc = spawn('sshpass', sshArgs, {
      env: { ...process.env, SSHPASS: cfg.password },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const localProc = spawn(args.localCommand, args.localArgs, {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    sshProc.stdout.pipe(localProc.stdin);

    // Stall-watchdog: каждые N секунд проверяем, был ли активность.
    // Если нет — поднимаем флаг stalled, kill'аем субпроцессы. Это даёт
    // явную ошибку вместо 6-часового таймаута на «зависшем» pipe.
    const STALL_DEFAULT_MS = 10 * 60 * 1000; // 10 минут
    const stallMs = args.stallTimeoutMs === undefined ? STALL_DEFAULT_MS : args.stallTimeoutMs;
    let lastActivityAt = Date.now();
    let stalled = false;
    const bumpActivity = () => { lastActivityAt = Date.now(); };

    let stderrBuf = '';
    // ВАЖНО: stdout у sshProc пайпится напрямую в localProc.stdin (без 'data'),
    // поэтому мы не видим bytes здесь. Слушаем 'data' КАК ДОПОЛНИТЕЛЬНЫЙ
    // listener — он не нарушает pipe, но даёт нам факт активности.
    sshProc.stdout.on('data', () => bumpActivity());
    sshProc.stderr.on('data', (chunk) => {
      bumpActivity();
      const s = chunk.toString();
      stderrBuf += s;
      if (args.onLog) args.onLog(`[ssh-stderr] ${s.trimEnd()}`);
    });
    localProc.stderr.on('data', (chunk) => {
      bumpActivity();
      const s = chunk.toString();
      stderrBuf += s;
      if (args.onLog) args.onLog(`[local-stderr] ${s.trimEnd()}`);
    });
    localProc.stdout.on('data', (chunk) => {
      bumpActivity();
      if (args.onLog) args.onLog(`[local] ${chunk.toString().trimEnd()}`);
    });

    let timer: NodeJS.Timeout | null = null;
    if (args.timeoutMs) {
      timer = setTimeout(() => {
        sshProc.kill('SIGTERM');
        localProc.kill('SIGTERM');
      }, args.timeoutMs);
    }
    let stallTimer: NodeJS.Timeout | null = null;
    if (stallMs > 0) {
      stallTimer = setInterval(() => {
        const idleMs = Date.now() - lastActivityAt;
        if (idleMs >= stallMs) {
          stalled = true;
          if (args.onLog) {
            args.onLog(
              `  ⚠ STALL: pipe не передаёт данные ${Math.round(idleMs / 1000)}s — kill ssh+mariadb`,
            );
          }
          try { sshProc.kill('SIGTERM'); } catch { /* dead */ }
          try { localProc.kill('SIGTERM'); } catch { /* dead */ }
          // Через 5s — добиваем SIGKILL
          setTimeout(() => {
            try { sshProc.kill('SIGKILL'); } catch { /* dead */ }
            try { localProc.kill('SIGKILL'); } catch { /* dead */ }
          }, 5_000);
        }
      }, Math.max(5_000, Math.floor(stallMs / 10)));
    }
    // Soft-cancel watcher: оператор нажал «Отменить» в UI — мастер дёрнул
    // migrate:hostpanel:cancel, агент поднял токен. Здесь — самой длинной
    // стадии (mysqldump 6 ч) даём прервать pipe.
    let cancelTimer: NodeJS.Timeout | null = null;
    if (args.isCancelled) {
      cancelTimer = setInterval(() => {
        if (args.isCancelled?.()) {
          if (args.onLog) args.onLog('  ⚠ cancel-token поднят — SIGTERM ssh+mariadb');
          try { sshProc.kill('SIGTERM'); } catch { /* dead */ }
          try { localProc.kill('SIGTERM'); } catch { /* dead */ }
          setTimeout(() => {
            try { sshProc.kill('SIGKILL'); } catch { /* dead */ }
            try { localProc.kill('SIGKILL'); } catch { /* dead */ }
          }, 5_000);
        }
      }, 2_000);
    }

    let sshExited = false;
    let localExited = false;
    let sshCode: number | null = null;
    let localCode: number | null = null;

    const tryFinish = () => {
      if (!sshExited || !localExited) return;
      if (timer) clearTimeout(timer);
      if (cancelTimer) clearInterval(cancelTimer);
      if (stallTimer) clearInterval(stallTimer);
      // Если был stall — выдаём ненулевой exit с понятной ошибкой,
      // даже если по факту ssh/mariadb получили SIGTERM и завершились
      // с кодом 0 (что иногда случается при graceful-shutdown'е).
      if (stalled) {
        resolve({
          exitCode: 124, // 124 — конвенция timeout(1)
          stderr: stderrBuf + `\n[stall] pipe не передавал данные ${Math.round((args.stallTimeoutMs ?? STALL_DEFAULT_MS) / 1000)}s, аборт`,
        });
        return;
      }
      const exit = (sshCode ?? 0) || (localCode ?? 0);
      resolve({ exitCode: exit, stderr: stderrBuf });
    };

    sshProc.on('exit', (code) => {
      sshExited = true;
      sshCode = code ?? 1;
      try {
        localProc.stdin.end();
      } catch { /* ignore */ }
      tryFinish();
    });
    sshProc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (stallTimer) clearInterval(stallTimer);
      if (cancelTimer) clearInterval(cancelTimer);
      reject(err);
    });
    localProc.on('exit', (code) => {
      localExited = true;
      localCode = code ?? 1;
      tryFinish();
    });
    localProc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (stallTimer) clearInterval(stallTimer);
      if (cancelTimer) clearInterval(cancelTimer);
      reject(err);
    });
  });
}

/**
 * Двухстадийный transfer: stage 1 — `ssh src "mysqldump | gzip" > local-file`.
 *
 * Зачем не pipe (`ssh ... | mariadb`): живой pipe ломается, если SSH
 * умирает посередине (NAT, потеря пакета, перегрузка ssh-сервера на
 * источнике). Пользователь получает фриз без ошибки на десятки минут.
 * Здесь — пишем gzip-файл на slave, потом отдельной командой импорт.
 * Если упал dump — повторяем только dump. Если упал import — повторяем
 * import без повторного dump (опционально, по `keepExistingFile`).
 *
 * Возвращает: exitCode, stderr, bytesWritten (размер gzip-файла на диске).
 */
export interface DumpToFileArgs {
  ssh: SshSourceBridge;
  remoteCommand: string;          // mysqldump-команда (gzip добавим автоматически)
  outputPath: string;             // куда писать .sql.gz на slave
  onLog?: (line: string) => void;
  /** Hard timeout (по дефолту 6 ч). */
  timeoutMs?: number;
  /**
   * Stall: если за это время файл НЕ растёт И от ssh stderr нет данных —
   * SIGTERM. По дефолту 600s (10 мин).
   */
  stallTimeoutMs?: number;
  isCancelled?: () => boolean;
  /** Уровень gzip на удалённой стороне (1 = быстрый). По дефолту 1. */
  gzipLevel?: number;
}

export function dumpToFile(args: DumpToFileArgs): Promise<{
  exitCode: number;
  stderr: string;
  bytesWritten: number;
}> {
  return new Promise((resolve, reject) => {
    // assertSourceCommandReadOnly уже разрешает gzip — он не в forbidden bins.
    const gzipLevel = args.gzipLevel ?? 1;
    const fullRemote = `${args.remoteCommand} | gzip -${gzipLevel}`;
    try {
      assertSourceCommandReadOnly(fullRemote);
    } catch (e) {
      reject(e as Error);
      return;
    }
    const cfg = args.ssh.getConfig();
    const sshArgs = [
      '-e',
      'ssh',
      ...SSH_OPTS,
      '-p',
      String(cfg.port),
      `${cfg.user}@${cfg.host}`,
      fullRemote,
    ];
    const sshProc = spawn('sshpass', sshArgs, {
      env: { ...process.env, SSHPASS: cfg.password },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Открываем выходной файл-стрим (создаём заново, не append).
    let fileStream: WriteStream;
    try {
      fileStream = createWriteStream(args.outputPath, { flags: 'w', mode: 0o600 });
    } catch (e) {
      try { sshProc.kill('SIGKILL'); } catch { /* dead */ }
      reject(e as Error);
      return;
    }

    const STALL_DEFAULT_MS = 10 * 60 * 1000;
    const stallMs = args.stallTimeoutMs === undefined ? STALL_DEFAULT_MS : args.stallTimeoutMs;
    let bytesWritten = 0;
    let lastBytes = 0;
    let lastActivityAt = Date.now();
    let stalled = false;
    const bumpActivity = () => { lastActivityAt = Date.now(); };

    let stderrBuf = '';

    // ─────────────────────────────────────────────────────────────────
    // ВАЖНО: корректное резолвлен­ие промиса.
    // Раньше 'close' листенер на fileStream вешался ВНУТРИ sshProc.on('exit'),
    // и если pipe() уже завершил запись (event 'close' прошёл до 'exit') —
    // листенер привязывался к уже-выгоревшему стриму и Promise висел навсегда.
    // Это и был баг "зависло на db-dump-import" — ssh завершился, файл закрыт,
    // но Promise не зарезолвился, миграция стояла в стейдже до бесконечности.
    //
    // Фикс: вешаем листенер ОДИН раз, заранее, до старта pipe. И финализируем
    // через флаг-паттерн: ждём ОБОИХ — exit процесса И close файла.
    // ─────────────────────────────────────────────────────────────────
    let resolved = false;
    let sshExited = false;
    let fileClosed = false;
    let sshExitCode: number | null = null;

    let timer: NodeJS.Timeout | null = null;
    let stallTimer: NodeJS.Timeout | null = null;
    let progressTimer: NodeJS.Timeout | null = null;
    let cancelTimer: NodeJS.Timeout | null = null;
    let safetyTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (cancelTimer) clearInterval(cancelTimer);
      if (stallTimer) clearInterval(stallTimer);
      if (progressTimer) clearInterval(progressTimer);
      if (safetyTimer) clearTimeout(safetyTimer);
    };

    const finalize = () => {
      if (resolved) return;
      if (!sshExited || !fileClosed) return;
      resolved = true;
      cleanup();
      if (stalled) {
        resolve({
          exitCode: 124,
          stderr: stderrBuf + `\n[stall] dump-file не рос ${Math.round((args.stallTimeoutMs ?? STALL_DEFAULT_MS) / 1000)}s, аборт`,
          bytesWritten,
        });
        return;
      }
      resolve({ exitCode: sshExitCode ?? 1, stderr: stderrBuf, bytesWritten });
    };

    fileStream.on('close', () => {
      fileClosed = true;
      finalize();
    });
    fileStream.on('error', (err) => {
      if (args.onLog) args.onLog(`[file-stream-error] ${err.message}`);
      fileClosed = true;
      finalize();
    });

    sshProc.stdout.pipe(fileStream);

    sshProc.stdout.on('data', (chunk: Buffer) => {
      bytesWritten += chunk.length;
      bumpActivity();
    });
    sshProc.stdout.on('error', (err) => {
      if (args.onLog) args.onLog(`[ssh-stdout-error] ${err.message}`);
    });
    sshProc.stderr.on('data', (chunk: Buffer) => {
      bumpActivity();
      const s = chunk.toString();
      stderrBuf += s;
      if (args.onLog) args.onLog(`[ssh-stderr] ${s.trimEnd()}`);
    });
    sshProc.stderr.on('error', () => { /* ignore — стрим закрылся */ });

    if (args.timeoutMs) {
      timer = setTimeout(() => {
        try { sshProc.kill('SIGTERM'); } catch { /* dead */ }
      }, args.timeoutMs);
    }
    if (stallMs > 0) {
      stallTimer = setInterval(() => {
        const idleMs = Date.now() - lastActivityAt;
        if (idleMs >= stallMs) {
          stalled = true;
          if (args.onLog) {
            args.onLog(
              `  ⚠ STALL: dump→file не растёт ${Math.round(idleMs / 1000)}s — kill ssh`,
            );
          }
          try { sshProc.kill('SIGTERM'); } catch { /* dead */ }
          setTimeout(() => {
            try { sshProc.kill('SIGKILL'); } catch { /* dead */ }
          }, 5_000);
        }
      }, Math.max(5_000, Math.floor(stallMs / 10)));
    }
    // Лог прогресса каждые 15s — чтобы оператор видел что процесс жив.
    progressTimer = setInterval(() => {
      if (bytesWritten !== lastBytes && args.onLog) {
        const mb = (bytesWritten / 1024 / 1024).toFixed(1);
        const delta = ((bytesWritten - lastBytes) / 1024 / 1024).toFixed(1);
        args.onLog(`  dump→file: ${mb} MB (+${delta} MB за 15s)`);
        lastBytes = bytesWritten;
      }
    }, 15_000);

    if (args.isCancelled) {
      cancelTimer = setInterval(() => {
        if (args.isCancelled?.()) {
          if (args.onLog) args.onLog('  ⚠ cancel-token поднят — SIGTERM ssh');
          try { sshProc.kill('SIGTERM'); } catch { /* dead */ }
          setTimeout(() => {
            try { sshProc.kill('SIGKILL'); } catch { /* dead */ }
          }, 5_000);
        }
      }, 2_000);
    }

    sshProc.on('exit', (code) => {
      sshExited = true;
      sshExitCode = code;
      // Принудительно завершаем fileStream — если pipe не успел вызвать
      // end() (например, при kill -9), close на нём НЕ прилетит, и promise
      // навсегда зависнет. end() безопасно вызывать повторно.
      try { fileStream.end(); } catch { /* dead */ }
      // Safety net: если 'close' на fileStream не прилетит за 30s после
      // exit (что-то совсем сломалось — sigkill в момент write, broken fd),
      // принудительно destroy() и финализируем сами. Лучше отдать ошибку
      // оператору, чем висеть бесконечно.
      safetyTimer = setTimeout(() => {
        if (resolved || fileClosed) return;
        if (args.onLog) {
          args.onLog('  ⚠ fileStream не закрылся за 30s после ssh exit — force destroy');
        }
        try { fileStream.destroy(); } catch { /* dead */ }
        fileClosed = true;
        finalize();
      }, 30_000);
      finalize();
    });
    sshProc.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      try { fileStream.destroy(); } catch { /* dead */ }
      reject(err);
    });
  });
}

/**
 * Stage 2 двухстадийного transfer: распаковываем .sql.gz в tmp-файл и
 * импортируем через `mariadb -e "SOURCE /tmp/...sql"`.
 *
 * Почему НЕ `gunzip -c | mariadb` через stdin-pipe: mariadb-client при
 * чтении из non-tty stdin парсит SQL чанками по `net_buffer_length`
 * (16KB по умолчанию), и на больших single-statement'ах (>16KB —
 * например, MODX-сниппеты с PHP-кодом 20KB+) ломает парсинг рандомно
 * на границе чанка → ERROR 1064 на ровном INSERT'е, который через
 * `SOURCE` импортируется без проблем. Воспроизводилось 4 из 5 раз.
 *
 * Фикс: файл целиком на диск → `SOURCE` его читает сам по `;`-границам,
 * без пайповых артефактов. Цена — пиковый disk usage x2 (gz + sql),
 * но `/var/lib/meowbox-migration/` для этого и есть.
 *
 * Stall-watchdog 10 мин: если gunzip или mariadb молчит — прибиваем.
 */
export interface ImportFromGzFileArgs {
  inputPath: string;          // путь к .sql.gz на slave
  localCommand: string;       // mariadb / mysql
  localArgs: string[];        // флаги без `<db>` в конце; `<db>` агент добавит сам
  onLog?: (line: string) => void;
  timeoutMs?: number;
  stallTimeoutMs?: number;
  isCancelled?: () => boolean;
}

export async function importFromGzFile(args: ImportFromGzFileArgs): Promise<{
  exitCode: number;
  stderr: string;
}> {
  // Stage 2a: распаковка .sql.gz → .sql на тот же том (рядом с .gz).
  const sqlPath = args.inputPath.endsWith('.gz')
    ? args.inputPath.slice(0, -3)
    : `${args.inputPath}.sql`;

  if (args.onLog) args.onLog(`  Stage 2a: gunzip → ${sqlPath}`);
  const unzipRes = await runGunzipToFile({
    inputPath: args.inputPath,
    outputPath: sqlPath,
    onLog: args.onLog,
    timeoutMs: 10 * 60 * 1000, // 10 мин на распаковку — даже 1GB gz укладывается
    isCancelled: args.isCancelled,
  });
  if (unzipRes.exitCode !== 0) {
    // Если gunzip упал — файл всё равно пробуем удалить.
    await fs.unlink(sqlPath).catch(() => {});
    return {
      exitCode: unzipRes.exitCode,
      stderr: `gunzip failed: ${unzipRes.stderr}`,
    };
  }

  // Stage 2b: mariadb -e "SOURCE <file>" — БЕЗ stdin-pipe, чтобы парсер
  // не ломался на длинных INSERT'ах. SOURCE — clientside-команда, читает
  // файл сам и шлёт server'у statement-за-statement'ом.
  if (args.onLog) args.onLog(`  Stage 2b: mariadb SOURCE ${sqlPath}`);
  // Защита от метасимволов в пути (теоретически нет, но на всякий —
  // экранируем `'` через mariadb-syntax: внутри SOURCE кавычки не нужны
  // если в пути нет пробелов/спецсимволов; используем pure path).
  const sourceCmd = `SOURCE ${sqlPath};`;
  const finalArgs = [...args.localArgs, '-e', sourceCmd];

  try {
    return await runLocalMariadbExec({
      command: args.localCommand,
      argv: finalArgs,
      onLog: args.onLog,
      timeoutMs: args.timeoutMs,
      stallTimeoutMs: args.stallTimeoutMs,
      isCancelled: args.isCancelled,
    });
  } finally {
    // Распакованный .sql удаляем всегда — он 5-10x больше gz, не оставляем
    // мусор. Оригинальный .gz остаётся (за него отвечает caller через
    // keepDumpOnFailure).
    await fs.unlink(sqlPath).catch(() => {});
  }
}

interface GunzipToFileArgs {
  inputPath: string;
  outputPath: string;
  onLog?: (line: string) => void;
  timeoutMs?: number;
  isCancelled?: () => boolean;
}

function runGunzipToFile(args: GunzipToFileArgs): Promise<{
  exitCode: number;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    // gunzip -c <gz> > <out> — пишем через redirect на дескриптор файла,
    // никакого pipe в Node-сторону. gunzip сам пишет на диск.
    const outFd = openSync(args.outputPath, 'w');
    const proc = spawn('gunzip', ['-c', args.inputPath], {
      stdio: ['ignore', outFd, 'pipe'],
    });

    let stderrBuf = '';
    let resolved = false;
    let timer: NodeJS.Timeout | null = null;
    let cancelTimer: NodeJS.Timeout | null = null;

    proc.stderr?.on('data', (chunk: Buffer) => {
      const s = chunk.toString();
      if (stderrBuf.length < 64 * 1024) stderrBuf += s;
      if (args.onLog) args.onLog(`[gunzip-stderr] ${s.trimEnd()}`);
    });

    if (args.timeoutMs) {
      timer = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch { /* dead */ }
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* dead */ }
        }, 5_000);
      }, args.timeoutMs);
    }
    if (args.isCancelled) {
      cancelTimer = setInterval(() => {
        if (args.isCancelled?.()) {
          if (args.onLog) args.onLog('  ⚠ cancel-token поднят — SIGTERM gunzip');
          try { proc.kill('SIGTERM'); } catch { /* dead */ }
        }
      }, 2_000);
    }

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (cancelTimer) clearInterval(cancelTimer);
      try { closeSync(outFd); } catch { /* already closed */ }
    };

    proc.on('exit', (code) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({ exitCode: code ?? 1, stderr: stderrBuf });
    });
    proc.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(err);
    });
  });
}

interface RunLocalArgs {
  command: string;
  argv: string[];
  onLog?: (line: string) => void;
  timeoutMs?: number;
  stallTimeoutMs?: number;
  isCancelled?: () => boolean;
}

function runLocalMariadbExec(args: RunLocalArgs): Promise<{
  exitCode: number;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const localProc = spawn(args.command, args.argv, {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'], // НЕ pipe stdin — чтобы парсер не ломался
    });

    const STALL_DEFAULT_MS = 10 * 60 * 1000;
    const stallMs = args.stallTimeoutMs === undefined ? STALL_DEFAULT_MS : args.stallTimeoutMs;
    let lastActivityAt = Date.now();
    let stalled = false;
    const bumpActivity = () => { lastActivityAt = Date.now(); };

    let stderrBuf = '';
    localProc.stderr.on('data', (chunk: Buffer) => {
      bumpActivity();
      const s = chunk.toString();
      // Cap stderr buffer at 256KB чтобы не сожрать RAM на болтливых ошибках
      if (stderrBuf.length < 256 * 1024) stderrBuf += s;
      if (args.onLog) args.onLog(`[local-stderr] ${s.trimEnd()}`);
    });
    localProc.stdout.on('data', (chunk: Buffer) => {
      bumpActivity();
      if (args.onLog) args.onLog(`[local] ${chunk.toString().trimEnd()}`);
    });

    let timer: NodeJS.Timeout | null = null;
    let stallTimer: NodeJS.Timeout | null = null;
    let cancelTimer: NodeJS.Timeout | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;

    if (args.timeoutMs) {
      timer = setTimeout(() => {
        try { localProc.kill('SIGTERM'); } catch { /* dead */ }
        setTimeout(() => {
          try { localProc.kill('SIGKILL'); } catch { /* dead */ }
        }, 5_000);
      }, args.timeoutMs);
    }
    if (stallMs > 0) {
      stallTimer = setInterval(() => {
        const idleMs = Date.now() - lastActivityAt;
        if (idleMs >= stallMs) {
          stalled = true;
          if (args.onLog) {
            args.onLog(
              `  ⚠ STALL: mariadb молчит ${Math.round(idleMs / 1000)}s — kill`,
            );
          }
          try { localProc.kill('SIGTERM'); } catch { /* dead */ }
          setTimeout(() => {
            try { localProc.kill('SIGKILL'); } catch { /* dead */ }
          }, 5_000);
        }
      }, Math.max(5_000, Math.floor(stallMs / 10)));
    }
    // Heartbeat: SOURCE-импорт молча работает (никакого stdout per-INSERT),
    // оператор должен видеть что процесс жив.
    heartbeatTimer = setInterval(() => {
      const idleMs = Date.now() - lastActivityAt;
      if (args.onLog) {
        args.onLog(`  import: mariadb работает (idle ${Math.round(idleMs / 1000)}s)`);
      }
    }, 60_000);

    if (args.isCancelled) {
      cancelTimer = setInterval(() => {
        if (args.isCancelled?.()) {
          if (args.onLog) args.onLog('  ⚠ cancel-token поднят — SIGTERM mariadb');
          try { localProc.kill('SIGTERM'); } catch { /* dead */ }
          setTimeout(() => {
            try { localProc.kill('SIGKILL'); } catch { /* dead */ }
          }, 5_000);
        }
      }, 2_000);
    }

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (cancelTimer) clearInterval(cancelTimer);
      if (stallTimer) clearInterval(stallTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    };

    let resolved = false;
    localProc.on('exit', (code) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      if (stalled) {
        resolve({
          exitCode: 124,
          stderr: stderrBuf + `\n[stall] mariadb не двигался ${Math.round((args.stallTimeoutMs ?? STALL_DEFAULT_MS) / 1000)}s, аборт`,
        });
        return;
      }
      resolve({ exitCode: code ?? 1, stderr: stderrBuf });
    });
    localProc.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(err);
    });
  });
}

/** Создание .my.cnf на slave для импорта без пароля в argv. Возвращает путь tmp-файла. */
export async function writeMysqlOptsFile(opts: {
  user: string;
  password: string;
  host?: string;
  port?: number;
}): Promise<string> {
  const tmpFile = path.join(os.tmpdir(), `meowbox-mysql-${Date.now()}-${process.pid}.cnf`);
  const content = [
    '[client]',
    `user=${opts.user}`,
    `password=${opts.password}`,
    opts.host ? `host=${opts.host}` : '',
    opts.port ? `port=${opts.port}` : '',
    '',
  ].filter(Boolean).join('\n');
  await fs.writeFile(tmpFile, content, { mode: 0o600 });
  return tmpFile;
}
