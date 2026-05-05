/**
 * Смена / создание пароля администратора MODX через bootstrap MODX_API_MODE.
 *
 * Идея: MODX и в Revo, и в 3 умеет загружаться в режиме API (через
 * `define('MODX_API_MODE', true); require_once $base_path . '/index.php';`),
 * после чего из PHP можно дергать `$user->changePassword($password, '', false)`.
 * Это родной MODX-механизм — учитывает соль, hash-стратегию (PBKDF2 / sha1),
 * корректно сохраняет новый пароль вне зависимости от версии MODX.
 *
 * Самый простой и безопасный путь:
 *   1. На лету пишем .php-скрипт в /tmp с уникальным именем (0644).
 *   2. Запускаем `sudo -u <systemUser> phpX.Y /tmp/<...>.php <wwwDir> <user> <password>`
 *      — чтобы кэш / логи MODX, если бутстрап их затронет, остались под владельцем
 *      сайта, а не root.
 *   3. Парсим JSON, который скрипт печатает в stdout.
 *   4. Удаляем временный скрипт в finally.
 *
 * Пароль передаётся через argv (execFile, без shell) — никаких echo/cat/etc.
 * NUL/CR/LF в пароле блокирует CommandExecutor. Шелл-метасимволы (;&|`) для
 * этого аргумента пропускаем — execFile их не интерпретирует.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { CommandExecutor } from '../command-executor';
import { DEFAULT_PHP_VERSION } from '@meowbox/shared';

/**
 * Содержимое PHP-скрипта. Вынесено сюда, чтобы не зависеть от файловой
 * раскладки релиза (assets/) — компилируется в dist/installer/modx-admin-pass.js
 * как обычный JS-литерал и доступно сразу после tsc.
 *
 * Формат вывода (одна строка):
 *   {"success":true,"message":"OK","data":{"username":"admin"}}
 *   {"success":false,"message":"INVALID_ARGUMENTS"}
 *   {"success":false,"message":"MODX_NOT_FOUND"}
 *
 * Если у MODX взорвётся фатал внутри bootstrap'а — stdout может быть пустым,
 * а stderr будет содержать стэк. Caller это обработает.
 */
const MODX_CHANGE_PASS_SCRIPT = `<?php
/**
 * Сменить / создать пароль админа MODX.
 *   argv[1] = absolute base path (где лежит index.php от MODX)
 *   argv[2] = username
 *   argv[3] = new password
 *   argv[4] = "1"|"0" — делать sudo-юзера при создании (default 1).
 */
if (!empty($argv)) {
    $base_path = isset($argv[1]) ? $argv[1] : null;
    $username  = isset($argv[2]) ? $argv[2] : null;
    $password  = isset($argv[3]) ? $argv[3] : null;
    $sudo      = isset($argv[4]) ? (bool)$argv[4] : true;
}
if (empty($base_path) || empty($username) || empty($password)) {
    fwrite(STDOUT, '{"success":false,"message":"INVALID_ARGUMENTS"}');
    exit(2);
}

define('MODX_API_MODE', true);
$indexFile = rtrim($base_path, '/') . '/index.php';
if (!file_exists($indexFile)) {
    fwrite(STDOUT, '{"success":false,"message":"MODX_INDEX_NOT_FOUND"}');
    exit(3);
}
require_once $indexFile;

if (!isset($modx) || !($modx instanceof modX)) {
    fwrite(STDOUT, '{"success":false,"message":"MODX_NOT_BOOTSTRAPPED"}');
    exit(4);
}
$modx->getService('error', 'error.modError');
$modx->setLogLevel(modX::LOG_LEVEL_FATAL);
$modx->setLogTarget('FILE');
$modx->error->reset();

$user = $modx->getObject('modUser', ['username' => $username]);
if (!$user) {
    $user = $modx->newObject('modUser');
    $user->fromArray([
        'username' => $username,
        'password' => $password,
        'active'   => true,
    ]);
    if ($sudo) {
        $user->set('primary_group', true);
        $user->setSudo(1);
    }
    $profile = $modx->newObject('modUserProfile');
    $profile->fromArray([
        'fullname' => $username,
        'email'    => $username . '@' . $username . '.local',
    ]);
    $user->addOne($profile);
    if (!$user->save()) {
        fwrite(STDOUT, '{"success":false,"message":"USER_SAVE_FAILED"}');
        exit(5);
    }
    fwrite(STDOUT, '{"success":true,"message":"CREATED","data":{"username":"' . addslashes($username) . '"}}');
    exit(0);
}

// changePassword(newPassword, oldPassword='', validateOldPassword=false)
$ok = $user->changePassword($password, '', false);
if (!$ok) {
    fwrite(STDOUT, '{"success":false,"message":"CHANGE_PASSWORD_FAILED"}');
    exit(6);
}
fwrite(STDOUT, '{"success":true,"message":"OK","data":{"username":"' . addslashes($username) . '"}}');
exit(0);
`;

export interface ChangeModxAdminPasswordParams {
  /** Корневая директория сайта (домашняя для systemUser). */
  rootPath: string;
  /** Относительный путь до web-root внутри rootPath (обычно "www"). */
  filesRelPath?: string;
  /** Версия PHP, как в Site.phpVersion (например "8.2"). */
  phpVersion?: string;
  /** Per-site Linux user (если есть — используем sudo, иначе бежим под root). */
  systemUser?: string;
  /** Имя админа MODX. */
  username: string;
  /** Новый пароль. */
  password: string;
  /** Если юзер не найден — создавать ли его с sudo-флагом (default true). */
  createIfMissing?: boolean;
}

