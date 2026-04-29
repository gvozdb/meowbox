/**
 * Дефолтные размерные лимиты. До этого были хардкоды по всему коду:
 *   - agent/src/nginx/templates.ts — client_max_body_size (разные значения!)
 *   - agent/src/php/phpfpm.manager.ts — PHP memory_limit/upload_max_filesize
 *   - api/src/main.ts — body-parser limit
 * Все переопределяются через panel-settings (KV в БД) в runtime.
 */

// ─── Nginx ────────────────────────────────────────────────────────────────────

/** client_max_body_size (Mb) по-умолчанию для нового сайта. */
export const DEFAULT_NGINX_CLIENT_MAX_BODY_MB = 64;

/** То же, но как строка для шаблонов (`64m`). */
export const DEFAULT_NGINX_CLIENT_MAX_BODY_SIZE = `${DEFAULT_NGINX_CLIENT_MAX_BODY_MB}m`;

// ─── PHP-FPM pool ─────────────────────────────────────────────────────────────

/** memory_limit = 128M — нейтральный дефолт, без перегиба. */
export const DEFAULT_PHP_MEMORY_LIMIT_MB = 128;

/** upload_max_filesize = 32M. */
export const DEFAULT_PHP_UPLOAD_MAX_FILESIZE_MB = 32;

/** post_max_size = 32M (≥ upload_max_filesize). */
export const DEFAULT_PHP_POST_MAX_SIZE_MB = 32;

/**
 * memory_limit для одноразового MODX setup-скрипта. Нужно больше, т.к. setup
 * грузит в память весь граф зависимостей ExtJS и может падать с 128M.
 */
export const MODX_SETUP_PHP_MEMORY_LIMIT_MB = 512;

// ─── API body-parser ──────────────────────────────────────────────────────────

/** JSON body limit для обычных API-запросов. */
export const DEFAULT_API_JSON_LIMIT_MB = 10;

/** Body limit для endpoint'ов с upload'ом. */
export const DEFAULT_API_UPLOAD_LIMIT_MB = 100;
