import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

const MAX_CONTROL_BODY_BYTES = 1024 * 1024;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,128}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const ALLOWED_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'idempotency-key',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'if-unmodified-since',
  'range',
]);

export interface CanonicalFederationHeader {
  name: string;
  value: string;
}

export class DelegationInputError extends Error {
  constructor(
    readonly code:
      | 'INVALID_HEADER'
      | 'DUPLICATE_HEADER'
      | 'COMPRESSED_BODY_UNSUPPORTED'
      | 'BODY_TOO_LARGE'
      | 'BODY_NOT_ALLOWED'
      | 'INVALID_CONTENT_TYPE'
      | 'INVALID_JSON_BODY'
      | 'IDEMPOTENCY_KEY_REQUIRED'
      | 'INVALID_IDEMPOTENCY_KEY',
    message: string,
  ) {
    super(message);
    this.name = 'DelegationInputError';
  }
}

export function rawHeaderPairs(rawHeaders: readonly string[]): readonly (readonly [string, string])[] {
  if (rawHeaders.length % 2 !== 0) {
    throw new DelegationInputError('INVALID_HEADER', 'Raw header list is malformed');
  }
  const pairs: Array<readonly [string, string]> = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    pairs.push([rawHeaders[index], rawHeaders[index + 1]]);
  }
  return pairs;
}

export function canonicalizeFederationHeaders(
  pairs: readonly (readonly [string, string])[],
): readonly CanonicalFederationHeader[] {
  const seen = new Set<string>();
  const allowed: CanonicalFederationHeader[] = [];

  for (const [rawName, rawValue] of pairs) {
    if (
      !HEADER_NAME.test(rawName) ||
      /[\x00-\x1f\x7f]/.test(rawValue)
    ) {
      throw new DelegationInputError(
        'INVALID_HEADER',
        'Federation request contains an invalid header',
      );
    }
    const name = rawName.toLowerCase();
    if (seen.has(name)) {
      throw new DelegationInputError(
        'DUPLICATE_HEADER',
        'Federation request contains a duplicate header',
      );
    }
    seen.add(name);

    if (name === 'content-encoding') {
      if (rawValue.trim().toLowerCase() !== 'identity') {
        throw new DelegationInputError(
          'COMPRESSED_BODY_UNSUPPORTED',
          'Signed control requests do not accept compressed bodies',
        );
      }
      continue;
    }
    if (!ALLOWED_HEADERS.has(name)) continue;

    const value = rawValue.trim();
    if (value.length === 0 || !/^[\x20-\x7e]+$/.test(value)) {
      throw new DelegationInputError(
        'INVALID_HEADER',
        'Federation allowlisted header has an invalid value',
      );
    }
    allowed.push({ name, value });
  }

  return allowed.sort((left, right) => left.name.localeCompare(right.name));
}

export function canonicalHeaderValue(
  headers: readonly CanonicalFederationHeader[],
  name: string,
): string | null {
  return headers.find((header) => header.name === name)?.value ?? null;
}

export function sha256Body(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

export function validateGenericControlRequest(
  method: string,
  headers: readonly CanonicalFederationHeader[],
  body: Buffer,
): Readonly<{ bodySha256: string; idempotencyKey: string | null }> {
  if (body.length > MAX_CONTROL_BODY_BYTES) {
    throw new DelegationInputError(
      'BODY_TOO_LARGE',
      'Signed control request body exceeds 1 MiB',
    );
  }
  const normalizedMethod = method.toUpperCase();
  if ((normalizedMethod === 'GET' || normalizedMethod === 'HEAD') && body.length > 0) {
    throw new DelegationInputError(
      'BODY_NOT_ALLOWED',
      'GET and HEAD federation requests cannot contain a body',
    );
  }

  const contentType = canonicalHeaderValue(headers, 'content-type');
  if (body.length > 0) {
    if (
      !contentType ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
    ) {
      throw new DelegationInputError(
        'INVALID_CONTENT_TYPE',
        'Signed control request body must be JSON UTF-8',
      );
    }
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(body);
      JSON.parse(decoded);
    } catch {
      throw new DelegationInputError(
        'INVALID_JSON_BODY',
        'Signed control request body is not valid JSON UTF-8',
      );
    }
  }

  const idempotencyKey = canonicalHeaderValue(headers, 'idempotency-key');
  const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(normalizedMethod);
  if (isMutation && !idempotencyKey) {
    throw new DelegationInputError(
      'IDEMPOTENCY_KEY_REQUIRED',
      'Federated mutations require an idempotency key',
    );
  }
  if (idempotencyKey && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw new DelegationInputError(
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency key must be 8-128 printable ASCII characters',
    );
  }

  return {
    bodySha256: sha256Body(body),
    idempotencyKey,
  };
}

