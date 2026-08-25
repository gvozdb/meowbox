import generated from '../generated/federation-http-actions.json';

interface BrowserFederationHttpAction {
  actionId: string;
  method: string;
  routeTemplate: string;
}

const ACTION_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9_-]+)+$/;
const HTTP_METHOD = /^(?:DELETE|GET|HEAD|OPTIONS|PATCH|POST|PUT)$/;
const ROUTE_TEMPLATE = /^\/api(?:\/[A-Za-z0-9._:-]+)*$/;

function assertGeneratedActions(value: unknown): readonly BrowserFederationHttpAction[] {
  if (!value || typeof value !== 'object') throw new Error('Federation browser action catalogue is invalid');
  const document = value as Record<string, unknown>;
  if (
    document.schemaVersion !== 'meowbox.browser-federation-http-actions/v1' ||
    typeof document.matrixSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(document.matrixSha256) ||
    !Array.isArray(document.actions)
  ) throw new Error('Federation browser action catalogue is invalid');
  const seen = new Set<string>();
  return document.actions.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') {
      throw new Error(`Federation browser action ${index} is invalid`);
    }
    const action = candidate as Record<string, unknown>;
    if (
      Object.keys(action).sort().join(',') !== 'actionId,method,routeTemplate' ||
      typeof action.actionId !== 'string' ||
      !ACTION_ID.test(action.actionId) ||
      typeof action.method !== 'string' ||
      !HTTP_METHOD.test(action.method) ||
      typeof action.routeTemplate !== 'string' ||
      !ROUTE_TEMPLATE.test(action.routeTemplate)
    ) throw new Error(`Federation browser action ${index} is invalid`);
    const key = `${action.method} ${action.routeTemplate}`;
    if (seen.has(key)) throw new Error(`Duplicate federation browser route: ${key}`);
    seen.add(key);
    return action as unknown as BrowserFederationHttpAction;
  });
}

const actions = assertGeneratedActions(generated);

function endpointPath(endpoint: string): string {
  if (
    typeof endpoint !== 'string' ||
    !endpoint.startsWith('/') ||
    endpoint.startsWith('//') ||
    /[\x00-\x1f\x7f\\]/.test(endpoint)
  ) throw new Error('API endpoint must be a relative absolute-path reference');
  const path = endpoint.split(/[?#]/, 1)[0] || '/';
  if (path.includes('//')) throw new Error('API endpoint contains an empty path segment');
  return `/api${path === '/' ? '' : path}`;
}

function routeMatches(template: string, concrete: string): boolean {
  const expected = template.split('/');
  const actual = concrete.split('/');
  if (expected.length !== actual.length) return false;
  return expected.every((segment, index) => {
    const actualSegment = actual[index];
    if (actualSegment === undefined) return false;
    if (segment.startsWith(':')) return actualSegment.length > 0;
    return segment === actualSegment;
  });
}

export function resolveRemoteHttpAction(
  method: string,
  endpoint: string,
): BrowserFederationHttpAction | null {
  const normalizedMethod = method.toUpperCase();
  if (!HTTP_METHOD.test(normalizedMethod)) return null;
  const concrete = endpointPath(endpoint);
  const matches = actions.filter((action) =>
    action.method === normalizedMethod && routeMatches(action.routeTemplate, concrete),
  );
  if (matches.length > 1) throw new Error(`Ambiguous federation browser route: ${normalizedMethod} ${concrete}`);
  return matches[0] ?? null;
}

export function activeRemoteHttpActions(): readonly BrowserFederationHttpAction[] {
  return actions;
}
