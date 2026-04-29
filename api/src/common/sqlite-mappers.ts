/**
 * Мапперы «сырых» записей Prisma/SQLite в рабочие объекты.
 *
 * Причина: после миграции с PostgreSQL на SQLite Prisma больше не поддерживает
 *   - String[] → эти поля хранятся как JSON-строки ("[...]")
 *   - Json    → аналогично, как TEXT (JSON object/array)
 *   - enum    → String
 *
 * В схеме такие поля описаны как `String`. Чтобы не менять семантику кода,
 * который работает с ними как с массивами/объектами, здесь сосредоточены
 * функции-нормализаторы. Используются на выходе сервисов (перед возвратом)
 * и перед передачей данных в агент/в nginx-генераторы.
 */

import {
  parseStringArray,
  parseJsonObject,
  parseSiteAliases,
  SiteAliasParsed,
} from './json-array';

// ---------------------------------------------------------------------------
// Хелпер «partial-map» — возвращает входной объект как есть, но с переопределёнными
// полями. Учитывает, что findFirst/findUnique могут вернуть null.
// ---------------------------------------------------------------------------

export function mapSite<T extends { aliases?: string | unknown[]; envVars?: string | Record<string, unknown>; backupExcludes?: string | string[] | null; backupExcludeTables?: string | string[] | null } | null>(
  site: T,
): T extends null ? null : Omit<NonNullable<T>, 'aliases' | 'envVars' | 'backupExcludes' | 'backupExcludeTables'> & {
  aliases: SiteAliasParsed[];
  envVars: Record<string, unknown>;
  backupExcludes: string[];
  backupExcludeTables: string[];
} {
  if (!site) return null as never;
  const s = site as unknown as Record<string, unknown>;

  // Алиасы хранятся как JSON-строка в БД. Для обратной совместимости парсер
  // принимает и старый формат (string[]), и новый ([{domain,redirect}]).
  let aliasesNormalized: SiteAliasParsed[];
  if (typeof s.aliases === 'string') {
    aliasesNormalized = parseSiteAliases(s.aliases);
  } else if (Array.isArray(s.aliases)) {
    // Уже распарсено где-то выше — снова нормализуем через общий код.
    aliasesNormalized = parseSiteAliases(JSON.stringify(s.aliases));
  } else {
    aliasesNormalized = [];
  }

  return {
    ...s,
    aliases: aliasesNormalized,
    envVars:
      typeof s.envVars === 'object' && s.envVars !== null && !Array.isArray(s.envVars)
        ? (s.envVars as Record<string, unknown>)
        : parseJsonObject(s.envVars as string | undefined, {}),
    backupExcludes: Array.isArray(s.backupExcludes)
      ? (s.backupExcludes as string[])
      : parseStringArray(s.backupExcludes as string | undefined),
    backupExcludeTables: Array.isArray(s.backupExcludeTables)
      ? (s.backupExcludeTables as string[])
      : parseStringArray(s.backupExcludeTables as string | undefined),
  } as never;
}

export function mapSsl<T extends { domains?: string | string[] } | null>(
  ssl: T,
): T extends null ? null : Omit<NonNullable<T>, 'domains'> & { domains: string[] } {
  if (!ssl) return null as never;
  const s = ssl as unknown as Record<string, unknown>;
  return {
    ...s,
    domains: Array.isArray(s.domains) ? s.domains : parseStringArray(s.domains as string | undefined),
  } as never;
}

export function mapBackupConfig<
  T extends {
    excludePaths?: string | string[];
    excludeTableData?: string | string[];
    storageConfig?: string | Record<string, unknown> | null;
  } | null,
>(
  c: T,
): T extends null ? null : Omit<NonNullable<T>, 'excludePaths' | 'excludeTableData' | 'storageConfig'> & {
  excludePaths: string[];
  excludeTableData: string[];
  storageConfig: Record<string, unknown> | null;
} {
  if (!c) return null as never;
  const s = c as unknown as Record<string, unknown>;
  return {
    ...s,
    excludePaths: Array.isArray(s.excludePaths)
      ? s.excludePaths
      : parseStringArray(s.excludePaths as string | undefined),
    excludeTableData: Array.isArray(s.excludeTableData)
      ? s.excludeTableData
      : parseStringArray(s.excludeTableData as string | undefined),
    storageConfig:
      s.storageConfig == null
        ? null
        : typeof s.storageConfig === 'object'
        ? (s.storageConfig as Record<string, unknown>)
        : parseJsonObject(s.storageConfig as string | undefined, {}),
  } as never;
}

export function mapNotificationSetting<
  T extends {
    events?: string | string[];
    config?: string | Record<string, unknown>;
  } | null,
>(
  ns: T,
): T extends null ? null : Omit<NonNullable<T>, 'events' | 'config'> & {
  events: string[];
  config: Record<string, unknown>;
} {
  if (!ns) return null as never;
  const s = ns as unknown as Record<string, unknown>;
  return {
    ...s,
    events: Array.isArray(s.events) ? s.events : parseStringArray(s.events as string | undefined),
    config:
      typeof s.config === 'object' && s.config !== null && !Array.isArray(s.config)
        ? (s.config as Record<string, unknown>)
        : parseJsonObject(s.config as string | undefined, {}),
  } as never;
}

export function mapAuditLog<T extends { details?: string | Record<string, unknown> | null } | null>(
  log: T,
): T extends null ? null : Omit<NonNullable<T>, 'details'> & { details: Record<string, unknown> | null } {
  if (!log) return null as never;
  const s = log as unknown as Record<string, unknown>;
  return {
    ...s,
    details:
      s.details == null
        ? null
        : typeof s.details === 'object'
        ? (s.details as Record<string, unknown>)
        : parseJsonObject(s.details as string | undefined, {}),
  } as never;
}

export function mapAiSession<T extends { messages?: string | unknown[] } | null>(
  session: T,
): T extends null ? null : Omit<NonNullable<T>, 'messages'> & { messages: unknown[] } {
  if (!session) return null as never;
  const s = session as unknown as Record<string, unknown>;
  let messages: unknown[] = [];
  if (Array.isArray(s.messages)) messages = s.messages;
  else if (typeof s.messages === 'string') {
    try {
      const v = JSON.parse(s.messages);
      messages = Array.isArray(v) ? v : [];
    } catch {
      messages = [];
    }
  }
  return { ...s, messages } as never;
}

// ---------------------------------------------------------------------------
// Фильтры Prisma для «поиск значения в JSON-массиве строк».
// Раньше на Postgres было `{ aliases: { has: 'domain.com' } }`; в SQLite
// эквивалент — `{ aliases: { contains: '"domain.com"' } }`, потому что
// элементы в JSON.stringify(arr) всегда заключены в двойные кавычки.
// ---------------------------------------------------------------------------

export function jsonArrayContains(value: string): { contains: string } {
  return { contains: JSON.stringify(value) };
}

/**
 * Поиск домена среди алиасов сайта в поле `aliases` (JSON).
 * Новый формат хранения — массив объектов `{"domain":"X","redirect":...}`,
 * поэтому ищем подстроку `"domain":"X"`. Для старых записей (string[] без
 * ключа `domain`) совпадение по простой кавычке осталось валидным, т.к.
 * JSON.stringify со строкой тоже формирует `"X"` — добавляем второй вариант
 * через `OR` не умеем (Prisma не поддерживает OR внутри одного поля), поэтому
 * держим обе проверки снаружи, в местах использования.
 */
export function aliasJsonContainsDomain(value: string): { contains: string } {
  return { contains: `"domain":"${value}"` };
}
