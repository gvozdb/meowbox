export type ApiRequestScope = 'master' | 'selected-target';

const MASTER_PREFIXES = [
  '/admin/update',
  '/auth',
  '/setup',
  '/servers',
  '/migration',
  '/proxy',
] as const;

const MASTER_EXACT_PATHS = new Set([
  '/panel-settings/appearance',
]);

function endpointPath(endpoint: string): string {
  if (
    typeof endpoint !== 'string' ||
    !endpoint.startsWith('/') ||
    endpoint.startsWith('//') ||
    /[\x00-\x1f\x7f]/.test(endpoint)
  ) throw new Error('API endpoint must be a relative absolute-path reference');
  return endpoint.split(/[?#]/, 1)[0] || '/';
}

export function isMasterOwnedApiEndpoint(endpoint: string): boolean {
  const path = endpointPath(endpoint);
  return MASTER_EXACT_PATHS.has(path) || MASTER_PREFIXES.some((prefix) =>
    path === prefix || path.startsWith(`${prefix}/`),
  );
}

export function resolveApiRequestScope(
  endpoint: string,
  requested: ApiRequestScope,
): ApiRequestScope {
  return isMasterOwnedApiEndpoint(endpoint) ? 'master' : requested;
}
