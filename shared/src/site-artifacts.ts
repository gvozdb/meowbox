/**
 * Хелперы для имён артефактов сайта — nginx-конфиг, PHP-FPM pool, сокет и т.д.
 *
 * Артефакты ЯКОРЯТСЯ на `Site.name` (= Linux-юзер, immutable), а не на домене.
 * При смене главного домена artifact-anchor не меняется, только `server_name`
 * внутри nginx-конфига. До этого было наоборот — файл `{domain}.conf` приходилось
 * переименовывать при смене домена → лишняя сложность и race conditions.
 *
 * Legacy-fallback: для сайтов, которые ещё не мигрированы, siteName может быть
 * пустым. Тогда используем domain. Миграция идёт при старте API (см.
 * SitesService.onModuleInit → migrateArtifactsToSiteNameSchema).
 */

export interface AnchorParams {
  /** Site.name — новая схема (предпочтительно). */
  siteName?: string | null;
  /** Legacy fallback: домен, если siteName не задан. */
  domain?: string | null;
}

/**
 * Выбирает anchor для имён файлов/pool'ов/сокетов.
 * Возвращает siteName, если он задан и не пустой, иначе domain.
 *
 * @throws Error если оба не заданы (защищает от "случайных" пустых путей).
 */
export function artifactAnchor(params: AnchorParams): string {
  const siteName = (params.siteName || '').trim();
  if (siteName) return siteName;
  const domain = (params.domain || '').trim();
  if (domain) return domain;
  throw new Error('artifactAnchor: both siteName and domain are empty');
}

/** Без throw — для мест, где пустой результат — не баг, а "сайт ещё не создан". */
export function artifactAnchorOrEmpty(params: AnchorParams): string {
  return (params.siteName || '').trim() || (params.domain || '').trim();
}
