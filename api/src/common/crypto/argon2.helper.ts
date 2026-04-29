import * as argon2 from 'argon2';

/**
 * Единая политика хеширования паролей для всего API.
 * Все хеши пользователей/БД-паролей создаются через этот модуль —
 * чтобы при смене политики (ужесточение/смягчение под нагрузку) не
 * пришлось править код в 6 местах.
 *
 * Параметры читаются из ENV с дефолтами OWASP 2023:
 *   ARGON2_MEMORY_COST_KIB  (default 65536 — 64 MiB)
 *   ARGON2_TIME_COST        (default 3)
 *   ARGON2_PARALLELISM      (default 4)
 *
 * tип всегда argon2id (рекомендация OWASP для general-purpose password hashing).
 */

function envInt(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) return def;
  return n;
}

export const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  // 8 MiB.. 1 GiB — вне этого диапазона argon2 либо мгновенный, либо крашит сервер.
  memoryCost: envInt('ARGON2_MEMORY_COST_KIB', 65536, 8 * 1024, 1024 * 1024),
  timeCost: envInt('ARGON2_TIME_COST', 3, 1, 20),
  parallelism: envInt('ARGON2_PARALLELISM', 4, 1, 16),
};

/** Хеширование пароля по единой политике. */
export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS);
}

/** Constant-time проверка пароля. */
export function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return argon2.verify(hash, plain);
}
