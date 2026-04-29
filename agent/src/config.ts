/**
 * Единая точка конфигурации агента.
 *
 * Все пути и дефолты собираем ЗДЕСЬ, чтобы избавиться от хардкода в отдельных
 * менеджерах. Значения перекрываются через env-переменные в `agent/.env`
 * (или напрямую через systemd/pm2 env).
 *
 * Security-нотация:
 *   - `ALLOWED_SITE_ROOT_PREFIXES` — единственный allowlist путей, под которыми
 *     агент соглашается делать `rm -rf` и удалять бэкапы. Любые операции с
 *     путями, полученными из сети, ДОЛЖНЫ пройти `isUnderAllowedSiteRoot()`
 *     перед доступом к ФС.
 */

import * as path from 'path';

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v : fallback;
}

function envList(name: string): string[] {
  const v = process.env[name];
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Абсолютный путь к директории, где создаются home'ы сайтов. */
export const SITES_BASE_PATH = path.resolve(env('SITES_BASE_PATH', '/var/www'));

/**
 * Корень проекта Meowbox (там, где git clone + ecosystem.config.js).
 * Используется для self-update (git pull, rebuild, pm2 restart).
 * Fallback — процессный cwd → обычно совпадает с корнем при запуске через PM2.
 */
export const MEOWBOX_BASE_DIR = path.resolve(
  env('MEOWBOX_BASE_DIR', process.env.PWD || process.cwd()),
);

/**
 * Версии PHP, которые панель ПОКАЗЫВАЕТ в системе. Используется для `getVersions`
 * (детект установленных `php{ver}` бинарников) и UI-пресетов. Добавление новой
 * версии сюда — один env или patch, без рекомпиляции кода.
 */
export const SUPPORTED_PHP_VERSIONS: string[] = (() => {
  const fromEnv = envList('SUPPORTED_PHP_VERSIONS');
  return fromEnv.length > 0 ? fromEnv : ['8.4', '8.3', '8.2', '8.1', '8.0', '7.4'];
})();

/** Директория локальных бэкапов (storageType=LOCAL). */
export const BACKUP_LOCAL_PATH = path.resolve(env('BACKUP_LOCAL_PATH', '/var/meowbox/backups'));

/** Временная директория для скачивания удалённых бэкапов перед restore'ом. */
export const BACKUP_TEMP_PATH = path.resolve(env('BACKUP_TEMP_PATH', '/tmp/meowbox-backup'));

/** Nginx пути. */
export const NGINX_SITES_AVAILABLE = env('NGINX_SITES_AVAILABLE', '/etc/nginx/sites-available');
export const NGINX_SITES_ENABLED = env('NGINX_SITES_ENABLED', '/etc/nginx/sites-enabled');
export const NGINX_GLOBAL_CONF = env('NGINX_GLOBAL_CONF', '/etc/nginx/nginx.conf');

/** PHP-FPM пути. */
export const PHP_FPM_CONFIG_DIR = env('PHP_FPM_CONFIG_DIR', '/etc/php');
export const PHP_FPM_SOCKET_DIR = env('PHP_FPM_SOCKET_DIR', '/var/run/php');
export const PHP_LOG_DIR = env('PHP_LOG_DIR', '/var/log/php');

/** Версия PHP по-умолчанию — используется как fallback в инсталлерах. */
export const DEFAULT_PHP_VERSION = env('DEFAULT_PHP_VERSION', '8.2');

/** SSL пути (Let's Encrypt + кастомные сертификаты). */
export const LETSENCRYPT_LIVE_DIR = env('LETSENCRYPT_LIVE_DIR', '/etc/letsencrypt/live');
export const CUSTOM_SSL_DIR = env('CUSTOM_SSL_DIR', '/etc/ssl/meowbox');

/** Директория экспортов БД (dump'ы через UI). */
export const DB_EXPORTS_DIR = path.resolve(env('DB_EXPORTS_DIR', '/var/meowbox/exports'));

/**
 * Список префиксов, под которыми разрешено удалять файлы/директории.
 *
 * По-умолчанию: SITES_BASE_PATH + /home/ (для случаев, когда панель хостит
 * юзеров с шелл-доступом не в /var/www). Перекрывается через env
 * `ALLOWED_SITE_ROOT_PREFIXES` (comma-separated).
 */
export const ALLOWED_SITE_ROOT_PREFIXES: string[] = (() => {
  const fromEnv = envList('ALLOWED_SITE_ROOT_PREFIXES');
  const prefixes = fromEnv.length > 0 ? fromEnv : [SITES_BASE_PATH, '/home'];
  return prefixes.map((p) => path.resolve(p));
})();

/**
 * Проверяет, лежит ли `p` строго внутри одного из разрешённых префиксов
 * (после `path.resolve`). Используется перед `rm -rf` и прочими разрушающими
 * операциями.
 *
 * Внимание: это ТОЛЬКО лексическая проверка. Если путь может быть симлинком,
 * отдельно вызывай `fs.realpath` ДО этой проверки.
 */
export function isUnderAllowedSiteRoot(p: string): boolean {
  const abs = path.resolve(p);
  return ALLOWED_SITE_ROOT_PREFIXES.some(
    (prefix) => abs === prefix || abs.startsWith(prefix + path.sep),
  );
}

/** То же, но для бэкап-хранилища. */
export function isUnderBackupStorage(p: string): boolean {
  const abs = path.resolve(p);
  return abs === BACKUP_LOCAL_PATH || abs.startsWith(BACKUP_LOCAL_PATH + path.sep);
}

function envNumber(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Timeout'ы: в одном месте — проще аудитить.
 * Значения в миллисекундах. Переопределяются через env `MEOWBOX_TIMEOUT_*`.
 */
export const TIMEOUTS = {
  /** Дефолтный timeout для коротких операций (nginx reload, systemctl status…). */
  SHORT: envNumber('MEOWBOX_TIMEOUT_SHORT_MS', 60_000),
  /** Средний — проверки (ping, HEAD-запросы на сайты, простые установки пакетов). */
  MEDIUM: envNumber('MEOWBOX_TIMEOUT_MEDIUM_MS', 180_000),
  /** Для инсталляций/апдейтов (composer, php setup, MODX distro fetch). */
  LONG: envNumber('MEOWBOX_TIMEOUT_LONG_MS', 600_000),
  /** Для бэкапов/download'ов большого веса. */
  BACKUP: envNumber('MEOWBOX_TIMEOUT_BACKUP_MS', 900_000),
  /** Системные команды сбора метрик — du/wc, должны отваливаться быстро. */
  METRICS: envNumber('MEOWBOX_TIMEOUT_METRICS_MS', 30_000),
  /** Краткий для `wc -l` по логам. */
  METRICS_FAST: envNumber('MEOWBOX_TIMEOUT_METRICS_FAST_MS', 10_000),
  /** Socket.io RPC default timeout для любого handler'а в agent.service. */
  SOCKET_HANDLER: envNumber('MEOWBOX_TIMEOUT_SOCKET_HANDLER_MS', 300_000),
  /** Snapshot/restore операции restic. */
  RESTIC: envNumber('MEOWBOX_TIMEOUT_RESTIC_MS', 1_800_000),
} as const;

/**
 * HTTP-таймауты для curl-проверок (DNS, health-check после создания сайта).
 */
export const HTTP_CHECK = {
  CONNECT: envNumber('MEOWBOX_HTTP_CONNECT_TIMEOUT_S', 15),
  MAX_TIME: envNumber('MEOWBOX_HTTP_MAX_TIME_S', 180),
} as const;

/**
 * Лимиты и хардкод агента, который раньше был раскидан по файлам.
 * Правим тут — синхронно для всех подсистем.
 */
export const TERMINAL = {
  MAX_SESSIONS: envNumber('TERMINAL_MAX_SESSIONS', 5),
  SESSION_TIMEOUT_MS: envNumber('TERMINAL_SESSION_TIMEOUT_MS', 30 * 60 * 1000),
  CLEANUP_INTERVAL_MS: envNumber('TERMINAL_CLEANUP_INTERVAL_MS', 60_000),
} as const;

/** Лимиты на чтение файлов через `files:*` handler'ы. */
export const FILES = {
  MAX_READ_SIZE_BYTES: envNumber('FILES_MAX_READ_SIZE_BYTES', 2 * 1024 * 1024),
} as const;

/**
 * Удалённые хосты для бэкап-хранилищ. Захардкоженные значения неудобны:
 * для фасадов/зеркал (например, `rest-api-proxy.ru`) теперь можно переопределить
 * через env, не правя код.
 */
export const BACKUP_HOSTS = {
  YANDEX_DISK_API: env('YANDEX_DISK_API_HOST', 'cloud-api.yandex.net'),
  CLOUD_MAILRU_WEBDAV: env('CLOUD_MAILRU_WEBDAV_HOST', 'webdav.cloud.mail.ru'),
  /** Корневая папка в удалённом хранилище под бэкапы Meowbox. */
  REMOTE_ROOT: env('BACKUP_REMOTE_ROOT', '/meowbox-backups'),
} as const;

/**
 * HTTP-таймауты для upload/download в внешние бэкап-хранилища.
 * Стандартная пара: полчаса на большие заливки, 30с на API вызовы.
 */
export const BACKUP_HTTP = {
  UPLOAD_MS: envNumber('BACKUP_HTTP_UPLOAD_MS', 30 * 60 * 1000),
  API_MS: envNumber('BACKUP_HTTP_API_MS', 30_000),
} as const;

/**
 * Кандидаты на composer — где искать бинарь. Первый существующий и исполняемый
 * выигрывает. Можно переопределить через `COMPOSER_PATHS=/foo,/bar`.
 */
export const COMPOSER_CANDIDATES: string[] = (() => {
  const env = process.env.COMPOSER_PATHS;
  if (env && env.trim()) {
    return env.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return ['/usr/local/bin/composer', '/usr/bin/composer'];
})();

/**
 * S3 defaults — используются и агентом, и API. Дефолты-fallback'и
 * вынесены сюда, чтобы исключить дрейф между процессами при кастомном
 * S3-провайдере (Yandex/Selectel/MinIO).
 */
export const S3_DEFAULTS = {
  REGION: env('S3_DEFAULT_REGION', 'us-east-1'),
  ENDPOINT: env('S3_DEFAULT_ENDPOINT', 'https://s3.amazonaws.com'),
  PREFIX: env('BACKUP_S3_PREFIX', 'meowbox'),
} as const;

/**
 * Параметры streaming multipart upload в S3 (для restic dump-to-s3).
 *
 * partSize: размер чанка. 8MB — компромисс между накладными
 * расходами на создание мелких чанков и RAM-усилением (queueSize ×
 * partSize удерживается одновременно).
 *
 * queueSize: сколько частей грузится параллельно. 4 × 8MB = 32MB пик памяти
 * на один upload. Поднимать не стоит без замера на железе.
 *
 * heartbeat: интервал диагностических логов в `dumpToS3`. Нужен чтобы видеть
 * прогресс долгих заливок (10+ ГБ).
 *
 * fallbackMaxBytes: предохранитель fallback-ветки (in-memory upload), если
 * SDK решит buffer'ить. Соответствует max RAM, который мы готовы выделить.
 */
export const BACKUP_S3 = {
  PART_SIZE_BYTES: envNumber('BACKUP_S3_PART_SIZE_BYTES', 8 * 1024 * 1024),
  QUEUE_SIZE: envNumber('BACKUP_S3_QUEUE_SIZE', 4),
  HEARTBEAT_MS: envNumber('BACKUP_S3_HEARTBEAT_MS', 30_000),
  FALLBACK_MAX_BYTES: envNumber('BACKUP_S3_FALLBACK_MAX_BYTES', 1024 * 1024 * 1024),
} as const;

/**
 * Restic-операции с большими репозиториями. Дефолты в часах:
 *   - check: 1h (форсированно прерывается если завис на проверке индексов).
 *   - ls --recursive: 10 минут (большие репы могут не уложиться).
 */
export const RESTIC_OPS = {
  CHECK_TIMEOUT_MS: envNumber('RESTIC_CHECK_TIMEOUT_MS', 3_600_000),
  LS_TIMEOUT_MS: envNumber('RESTIC_LS_TIMEOUT_MS', 600_000),
} as const;
