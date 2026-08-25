const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VALID_ESCAPE = /%[0-9a-fA-F]{2}/g;
const ENCODED_PATH_SEPARATOR = /%(?:2f|5c)/i;

export interface ExactRequestTargetLimits {
  maxPathBytes?: number;
  maxQueryBytes?: number;
  maxTargetBytes?: number;
}

export interface ExactFederationTarget {
  serverId: string;
  inboundTarget: string;
  rawSuffix: string;
  rawPath: string;
  rawQuery: string | null;
  targetPathAndQuery: string;
}

export interface ExactTargetApiRequest {
  inboundTarget: string;
  rawPath: string;
  rawQuery: string | null;
  targetPathAndQuery: string;
}

export class ExactRequestTargetError extends Error {
  constructor(
    readonly code:
      | 'INVALID_SERVER_ID'
      | 'INVALID_REQUEST_TARGET'
      | 'REQUEST_TARGET_TOO_LARGE'
      | 'REQUEST_TARGET_MISMATCH'
      | 'UNSAFE_PATH',
    message: string,
  ) {
    super(message);
    this.name = 'ExactRequestTargetError';
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'ascii');
}

function assertValidEscapes(value: string): void {
  const withoutEscapes = value.replace(VALID_ESCAPE, '');
  if (withoutEscapes.includes('%')) {
    throw new ExactRequestTargetError(
      'INVALID_REQUEST_TARGET',
      'Request target contains an invalid percent escape',
    );
  }
}

function assertSafePath(rawPath: string): void {
  if (
    rawPath.includes('//') ||
    rawPath.includes('\\') ||
    ENCODED_PATH_SEPARATOR.test(rawPath)
  ) {
    throw new ExactRequestTargetError(
      'UNSAFE_PATH',
      'Request path contains an encoded or ambiguous separator',
    );
  }

  for (const segment of rawPath.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new ExactRequestTargetError(
        'INVALID_REQUEST_TARGET',
        'Request path contains invalid UTF-8 escapes',
      );
    }
    if (decoded === '.' || decoded === '..') {
      throw new ExactRequestTargetError(
        'UNSAFE_PATH',
        'Request path contains a dot segment',
      );
    }
    if (/[\x00-\x1f\x7f]/.test(decoded)) {
      throw new ExactRequestTargetError(
        'UNSAFE_PATH',
        'Request path contains an encoded control character',
      );
    }
  }
}

function assertBoundedRequestTarget(
  inboundTarget: string,
  limits: ExactRequestTargetLimits,
): void {
  if (
    typeof inboundTarget !== 'string' ||
    inboundTarget.length === 0 ||
    !/^[\x21-\x7e]+$/.test(inboundTarget) ||
    inboundTarget.includes('#') ||
    inboundTarget.endsWith('?')
  ) {
    throw new ExactRequestTargetError(
      'INVALID_REQUEST_TARGET',
      'Request target must be printable ASCII without fragments or a bare query marker',
    );
  }
  if (byteLength(inboundTarget) > (limits.maxTargetBytes ?? 8_192)) {
    throw new ExactRequestTargetError(
      'REQUEST_TARGET_TOO_LARGE',
      'Request target exceeds the federation limit',
    );
  }
  assertValidEscapes(inboundTarget);
}

function parseTargetPathAndQuery(
  targetPathAndQuery: string,
  limits: ExactRequestTargetLimits,
): Pick<ExactTargetApiRequest, 'rawPath' | 'rawQuery' | 'targetPathAndQuery'> {
  const queryIndex = targetPathAndQuery.indexOf('?');
  const rawPath = queryIndex === -1
    ? targetPathAndQuery
    : targetPathAndQuery.slice(0, queryIndex);
  const rawQuery = queryIndex === -1 ? null : targetPathAndQuery.slice(queryIndex + 1);
  if (!rawPath.startsWith('/api/') || rawPath === '/api/') {
    throw new ExactRequestTargetError(
      'INVALID_REQUEST_TARGET',
      'Federation request requires a concrete API path',
    );
  }
  if (
    byteLength(rawPath) > (limits.maxPathBytes ?? 4_096) ||
    (rawQuery !== null && byteLength(rawQuery) > (limits.maxQueryBytes ?? 4_096))
  ) {
    throw new ExactRequestTargetError(
      'REQUEST_TARGET_TOO_LARGE',
      'Federation path or query exceeds its limit',
    );
  }
  assertSafePath(rawPath);
  const serialized = new URL(targetPathAndQuery, 'https://federation.invalid');
  if (`${serialized.pathname}${serialized.search}` !== targetPathAndQuery) {
    throw new ExactRequestTargetError(
      'INVALID_REQUEST_TARGET',
      'Request target changes during URL serialization',
    );
  }
  return { rawPath, rawQuery, targetPathAndQuery };
}

/** Parse the exact request target received by a target controller. */
export function parseExactTargetApiRequest(
  inboundTarget: string,
  limits: ExactRequestTargetLimits = {},
): ExactTargetApiRequest {
  assertBoundedRequestTarget(inboundTarget, limits);
  return {
    inboundTarget,
    ...parseTargetPathAndQuery(inboundTarget, limits),
  };
}

export function parseExactFederationTarget(
  inboundTarget: string,
  serverId: string,
  limits: ExactRequestTargetLimits = {},
): ExactFederationTarget {
  if (!CANONICAL_UUID.test(serverId)) {
    throw new ExactRequestTargetError(
      'INVALID_SERVER_ID',
      'Federation server ID must be a canonical UUID',
    );
  }
  assertBoundedRequestTarget(inboundTarget, limits);

  const prefix = `/api/proxy/${serverId}/`;
  if (!inboundTarget.startsWith(prefix)) {
    throw new ExactRequestTargetError(
      'REQUEST_TARGET_MISMATCH',
      'Request target does not match the selected server',
    );
  }

  const rawSuffix = inboundTarget.slice(prefix.length);
  const targetPathAndQuery = `/api/${rawSuffix}`;
  const parsed = parseTargetPathAndQuery(targetPathAndQuery, limits);

  return {
    serverId,
    inboundTarget,
    rawSuffix,
    rawPath: parsed.rawPath,
    rawQuery: parsed.rawQuery,
    targetPathAndQuery,
  };
}
