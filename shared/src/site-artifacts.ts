/**
 * Хелперы для имён runtime-артефактов сайта — PHP-FPM pool, сокет и логи.
 *
 * Final domain-centric identity is `SiteDomain.runtimeKey`. `Site.name` remains
 * a compatibility fallback for pre-W01 callers and for a migrated primary key.
 * Nginx access/error logs deliberately retain their domain-based naming via
 * siteDomainLogBase(); only PHP/application runtime artifacts use runtimeKey.
 *
 * Legacy-fallback: для сайтов, которые ещё не мигрированы, siteName может быть
 * пустым. Тогда используем domain. Миграция идёт при старте API (см.
 * SitesService.onModuleInit → migrateArtifactsToSiteNameSchema).
 */

export interface AnchorParams {
  /** Immutable SiteDomain runtime identity (preferred for PHP/app artifacts). */
  runtimeKey?: string | null;
  /** Legacy Site.name fallback. */
  siteName?: string | null;
  /** Legacy fallback: домен, если siteName не задан. */
  domain?: string | null;
}

/**
 * Выбирает anchor для PHP/app файлов, pool'ов и сокетов.
 * Returns runtimeKey first, then legacy siteName, then domain.
 *
 * @throws Error если ни один identity key не задан.
 */
export function artifactAnchor(params: AnchorParams): string {
  const runtimeKey = (params.runtimeKey || '').trim();
  if (runtimeKey) return runtimeKey;
  const siteName = (params.siteName || '').trim();
  if (siteName) return siteName;
  const domain = (params.domain || '').trim();
  if (domain) return domain;
  throw new Error('artifactAnchor: runtimeKey, siteName, and domain are empty');
}

/** Explicit name for the runtimeKey-first PHP/application artifact contract. */
export function runtimeArtifactAnchor(params: AnchorParams): string {
  return artifactAnchor(params);
}

/** Без throw — для мест, где пустой результат — не баг, а "сайт ещё не создан". */
export function artifactAnchorOrEmpty(params: AnchorParams): string {
  return (params.runtimeKey || '').trim() || (params.siteName || '').trim() || (params.domain || '').trim();
}

/** Санитайзит домен под имя файла лога (no slashes/dots-as-path). */
export function sanitizeDomainForFilename(domain: string): string {
  return String(domain).toLowerCase().replace(/[^a-z0-9._-]/g, '_') || 'domain';
}

/**
 * База имени nginx-логов домена.
 *
 * В multi-domain схеме у каждого основного домена свой access/error log:
 * `{Site.name}__{domain}-access.log`. The runtimeKey fallback is used only if
 * no routing identity is available, never to replace normal Nginx log names.
 */
export function siteDomainLogBase(params: AnchorParams): string {
  const siteName = (params.siteName || '').trim();
  const domain = (params.domain || '').trim();
  if (siteName && domain) return `${siteName}__${sanitizeDomainForFilename(domain)}`;
  if (siteName) return siteName;
  if (domain) return domain;
  return artifactAnchor(params);
}
