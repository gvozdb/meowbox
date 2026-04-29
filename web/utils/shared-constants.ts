/**
 * Источник истины: /opt/meowbox/shared/src/constants.ts
 *
 * Nuxt/Vite не подхватывают shared без дополнительных alias-конфигов, поэтому
 * держим здесь синхронизированную копию. При изменении констант в shared —
 * ОБЯЗАТЕЛЬНО обновить и этот файл. Проверяет CI/ревью.
 */

export const SUPPORTED_PHP_VERSIONS = [
  '7.4',
  '8.0',
  '8.1',
  '8.2',
  '8.3',
  '8.4',
] as const;

export type SupportedPhpVersion = (typeof SUPPORTED_PHP_VERSIONS)[number];

export const DEFAULT_PHP_VERSION: SupportedPhpVersion = '8.2';

export const DEFAULT_MODX_REVO_VERSION = '2.8.8-pl';
export const DEFAULT_MODX_3_VERSION = '3.1.2-pl';

export const MODX_VERSION_REGEX = /^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9]+)?$/;

/** Политика паролей — должна совпадать с API. */
export const PASSWORD_POLICY = {
  MIN_LENGTH: 12,
  MAX_LENGTH: 128,
} as const;

/** Безопасный идентификатор (Linux user, DB name/user). */
export const SAFE_IDENT_REGEX = /^[a-zA-Z0-9_-]+$/;

/** DNS-имя домена. */
export const DOMAIN_REGEX = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
