const SAFE_QUERY_KEYS = new Set([
  'filter',
  'order',
  'page',
  'scope',
  'search',
  'sort',
  'status',
  'tab',
]);

function isSiteEntityPath(pathname: string): boolean {
  const match = pathname.match(/^\/sites\/([^/]+)\/?$/);
  return match !== null && match[1] !== 'create';
}

/** Returns a target-safe URL for a full reload after changing server context. */
export function serverSwitchUrl(pathname: string, search = ''): string {
  if (isSiteEntityPath(pathname)) return '/sites';
  if (/^\/dns\/zones\/[^/]+\/?$/.test(pathname)) return '/dns';

  const safe = new URLSearchParams();
  const source = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  for (const [key, value] of source) {
    if (SAFE_QUERY_KEYS.has(key)) safe.append(key, value);
  }
  const encoded = safe.toString();
  return `${pathname}${encoded ? `?${encoded}` : ''}`;
}
