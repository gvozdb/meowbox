/**
 * SQL-identifier валидаторы для миграции hostpanel.
 *
 * spec §17.2: «Все имена БД/юзеров/таблиц проходят через `validateSqlIdentifier()`
 * (whitelist `[a-zA-Z0-9_]`)».
 *
 * Раньше регексы инлайнились ad-hoc по разным файлам (run-item.ts,
 * discover.ts) — теперь единая точка валидации. Любая мутация SQL-имени
 * (`CREATE DATABASE <name>`, `--ignore-table=<db>.<tbl>`, `WHERE id=<n>`)
 * должна проходить через эти хелперы.
 */

const STRICT_RE = /^[a-zA-Z0-9_]+$/;     // спека-канон (DB name, user name, table)
const RELAXED_RE = /^[a-zA-Z0-9_-]+$/;   // мягкий вариант (для имён, где `-` валидно — но это редкость)

/**
 * Кидает ошибку если имя содержит недопустимые символы. Используется ПЕРЕД
 * любым interpolation в SQL/shell-команду на источнике или slave.
 *
 * @param name      — имя БД/юзера/таблицы
 * @param context   — для понятного error message ("dbName", "tableName", ...)
 * @param allowDash — если true, разрешает `-` (Site.name использует [a-z0-9_-])
 */
export function validateSqlIdentifier(
  name: string,
  context: string,
  options: { allowDash?: boolean; maxLen?: number } = {},
): void {
  const maxLen = options.maxLen ?? 64;
  if (typeof name !== 'string') {
    throw new Error(`Invalid ${context}: not a string`);
  }
  if (name.length === 0 || name.length > maxLen) {
    throw new Error(`Invalid ${context}: length out of range (1..${maxLen})`);
  }
  const re = options.allowDash ? RELAXED_RE : STRICT_RE;
  if (!re.test(name)) {
    throw new Error(
      `Invalid ${context}='${name}': must match ${re.source}`,
    );
  }
}

/**
 * Числовой ID — кидает если не положительное целое. Используется для
 * `WHERE id=${sourceSiteId}` interpolations (defense-in-depth, sourceSiteId
 * приходит из Number(JSON), но валидируем тип ещё раз).
 */
export function validateSqlPositiveInt(value: unknown, context: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Invalid ${context}: not a positive integer (got ${value})`);
  }
  return n;
}
