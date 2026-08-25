import { spawn } from 'child_process';
import * as path from 'path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { childProcessRegistry } from './process-registry';

/**
 * Ошибка от внешней команды: непустой `exitCode`, плюс stdout/stderr и
 * имя команды для диагностики. Бросается из `execute()` / `executeStreaming()`
 * по умолчанию — чтобы `try/catch` ловил реальные ошибки, а callsite'ы
 * не забывали проверять `exitCode` руками. Если экспонента ошибки не нужна
 * (например, для `dpkg-query`, `which`, `is-active`) — передавай
 * `{ allowFailure: true }`, тогда метод вернёт результат с `exitCode`
 * вместо throw.
 */
export class CommandError extends Error {
  readonly command: string;
  readonly args: string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /**
   * Совместимость со старыми callsite'ами, которые читали `err.code` (числовой
   * или 'ETIMEDOUT'). Заполняется тем же значением, что и `exitCode`.
   */
  readonly code: number;

  constructor(params: {
    command: string;
    args: string[];
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut?: boolean;
  }) {
    const head = (params.stderr || params.stdout || '').slice(0, 500).trim();
    const suffix = head ? `: ${head}` : '';
    super(
      `Command '${path.basename(params.command)}' exited with code ${params.exitCode}${suffix}`,
    );
    this.name = 'CommandError';
    this.command = params.command;
    this.args = params.args;
    this.exitCode = params.exitCode;
    this.stdout = params.stdout;
    this.stderr = params.stderr;
    this.timedOut = params.timedOut === true;
    this.code = params.exitCode;
  }
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Secure command executor.
 * - Uses execFile (not exec/shell) to prevent command injection
 * - Validates all commands against an allowlist
 * - Enforces timeouts on all operations
 * - Runs with minimal privileges where possible
 *
 * **Контракт:** методы `execute` и `executeStreaming` бросают `CommandError`
 * при non-zero exit code (как обычно делает `child_process.execFile`).
 * Если код ожидает ненулевой exit как валидный результат (`which`,
 * `dpkg-query`, `systemctl is-active`, `id` и т.п.) — нужно передать
 * `{ allowFailure: true }`, тогда метод вернёт `{ stdout, stderr, exitCode }`
 * без исключения.
 */
export class CommandExecutor {
  private static readonly ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
    'nginx',
    'systemctl',
    'certbot',
    'pm2',
    'git',
    'tar',
    'mysqldump',
    'mysql',
    'mariadb-dump',
    'mariadb',
    'pg_dump',
    'psql',
    'php',
    'composer',
    'npm',
    'yarn',
    'pnpm',
    'node',
    // make — для блока «Быстрый доступ»: запуск make-таргетов сайта. Имя
    // таргета валидируется отдельно (NODE_TARGET_REGEX), запуск — от имени
    // системного пользователя сайта через sudo -u.
    'make',
    'ufw',
    'df',
    'free',
    'uptime',
    'curl',
    'wget',
    'unzip',
    'cat',
    'ls',
    'mkdir',
    'rm',
    'cp',
    'mv',
    'chmod',
    'chown',
    'crontab',
    'journalctl',
    'tail',
    'sudo',
    'useradd',
    'userdel',
    'usermod',
    'groupadd',
    'id',
    'gpasswd',
    'openssl',
    'apt-get',
    'apt-cache',
    'add-apt-repository',
    'dpkg',
    'dpkg-query',
    'phpenmod',
    'phpdismod',
    'redis-server',
    'redis-cli',
    // Managed S3-compatible object storage.
    'minio',
    'mc',
    'ps',
    'du',
    'wc',
    'rsync',
    'restic',
    'diff',
    'which',
    // SSH-семейство — нужно для миграции hostpanel: agent на slave подключается
    // к источнику по SSH, гонит mysqldump через `ssh src "mysqldump ..."` и
    // rsync с `-e "ssh -p X ..."` или `-e "sshpass -e ssh ..."`. Безопасность —
    // через FORBIDDEN_CHARS + per-аргумент валидацию в migration handler'е.
    'ssh',
    'sshpass',
    'scp',
    // tee — для атомарного добавления конфигов certbot/manticore с stdin (через
    // pipe, без shell). Нужен миграцией hostpanel при копировании Let's Encrypt.
    'tee',
    // ln — создание/переподтыкание симлинков (LE archive→live, certbot rename).
    'ln',
    // find — фильтрация файлов при rsync-исключениях, du-расчётах, audit'ах.
    'find',
    // pkill — закрытие зависших ssh-сессий по таймауту в migration cancel.
    'pkill',
    // sed — патчинг MODX config.core.php (замена путей при миграции).
    'sed',
    // realpath — резолв симлинков перед безопасными rm/chown в миграции.
    'realpath',
    // VPN: xray-core (VLESS+Reality) и AmneziaWG.
    // См. docs/specs/2026-05-09-vpn-management.md.
    'xray',
    'awg',
    'awg-quick',
    // sysctl нужен для apply ip_forward после смены /etc/sysctl.d/.
    'sysctl',
    // ip — для определения egress-интерфейса при NAT MASQUERADE в AmneziaWG.
    'ip',
    // ss — проверка занятости порта перед install сервиса.
    'ss',
    // Country-block: ipset/iptables/ip6tables — server-level GeoIP-блокировка
    // через netfilter. netfilter-persistent — сохранение правил через reboot.
    'ipset',
    'iptables',
    'ip6tables',
    'netfilter-persistent',
    // sshd — нужен для `sshd -t -f <file>` валидации конфига перед записью.
    // Сам по себе ничего не меняет.
    'sshd',
    // fail2ban-client — для status/reload/unban команд (`fail2ban-client status`).
    'fail2ban-client',
    // Postfix-семейство: debconf-set-selections — preseed для unattended apt install,
    // postmap — компиляция .db из sasl_passwd/generic, newaliases — пересборка
    // /etc/aliases.db, sendmail — отправка тестового письма (через stdin pipe),
    // mail — альтернативный CLI для отправки.
    'debconf-set-selections',
    'postmap',
    'newaliases',
    'sendmail',
    'mail',
  ]);

  // Accept versioned binaries like php8.2, php8.3, composer2
  private static readonly VERSIONED_PATTERN = /^(php|composer)\d[\d.]*$/;

  private static readonly DEFAULT_TIMEOUT =
    Number(process.env.COMMAND_DEFAULT_TIMEOUT_MS) || 60_000; // 60 seconds
  // Durable package operations can legitimately exceed 30 minutes. Every
  // caller still supplies an action-specific timeout; this is only the ceiling.
  private static readonly MAX_TIMEOUT =
    Number(process.env.COMMAND_MAX_TIMEOUT_MS) || 14_400_000; // 4 hours

  // Буфер stdout/stderr. 10 МБ — перекрывает dump БД среднего сайта.
  // Для больших дампов пользовать streaming-API, а не execFile.
  private static readonly MAX_BUFFER_BYTES =
    Number(process.env.COMMAND_MAX_BUFFER_BYTES) || 10 * 1024 * 1024;

  /**
   * PM2/systemd часто запускают агент с урезанным PATH (без /usr/sbin и /sbin),
   * из-за чего useradd/usermod/userdel/groupadd валятся с `spawn ENOENT`.
   * Достраиваем PATH принудительно — добавляем sbin-директории, если их там нет.
   */
  private static buildPath(parentPath: string | undefined): string {
    const segments = (parentPath || '/usr/local/bin:/usr/bin:/bin').split(':');
    const required = ['/usr/local/sbin', '/usr/sbin', '/sbin'];
    for (const dir of required) {
      if (!segments.includes(dir)) segments.push(dir);
    }
    return segments.join(':');
  }

  async executeWithInput(
    command: string,
    args: string[],
    input: Readable,
    options: {
      cwd?: string;
      timeout?: number;
      env?: Record<string, string>;
      allowFailure?: boolean;
    } = {},
  ): Promise<CommandResult> {
    const basename = this.validateCommandInvocation(command, args);
    const timeout = Math.min(
      options.timeout || CommandExecutor.DEFAULT_TIMEOUT,
      CommandExecutor.MAX_TIMEOUT,
    );
    const mergedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...options.env,
      LC_ALL: 'C',
      LANG: 'C',
    };
    mergedEnv.PATH = CommandExecutor.buildPath(mergedEnv.PATH);
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: mergedEnv,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const handle = childProcessRegistry.track(
      child,
      `command-input:${basename}`,
      { processGroup: true },
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    let timedOut = false;
    let inputFailureName = '';
    const collect = (chunk: Buffer, chunks: Buffer[], bytes: number): number => {
      const remaining = CommandExecutor.MAX_BUFFER_BYTES - bytes;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      if (chunk.length > remaining && !overflow) {
        overflow = true;
        void handle.terminate(5_000);
      }
      return Math.min(CommandExecutor.MAX_BUFFER_BYTES, bytes + chunk.length);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes = collect(chunk, stdoutChunks, stdoutBytes);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes = collect(chunk, stderrChunks, stderrBytes);
    });
    const exit = new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(typeof code === 'number' ? code : 1));
    });
    const inputDone = pipeline(input, child.stdin).catch((error: unknown) => {
      inputFailureName = error instanceof Error ? error.name : 'Error';
      void handle.terminate(5_000);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      void handle.terminate(5_000);
    }, timeout);
    timer.unref();
    try {
      const [exitCode] = await Promise.all([exit, inputDone]);
      const stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8');
      const stderr = Buffer.concat(stderrChunks, stderrBytes).toString('utf8');
      const effectiveExitCode = timedOut ? 124 : exitCode;
      if (effectiveExitCode !== 0 || overflow || inputFailureName) {
        if (options.allowFailure && !overflow && !inputFailureName) {
          return { stdout, stderr, exitCode: effectiveExitCode };
        }
        throw new CommandError({
          command,
          args,
          exitCode: overflow ? 1 : effectiveExitCode,
          stdout,
          stderr: inputFailureName
            ? `${stderr}${stderr ? '\n' : ''}input stream failed (${inputFailureName})`
            : stderr,
          timedOut,
        });
      }
      return { stdout, stderr, exitCode: 0 };
    } finally {
      clearTimeout(timer);
      handle.untrack();
    }
  }

  /**
   * Runtime-проверка аргументов на опасные символы. Используется обоими
   * режимами (`execute` и `executeStreaming`) — дублировать регулярку
   * опасно, один inline-fix разъехался бы.
   */
  private validateArgs(args: string[], unsafeShellMetaArgs?: Set<number>): void {
    const sqlFlagArgs = new Set<number>();
    for (let i = 0; i < args.length; i++) {
      if ((args[i] === '-e' || args[i] === '-c') && i + 1 < args.length) {
        sqlFlagArgs.add(i + 1); // next arg is SQL — skip validation
      }
    }
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (typeof a !== 'string') {
        throw new Error('Argument must be a string');
      }
      // Управляющие символы — глобальный запрет, даже для SQL и unsafe-shell-args.
      // \n/\r ломают crontab/любые line-oriented tools, \0 обрывает строку.
      if (/[\x00\r\n]/.test(a)) {
        throw new Error('Argument contains control characters (NUL/CR/LF)');
      }
      if (sqlFlagArgs.has(i)) continue;
      // unsafeShellMetaArgs — индексы аргументов, которые идут как remote-shell
      // команда (например, последний arg к sshpass+ssh — он исполняется на
      // удалённом хосте, локальный exec их не интерпретирует). Caller обязан
      // самостоятельно проверить такие аргументы (assertSourceCommandReadOnly
      // и т.п.) — здесь мы пропускаем shell-meta запрет.
      if (unsafeShellMetaArgs?.has(i)) continue;
      // {} — НЕ блокируем: в execFile (без shell) это литералы. Нужны для
      // curl `-w '%{http_code}'` в verifyStage, awk/jq, MODX-серилизаций и т.п.
      // Реальная опасность только у shell-метасимволов: ; & | `
      if (/[;&|`]/.test(a)) {
        throw new Error(`Argument contains forbidden characters: ${a}`);
      }
    }
  }

  /**
   * Если первый команд — `sudo`, то реальный бинарь — это первый
   * non-flag аргумент (после `-u USER`, `-n`, и т.п.). Без рекурсивной
   * проверки allowlist'а атакующий, имея доступ к любому caller'у, передавшему
   * `executor.execute('sudo', [userInput, ...])`, мог бы запустить произвольный
   * бинарь от root (например `sudo bash -c ...`).
   *
   * Возвращает имя бинаря для проверки, или null если args пустой / sudo вызван
   * с одними флагами (что само по себе странно — пусть execFile упадёт).
   */
  private resolveSudoTarget(args: string[]): string | null {
    let i = 0;
    while (i < args.length) {
      const a = args[i];
      // Длинные флаги (--user=..., --non-interactive)
      if (a.startsWith('--')) { i++; continue; }
      // Короткие флаги, требующие значения
      if (a === '-u' || a === '-g' || a === '-h' || a === '-p' || a === '-D' || a === '-C') {
        i += 2; continue;
      }
      // Одиночные короткие флаги (-n, -i, -E, -H, -K, -k, -S, -s, -v и т.д.)
      if (a.startsWith('-') && a.length > 1) { i++; continue; }
      // Первый не-флаг — это и есть бинарь
      return path.basename(a);
    }
    return null;
  }

  private validateCommandInvocation(
    command: string,
    args: string[],
    unsafeShellMetaArgs?: Set<number>,
  ): string {
    const basename = path.basename(command);
    if (
      !CommandExecutor.ALLOWED_COMMANDS.has(basename) &&
      !CommandExecutor.VERSIONED_PATTERN.test(basename)
    ) throw new Error(`Command not allowed: ${basename}`);
    if (basename === 'sudo') {
      const sudoTarget = this.resolveSudoTarget(args);
      if (!sudoTarget) throw new Error('sudo: target binary not found in args');
      if (
        !CommandExecutor.ALLOWED_COMMANDS.has(sudoTarget) &&
        !CommandExecutor.VERSIONED_PATTERN.test(sudoTarget)
      ) throw new Error(`sudo target not allowed: ${sudoTarget}`);
    }
    this.validateArgs(args, unsafeShellMetaArgs);
    return basename;
  }

  /**
   * Execute a command safely using execFile (no shell interpretation).
   * The command must be in the allowlist.
   */
  async execute(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      timeout?: number;
      env?: Record<string, string>;
      /**
       * Индексы аргументов, для которых пропускаем проверку shell-метасимволов
       * (`;&|\`{}`). Используется для remote-shell команд (sshpass+ssh последний
       * arg) — там shell-операторы выполняются на удалённом хосте. Контрольные
       * символы (NUL/CR/LF) блокируются всегда, без исключений.
       */
      unsafeShellMetaArgs?: number[];
      /**
       * По умолчанию `execute` бросает `CommandError` при non-zero exit.
       * Если эта команда **ожидает** ненулевой exit как валидный сигнал
       * (например `which`, `dpkg-query`, `systemctl is-active`, `id`, `pgrep`),
       * передай `allowFailure: true` — тогда вернётся `{stdout,stderr,exitCode}`
       * вместо исключения.
       */
      allowFailure?: boolean;
    } = {},
  ): Promise<CommandResult> {
    const basename = this.validateCommandInvocation(
      command,
      args,
      options.unsafeShellMetaArgs ? new Set(options.unsafeShellMetaArgs) : undefined,
    );

    const timeout = Math.min(
      options.timeout || CommandExecutor.DEFAULT_TIMEOUT,
      CommandExecutor.MAX_TIMEOUT,
    );

    const mergedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...options.env,
      LC_ALL: 'C',
      LANG: 'C',
    };
    mergedEnv.PATH = CommandExecutor.buildPath(mergedEnv.PATH);

    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: mergedEnv,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const handle = childProcessRegistry.track(
        child,
        `command:${basename}`,
        { processGroup: true },
      );
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let overflow: 'stdout' | 'stderr' | null = null;
      let timedOut = false;
      let settled = false;

      const collect = (
        chunk: Buffer,
        chunks: Buffer[],
        currentBytes: number,
        stream: 'stdout' | 'stderr',
      ): number => {
        const remaining = CommandExecutor.MAX_BUFFER_BYTES - currentBytes;
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        if (chunk.length > remaining && !overflow) {
          overflow = stream;
          void handle.terminate(5_000);
        }
        return Math.min(CommandExecutor.MAX_BUFFER_BYTES, currentBytes + chunk.length);
      };
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes = collect(chunk, stdoutChunks, stdoutBytes, 'stdout');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes = collect(chunk, stderrChunks, stderrBytes, 'stderr');
      });

      const timer = setTimeout(() => {
        timedOut = true;
        void handle.terminate(5_000);
      }, timeout);
      timer.unref();

      const finish = (code: number, errorMessage = '') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        handle.untrack();
        const stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8');
        let stderr = Buffer.concat(stderrChunks, stderrBytes).toString('utf8');
        if (errorMessage && !stderr) stderr = errorMessage;
        if (overflow) stderr = `${stderr}\n${overflow} exceeded command output limit`.trim();
        const exitCode = timedOut ? 124 : overflow ? 1 : code;
        if (exitCode === 0 || options.allowFailure) {
          resolve({ stdout, stderr, exitCode });
          return;
        }
        reject(new CommandError({
          command,
          args,
          exitCode,
          stdout,
          stderr,
          timedOut,
        }));
      };
      child.once('error', (error) => finish(1, error.message));
      child.once('close', (code) => finish(typeof code === 'number' ? code : 1));
    });
  }

  /**
   * Execute a command with live line-by-line streaming of stdout/stderr.
   * Подходит для долгих процессов (composer, cli-install, setup) — каждая строка
   * прилетает в onLine сразу, а не копится в буфере до завершения, как у execFile.
   *
   * onLine(line, stream): вызывается на каждую строку. stream='stdout'|'stderr'.
   * Возвращает тот же формат, что и execute(), но без собранного stdout/stderr —
   * их должен накапливать вызывающий (если нужно).
   */
  async executeStreaming(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      timeout?: number;
      env?: Record<string, string>;
      onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
      // По умолчанию stdin наследуется от родителя. Для скриптов вроде
      // MODX cli-install.php это опасно: если они зовут readline()/fgets(STDIN),
      // child уходит в бесконечное ожидание ввода и ловит SIGKILL по таймауту.
      // stdin: 'ignore' закрывает STDIN — любые попытки прочитать вернут false/EOF.
      stdin?: 'ignore' | 'pipe' | 'inherit';
      // Если true — не накапливаем stdoutBuf/stderrBuf вообще (только onLine).
      // Нужно для команд, отдающих гигантский NDJSON (restic ls на больших репах):
      // вызывающий парсит строки в onLine и держит только то, что ему реально надо.
      // Возвращаемые stdout/stderr тогда будут пустыми строками.
      discardOutputBuffer?: boolean;
      /**
       * По умолчанию `executeStreaming` бросает `CommandError` при non-zero
       * exit (как и `execute`). Если caller хочет получить ненулевой код
       * без исключения (например, чтобы продолжить cleanup) — передай
       * `allowFailure: true`.
       */
      allowFailure?: boolean;
    } = {},
  ): Promise<CommandResult> {
    const basename = this.validateCommandInvocation(command, args);

    const timeout = Math.min(
      options.timeout || CommandExecutor.DEFAULT_TIMEOUT,
      CommandExecutor.MAX_TIMEOUT,
    );

    const onLine = options.onLine || (() => {});

    // По умолчанию оставляем прежнее поведение (stdin наследуется), но
    // для долгих скриптов, где нельзя допустить hang на readline, ставим ignore.
    const stdinMode = options.stdin || 'inherit';
    const allowFailure = options.allowFailure === true;
    return new Promise<CommandResult>((resolve, reject) => {
      const mergedEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ...options.env,
        LC_ALL: 'C',
        LANG: 'C',
      };
      mergedEnv.PATH = CommandExecutor.buildPath(mergedEnv.PATH);
      const child = spawn(command, args, {
        cwd: options.cwd,
        stdio: [stdinMode, 'pipe', 'pipe'],
        env: mergedEnv,
        detached: true,
      });
      const processHandle = childProcessRegistry.track(
        child,
        `command-stream:${basename}`,
        { processGroup: true },
      );

      let stdoutBuf = '';
      let stdoutBytes = 0;
      let stderrBuf = '';
      const discardBuf = options.discardOutputBuffer === true;
      // Частично набранные строки (последний кусок chunk'а без \n).
      let stdoutTail = '';
      let stderrTail = '';
      const MAX_LINE_LEN = 4_000; // защита от бесконечных строк

      const flushChunk = (
        chunk: string,
        tail: string,
        kind: 'stdout' | 'stderr',
      ): string => {
        const combined = tail + chunk;
        const lines = combined.split('\n');
        const newTail = lines.pop() || '';
        for (const rawLine of lines) {
          const line = rawLine.replace(/\r$/, '');
          if (line.length === 0) continue;
          // Срезаем ANSI escape — в UI они шумят.
          const clean = line.replace(/\x1b\[[0-9;]*m/g, '').slice(0, MAX_LINE_LEN);
          if (clean.trim().length > 0) onLine(clean, kind);
        }
        return newTail.length > MAX_LINE_LEN ? newTail.slice(-MAX_LINE_LEN) : newTail;
      };

      // stdout/stderr у нас всегда 'pipe' (см. stdio выше) — TS считает их
      // nullable из-за общего типа spawn, но фактически здесь они всегда есть.
      child.stdout?.on('data', (chunk: Buffer) => {
        const s = chunk.toString('utf8');
        if (!discardBuf && stdoutBytes < CommandExecutor.MAX_BUFFER_BYTES) {
          const remaining = CommandExecutor.MAX_BUFFER_BYTES - stdoutBytes;
          const accepted = chunk.subarray(0, remaining).toString('utf8');
          stdoutBuf += accepted;
          stdoutBytes += Buffer.byteLength(accepted, 'utf8');
        }
        stdoutTail = flushChunk(s, stdoutTail, 'stdout');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const s = chunk.toString('utf8');
        // stderr всегда пишем в buffer (там обычно мало и нужен для диагностики).
        // Но обрезаем до 64КБ, чтобы не сожрать RAM на «болтливых» командах.
        if (stderrBuf.length < 64 * 1024) stderrBuf += s;
        stderrTail = flushChunk(s, stderrTail, 'stderr');
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void processHandle.terminate(5_000);
      }, timeout);

      let settled = false;
      const finish = (
        exitCode: number,
        extraStderr = '',
      ) => {
        if (settled) return;
        settled = true;
        processHandle.untrack();
        const stderr = stderrBuf + extraStderr;
        if (exitCode === 0 || allowFailure) {
          resolve({ stdout: stdoutBuf, stderr, exitCode });
          return;
        }
        reject(new CommandError({
          command,
          args,
          exitCode: timedOut ? 124 : exitCode,
          stdout: stdoutBuf,
          stderr,
          timedOut,
        }));
      };

      child.on('error', (err) => {
        clearTimeout(timer);
        // Сбрасываем остатки.
        if (stdoutTail.trim()) onLine(stdoutTail.trim(), 'stdout');
        if (stderrTail.trim()) onLine(stderrTail.trim(), 'stderr');
        finish(1, (err as Error).message);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (stdoutTail.trim()) onLine(stdoutTail.trim(), 'stdout');
        if (stderrTail.trim()) onLine(stderrTail.trim(), 'stderr');
        finish(typeof code === 'number' ? code : 1);
      });
    });
  }
}
