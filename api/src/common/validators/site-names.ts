/**
 * Единый источник истины для валидации имён сайтов/доменов/БД.
 *
 * До этого regex'ы и reserved-сеты дублировались в 3+ местах
 * (sites.dto.ts × 3, sites.service.ts × 2). Любое расхождение = дыра
 * в валидации. Теперь все импортируют отсюда.
 */

/**
 * Имя сайта == Linux-юзер, имя nginx-конфига, имя БД-юзера, имя pool'а.
 * Ограничения Linux username: начинается с буквы, [a-z0-9_-], до 32 символов.
 */
export const SITE_NAME_REGEX = /^[a-z][a-z0-9_-]{0,31}$/;
export const SITE_NAME_MESSAGE =
  'System name must start with a letter and contain only lowercase letters, digits, underscores and hyphens (max 32 chars)';

/**
 * DNS-домен (полностью квалифицированный FQDN, минимум одна точка, TLD ≥ 2 букв).
 * Совпадает с shared/src/constants.ts::DOMAIN_REGEX — дубликат в api для прямого
 * использования в class-validator без @meowbox/shared import'а в DTO.
 */
export const DOMAIN_REGEX =
  /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
export const DOMAIN_MESSAGE = 'Invalid domain format';
export const DOMAIN_MAX_LENGTH = 253;

/** Имя БД / имя БД-юзера (mysql/postgres identifier-safe). */
export const DB_IDENT_REGEX = /^[a-zA-Z0-9_]+$/;
export const DB_NAME_MAX_LENGTH = 64;
export const DB_USER_MAX_LENGTH = 32;

/** Имя ветки git (allow-list: alnum, `.`, `_`, `-`, `/`). */
export const GIT_BRANCH_REGEX = /^[a-zA-Z0-9_./-]+$/;

/** Путь вроде `manager`, `connectors` — только буквы/цифры/`_-`. */
export const URL_PATH_SEGMENT_REGEX = /^[a-zA-Z0-9_-]+$/;

/** Версия MODX — `2.8.8-pl`, `3.1.2-pl`, etc. */
export const MODX_VERSION_REGEX = /^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9]+)?$/;

/**
 * Зарезервированные системные юзеры/имена, которые НЕЛЬЗЯ использовать как
 * имя сайта (оно же имя Linux-юзера). Расширяй по мере необходимости.
 *
 * Источник: дефолтные юзеры Ubuntu/Debian + системные сервисы хостинга.
 */
export const RESERVED_SYSTEM_USERS: ReadonlySet<string> = new Set([
  // core
  'root', 'daemon', 'bin', 'sys', 'sync', 'games', 'man', 'lp',
  'mail', 'news', 'uucp', 'proxy', 'www-data', 'backup', 'list', 'irc',
  'gnats', 'nobody',
  // system services
  '_apt', 'systemd-network', 'systemd-resolve', 'systemd-timesync',
  'messagebus', 'syslog', 'tss', 'uuidd', 'tcpdump', 'landscape',
  'pollinate', 'sshd', 'ubuntu', 'lxd',
  // hosting stack
  'nginx', 'postgres', 'mysql', 'mariadb', 'redis', 'memcached',
  'php', 'php-fpm', 'apache', 'apache2', 'httpd',
  // panel
  'admin', 'meowbox', 'panel',
]);

/**
 * Проверка: имя совпадает с системным? Бросать ConflictException в сервисах.
 */
export function isReservedSiteName(name: string): boolean {
  return RESERVED_SYSTEM_USERS.has(name.toLowerCase());
}
