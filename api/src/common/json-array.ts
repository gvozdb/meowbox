/**
 * Хелперы для работы со String[]-полями, которые в SQLite хранятся как JSON-строки.
 * PostgreSQL нативно поддерживает `text[]`, SQLite — нет.
 */

/**
 * Парсит JSON-строку в массив строк. Безопасен к `null`/`undefined`/мусору —
 * возвращает пустой массив вместо выброса исключения.
 */
export function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Сериализует массив строк в JSON-строку для записи в SQLite-поле.
 */
export function stringifyStringArray(arr: string[] | null | undefined): string {
  if (!arr || !Array.isArray(arr)) return '[]';
  return JSON.stringify(arr.filter((x) => typeof x === 'string'));
}

/**
 * Парсит JSON-объект, хранящийся в SQLite как TEXT. Для Site.envVars, BackupConfig.storageConfig и т. п.
 */
export function parseJsonObject<T = Record<string, unknown>>(
  raw: string | null | undefined,
  fallback: T,
): T {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export function stringifyJson(v: unknown): string {
  return JSON.stringify(v ?? null);
}

/**
 * Нормализует сырое JSON-значение `Site.aliases` в массив объектов
 * `{ domain, redirect }`.
 *
 * Поддерживает три исторических формата (обратная совместимость):
 *   1. `null` / `undefined` / мусор → `[]`
 *   2. `["foo.com", "bar.com"]` (старый формат string[])
 *      → `[{domain:"foo.com", redirect:false}, ...]`
 *   3. `[{domain:"foo.com", redirect:true}, ...]` (новый формат)
 */
export interface SiteAliasParsed {
  domain: string;
  redirect: boolean;
}
export function parseSiteAliases(raw: string | null | undefined): SiteAliasParsed[] {
  if (!raw) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: SiteAliasParsed[] = [];
  for (const item of v) {
    if (typeof item === 'string') {
      const d = item.trim();
      if (d) out.push({ domain: d, redirect: false });
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const domain = typeof o.domain === 'string' ? o.domain.trim() : '';
      if (!domain) continue;
      out.push({ domain, redirect: o.redirect === true });
    }
  }
  return out;
}

/**
 * Сериализует алиасы для записи в SQLite. Принимает оба формата на входе
 * (строки или объекты) и всегда пишет новый формат (массив объектов).
 */
export function stringifySiteAliases(
  arr: Array<string | { domain: string; redirect?: boolean }> | null | undefined,
): string {
  if (!arr || !Array.isArray(arr)) return '[]';
  const normalized: SiteAliasParsed[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    let domain = '';
    let redirect = false;
    if (typeof item === 'string') {
      domain = item.trim();
    } else if (item && typeof item === 'object') {
      domain = typeof item.domain === 'string' ? item.domain.trim() : '';
      redirect = item.redirect === true;
    }
    if (!domain) continue;
    if (seen.has(domain)) continue;
    seen.add(domain);
    normalized.push({ domain, redirect });
  }
  return JSON.stringify(normalized);
}

/**
 * Извлекает только доменные имена из `Site.aliases` (строковая форма в БД
 * или уже распарсенный массив). Используется там, где редирект/не-редирект
 * не важен — для SSL SAN, поиска конфликтов и т. п.
 */
export function aliasDomains(
  source: string | Array<string | { domain: string; redirect?: boolean }> | null | undefined,
): string[] {
  if (!source) return [];
  const parsed = Array.isArray(source)
    ? source.map((item) => {
        if (typeof item === 'string') return item.trim();
        if (item && typeof item === 'object' && typeof item.domain === 'string') {
          return item.domain.trim();
        }
        return '';
      }).filter((d) => d.length > 0)
    : parseSiteAliases(source).map((a) => a.domain);
  return parsed;
}
