import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execFileAsync = promisify(execFile);

/**
 * Secure command executor.
 * - Uses execFile (not exec/shell) to prevent command injection
 * - Validates all commands against an allowlist
 * - Enforces timeouts on all operations
 * - Runs with minimal privileges where possible
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
  ]);

  // Accept versioned binaries like php8.2, php8.3, composer2
  private static readonly VERSIONED_PATTERN = /^(php|composer)\d[\d.]*$/;

  private static readonly DEFAULT_TIMEOUT =
    Number(process.env.COMMAND_DEFAULT_TIMEOUT_MS) || 60_000; // 60 seconds
  // 30 минут — MODX 3 cli-install.php и composer install на слабых VPS
  // могут легко занимать 10+ минут. Раньше ставили 10 мин — упирались в таймаут.
  private static readonly MAX_TIMEOUT =
    Number(process.env.COMMAND_MAX_TIMEOUT_MS) || 1_800_000; // 30 minutes

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
    } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // Validate command against allowlist
    const basename = path.basename(command);
    if (
      !CommandExecutor.ALLOWED_COMMANDS.has(basename) &&
      !CommandExecutor.VERSIONED_PATTERN.test(basename)
    ) {
      throw new Error(`Command not allowed: ${basename}`);
    }

    // Sudo: реальный бинарь — это первый non-flag аргумент. Проверяем его
    // против allowlist'а тоже — иначе sudo bash/sh/python/что-угодно бы пролез.
    if (basename === 'sudo') {
      const sudoTarget = this.resolveSudoTarget(args);
      if (!sudoTarget) {
        throw new Error('sudo: target binary not found in args');
      }
      if (
        !CommandExecutor.ALLOWED_COMMANDS.has(sudoTarget) &&
        !CommandExecutor.VERSIONED_PATTERN.test(sudoTarget)
      ) {
        throw new Error(`sudo target not allowed: ${sudoTarget}`);
      }
    }

    // Sanitize arguments — reject shell metacharacters in non-SQL args.
    // execFile bypasses shell so most characters are safe, но:
    //   - \n/\r/\0 могут сломать инструменты, парсящие argv построчно
    //     (crontab, визор,  сервисные скрипты вроде MODX cli-install) —
    //     блокируем их всегда.
    //   - shell-метасимволы (;&|`{}) блокируем как layered defense.
    // SQL через -e/-c пропускаем — там SQL-синтаксис легитимен.
    // unsafeShellMetaArgs пропускаем — это аргумент-команда для удалённого
    // shell (sshpass+ssh), локальный exec её не интерпретирует.
    this.validateArgs(
      args,
      options.unsafeShellMetaArgs ? new Set(options.unsafeShellMetaArgs) : undefined,
    );

    const timeout = Math.min(
      options.timeout || CommandExecutor.DEFAULT_TIMEOUT,
      CommandExecutor.MAX_TIMEOUT,
    );

    try {
      const mergedEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ...options.env,
        // Prevent locale-dependent output
        LC_ALL: 'C',
        LANG: 'C',
      };
      // Гарантируем, что useradd/usermod/userdel/groupadd (live в /usr/sbin)
      // найдутся даже если PM2 запустил агент с урезанным PATH.
      mergedEnv.PATH = CommandExecutor.buildPath(mergedEnv.PATH);

      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: options.cwd,
        timeout,
        maxBuffer: CommandExecutor.MAX_BUFFER_BYTES,
        env: mergedEnv,
      });

      return { stdout, stderr, exitCode: 0 };
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; code?: number | string };
      return {
        stdout: error.stdout || '',
        stderr: error.stderr || (err as Error).message,
        exitCode: typeof error.code === 'number' ? error.code : 1,
      };
    }
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
    } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const basename = path.basename(command);
    if (
      !CommandExecutor.ALLOWED_COMMANDS.has(basename) &&
      !CommandExecutor.VERSIONED_PATTERN.test(basename)
    ) {
      throw new Error(`Command not allowed: ${basename}`);
    }
    if (basename === 'sudo') {
      const sudoTarget = this.resolveSudoTarget(args);
      if (!sudoTarget) {
        throw new Error('sudo: target binary not found in args');
      }
      if (
        !CommandExecutor.ALLOWED_COMMANDS.has(sudoTarget) &&
        !CommandExecutor.VERSIONED_PATTERN.test(sudoTarget)
      ) {
        throw new Error(`sudo target not allowed: ${sudoTarget}`);
      }
    }
    this.validateArgs(args);

    const timeout = Math.min(
      options.timeout || CommandExecutor.DEFAULT_TIMEOUT,
      CommandExecutor.MAX_TIMEOUT,
    );

    const onLine = options.onLine || (() => {});

    // По умолчанию оставляем прежнее поведение (stdin наследуется), но
    // для долгих скриптов, где нельзя допустить hang на readline, ставим ignore.
    const stdinMode = options.stdin || 'inherit';
    return new Promise((resolve) => {
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
      });

      let stdoutBuf = '';
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
        if (!discardBuf) stdoutBuf += s;
        stdoutTail = flushChunk(s, stdoutTail, 'stdout');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const s = chunk.toString('utf8');
        // stderr всегда пишем в buffer (там обычно мало и нужен для диагностики).
        // Но обрезаем до 64КБ, чтобы не сожрать RAM на «болтливых» командах.
        if (stderrBuf.length < 64 * 1024) stderrBuf += s;
        stderrTail = flushChunk(s, stderrTail, 'stderr');
      });

      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, timeout);

      child.on('error', (err) => {
        clearTimeout(timer);
        // Сбрасываем остатки.
        if (stdoutTail.trim()) onLine(stdoutTail.trim(), 'stdout');
        if (stderrTail.trim()) onLine(stderrTail.trim(), 'stderr');
        resolve({
          stdout: stdoutBuf,
          stderr: stderrBuf + (err as Error).message,
          exitCode: 1,
        });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (stdoutTail.trim()) onLine(stdoutTail.trim(), 'stdout');
        if (stderrTail.trim()) onLine(stderrTail.trim(), 'stderr');
        resolve({
          stdout: stdoutBuf,
          stderr: stderrBuf,
          exitCode: typeof code === 'number' ? code : 1,
        });
      });
    });
  }
}
