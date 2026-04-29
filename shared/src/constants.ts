/**
 * Общие константы, которые должны быть одинаковы в api/web/agent.
 * Если возникает соблазн сдублировать магическое число в 2+ местах —
 * вместо этого добавь его сюда.
 */

/**
 * Список поддерживаемых версий PHP для установки/настройки per-site pool'ов.
 * Все версии тянутся из ondrej/php PPA (агент сам подцепляет PPA при первой
 * установке версии, см. agent/src/php/phpfpm.manager.ts).
 *
 * Внимание: 7.1 / 7.2 / 7.3 — давно EOL, безопасных обновлений нет. Оставляем
 * только под legacy-сайты, переезжающие со старых хостингов. Для нового сайта
 * дефолт — 8.2 (DEFAULT_PHP_VERSION ниже).
 */
export const SUPPORTED_PHP_VERSIONS = [
  '7.1',
  '7.2',
  '7.3',
  '7.4',
  '8.0',
  '8.1',
  '8.2',
  '8.3',
  '8.4',
] as const;

export type SupportedPhpVersion = (typeof SUPPORTED_PHP_VERSIONS)[number];

/** Дефолтная версия PHP для новых сайтов. */
export const DEFAULT_PHP_VERSION: SupportedPhpVersion = '8.2';

/** Дефолтные (latest) версии MODX. Обновлять при выходе новых релизов. */
export const DEFAULT_MODX_REVO_VERSION = '2.8.8-pl';
export const DEFAULT_MODX_3_VERSION = '3.1.2-pl';

/** Базовый URL официального зеркала MODX — ZIP'ы Revo/3. */
export function modxDownloadZipUrl(version: string): string {
  return `https://modx.com/download/direct?id=modx-${version}.zip`;
}

/** Регулярка валидации семантической версии MODX (2.8.8-pl, 3.1.2-pl и т.д.). */
export const MODX_VERSION_REGEX = /^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9]+)?$/;

/**
 * Политика паролей панели. Совпадает в auth.dto.ts и users.dto.ts —
 * источник истины тут, чтобы API/UI не рассинхронились.
 */
export const PASSWORD_POLICY = {
  MIN_LENGTH: 12,
  MAX_LENGTH: 128,
} as const;

/** Regex для имени Linux-юзера / БД-юзера (безопасный подмножество). */
export const SAFE_IDENT_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * Regex для имени сайта (= Linux-юзер): начинается с буквы, строчные,
 * [a-z0-9_-], до 32 символов. Синхронизирован с api/src/common/validators.
 */
export const SITE_NAME_REGEX = /^[a-z][a-z0-9_-]{0,31}$/;

/** Regex для DNS-имени домена. */
export const DOMAIN_REGEX = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

/**
 * Cron-расписание — ровно 5 полей, разделители ТОЛЬКО пробел/табуляция.
 * НЕЛЬЗЯ использовать `\s` — он матчит `\n`/`\r` и даёт crontab-injection
 * (атакующий закрывает строку и добавляет свою cron-запись).
 *
 * Единый источник правды для api/cron и api/backups — дубли расходились и
 * в backups.dto.ts регексп пропускал `\n`.
 */
export const CRON_SCHEDULE_REGEX = /^[\d*,/-]+(?:[ \t]+[\d*,/-]+){4}$/;

/** Дефолтный путь к базе сайтов (чтоб не плодить по кодбазе `|| '/var/www'`). */
export const DEFAULT_SITES_BASE_PATH = '/var/www';

/** Дефолтный путь к локальным бэкапам. */
export const DEFAULT_BACKUP_LOCAL_PATH = '/var/meowbox/backups';

/** Префикс команд PHP-FPM systemd-сервисов (`php8.2-fpm`, `php8.3-fpm` …). */
export const PHP_FPM_SERVICE_PREFIX = 'php';
export const PHP_FPM_SERVICE_SUFFIX = '-fpm';

/**
 * Расширения, которые НИКОГДА нельзя загружать в www-root через file-manager.
 * Web-сервер (nginx + php-fpm) с радостью исполнит такой файл → RCE за один
 * curl. Блокируем по расширению, а НЕ по MIME: MIME из multipart клиентский,
 * подделывается тривиально. Включаем и двойные расширения (shell.php.jpg).
 *
 * Список умышленно агрессивный: лучше пересрать и сказать «нельзя .phtml»,
 * чем пропустить webshell. Для загрузки таких файлов у админа есть PUT /write
 * (туда залить .php легитимно, например index.php новый деплой).
 */
export const UPLOAD_BLOCKED_EXTENSIONS = [
  // PHP
  'php', 'php3', 'php4', 'php5', 'php7', 'php8', 'phtml', 'phps', 'phar', 'pht',
  // Server-side scripting
  'py', 'pyc', 'pl', 'cgi', 'rb', 'jsp', 'jspx', 'asp', 'aspx', 'ashx', 'asmx', 'cfm',
  // Native executables / scripts
  'sh', 'bash', 'zsh', 'ksh', 'csh', 'fish',
  'exe', 'dll', 'com', 'bat', 'cmd', 'ps1', 'vbs', 'vbe', 'wsf', 'wsh',
  'msi', 'msp', 'scr', 'cpl', 'ocx', 'hta',
  'so', 'dylib',
  // htaccess-подобные — могут переопределить nginx/apache правила если их
  // случайно распарсит сервер.
  'htaccess', 'htpasswd',
] as const;

/**
 * MODX install defaults — значения, которые xPDO/MODX'овский cli-install.php
 * ждёт в конфиге. Вынесены в shared, чтоб не хардкодить в агенте.
 */
export const MODX_DB_DEFAULTS = {
  HOST: '127.0.0.1',
  MYSQL_PORT: '3306',
  POSTGRESQL_PORT: '5432',
  CHARSET: 'utf8mb4',
  MYSQL_CHARSET: 'utf8mb4',
  MYSQL_COLLATION: 'utf8mb4_unicode_ci',
  POSTGRESQL_COLLATION: 'utf8_general_ci',
  TABLE_PREFIX: 'modx_',
  HTTPS_PORT: '443',
  DEFAULT_ADMIN_USERNAME: 'admin',
} as const;