export interface ChangeModxAdminPasswordResult {
  success: boolean;
  /** "CREATED" — был создан новый юзер, "OK" — пароль сменён существующему. */
  message?: string;
  error?: string;
}

/**
 * Резолв пути до web-root MODX (туда, где лежит index.php).
 */
function resolveWwwDir(rootPath: string, filesRelPath?: string): string {
  const rel = (filesRelPath || 'www')
    .replace(/^\/+/, '')
    .replace(/\.\.+/g, '')
    .replace(/\/+$/, '');
  return path.join(rootPath, rel || 'www');
}

/**
 * Минимальная санитизация username/password перед передачей в argv.
 * Жёсткие проверки уже сделаны на API-слое — здесь второй контур.
 */
function assertSafeArg(name: string, value: string, maxLen: number): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is empty`);
  }
  if (value.length > maxLen) {
    throw new Error(`${name} is too long (max ${maxLen})`);
  }
  // Запрет NUL/CR/LF в любом аргументе — иначе CommandExecutor всё равно
  // отвергнет, но лучше чёткая ошибка раньше.
  // eslint-disable-next-line no-control-regex
  if (/[\x00\r\n]/.test(value)) {
    throw new Error(`${name} contains control characters`);
  }
}

export class ModxAdminPassChanger {
  private executor: CommandExecutor;

  constructor(executor?: CommandExecutor) {
    this.executor = executor || new CommandExecutor();
  }

  async run(params: ChangeModxAdminPasswordParams): Promise<ChangeModxAdminPasswordResult> {
    assertSafeArg('username', params.username, 100);
    assertSafeArg('password', params.password, 256);

    const wwwDir = resolveWwwDir(params.rootPath, params.filesRelPath);

    // Sanity: index.php должен существовать. Без этого MODX не bootstrap'нется,
    // и юзер увидит "MODX_INDEX_NOT_FOUND" — но лучше отказать раньше с
    // понятным сообщением.
    const indexPhp = path.join(wwwDir, 'index.php');
    try {
      await fs.access(indexPhp);
    } catch {
      return {
        success: false,
        error: `index.php не найден в ${wwwDir} — сайт MODX установлен корректно?`,
      };
    }

    const phpBin = `php${params.phpVersion || DEFAULT_PHP_VERSION}`;
    const phpProbe = await this.executor.execute('which', [phpBin]);
    if (phpProbe.exitCode !== 0) {
      return {
        success: false,
        error: `${phpBin} не установлен на сервере (нужен для bootstrap MODX). Установи через панель или поменяй PHP сайту.`,
      };
    }

    // Пишем временный скрипт. /tmp world-readable — sudo'ный per-site user
    // его прочитает. Содержимое не секретное (никаких паролей внутри файла).
    const scriptName = `meowbox-modx-pass-${crypto.randomBytes(8).toString('hex')}.php`;
    const scriptPath = path.join(os.tmpdir(), scriptName);
    await fs.writeFile(scriptPath, MODX_CHANGE_PASS_SCRIPT, { mode: 0o644 });

    try {
      const sudoFlag = params.createIfMissing === false ? '0' : '1';

      let command: string;
      let args: string[];
      let unsafeShellMetaArgs: number[];

      if (params.systemUser) {
        // sudo -n -u <user> phpX.Y /tmp/<script>.php <wwwDir> <username> <password> <sudoFlag>
        command = 'sudo';
        args = [
          '-n',
          '-u', params.systemUser,
          phpBin,
          scriptPath,
          wwwDir,
          params.username,
          params.password,
          sudoFlag,
        ];
        // password — индекс 7
        unsafeShellMetaArgs = [7];
      } else {
        // legacy сайт без per-site юзера — фолбэк: запускаем под root.
        command = phpBin;
        args = [scriptPath, wwwDir, params.username, params.password, sudoFlag];
        // password — индекс 3
        unsafeShellMetaArgs = [3];
      }

      const result = await this.executor.execute(command, args, {
        timeout: 60_000,
        unsafeShellMetaArgs,
        env: {
          // Чтобы PHP не пытался писать STDIN-prompts.
          PHP_NO_INTERACTION: '1',
        },
      });

      // Парсим JSON из stdout. Берём ПОСЛЕДНЮЮ непустую строку, начинающуюся с `{`,
      // — на bootstrap'е MODX может прилететь лишний whitespace или deprecation
      // notice'ы из php-cli (если в php.ini у юзера error_reporting шумный).
      const lines = result.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      let parsed: { success: boolean; message?: string; data?: unknown } | null = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (line.startsWith('{') && line.endsWith('}')) {
          try {
            parsed = JSON.parse(line);
            break;
          } catch { /* try next */ }
        }
      }

      if (!parsed) {
        const errSnippet = (result.stderr || '').substring(0, 400) || `exit ${result.exitCode}`;
        return {
          success: false,
          error: `MODX bootstrap не вернул валидный JSON. ${errSnippet}`,
        };
      }

      if (!parsed.success) {
        return {
          success: false,
          error: `MODX отказал: ${parsed.message || 'unknown reason'}`,
        };
      }

      return {
        success: true,
        message: parsed.message || 'OK',
      };
    } finally {
      await fs.unlink(scriptPath).catch(() => { /* idempotent cleanup */ });
    }
  }
}
