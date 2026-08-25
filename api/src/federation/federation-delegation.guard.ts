import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { TextDecoder } from 'node:util';
import { randomUUID } from 'node:crypto';
import {
  canonicalizeFederationHeaders,
  rawHeaderPairs,
  validateGenericControlRequest,
} from './delegation-headers';
import { FederationDelegationVerifierService } from './federation-delegation-verifier.service';
import { FederationRequestState } from './federation-request-context';
import { parseExactTargetApiRequest } from './exact-request-target';
import { buildNetworkContext } from '../common/http/network-context';
import { decodeDelegationClaims, DelegationClaims } from './delegation-envelope';

export const FEDERATION_ASSERTION_HEADER = 'x-meowbox-assertion';
export const FEDERATION_SIGNATURE_HEADER = 'x-meowbox-signature';

interface SignedRequest extends FederationRequestState {
  headers: Record<string, string | string[] | undefined>;
  rawHeaders: string[];
  method: string;
  networkContext?: ReturnType<typeof buildNetworkContext>;
}

export function hasFederationAssertionAttempt(
  headers: Record<string, string | string[] | undefined>,
): boolean {
  return headers[FEDERATION_ASSERTION_HEADER] !== undefined ||
    headers[FEDERATION_SIGNATURE_HEADER] !== undefined ||
    Object.keys(headers).some((name) => name.toLowerCase().startsWith('x-meowbox-'));
}

function reject(): never {
  throw new UnauthorizedException({
    success: false,
    error: {
      code: 'REMOTE_AUTH_FAILED',
      message: 'Federation request rejected',
    },
  });
}

function rejectClassified(error: unknown, decoded: DelegationClaims | null): never {
  const internalCode = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  let status = HttpStatus.UNAUTHORIZED;
  let code = 'REMOTE_AUTH_FAILED';
  let message = 'Federation request rejected';
  let retryable = false;
  let retryAfterSeconds: number | null = null;
  const verifiedBoundaryCodes = new Set([
    'ACTION_DENIED',
    'ACTOR_KIND_DENIED',
    'ROLE_DENIED',
    'ROLE_CEILING_EXCEEDED',
    'PERMISSION_DENIED',
    'IDEMPOTENCY_BINDING_MISMATCH',
    'REPLAY_DETECTED',
    'REPLAY_CAPACITY_EXCEEDED',
    'IDEMPOTENCY_CONFLICT',
    'IDEMPOTENCY_REPLAY',
    'SERVICE_PERMISSION_DENIED',
    'PRINCIPAL_VERSION_MISMATCH',
    'PRINCIPAL_TOMBSTONED',
    'SERVICE_SCOPE_DENIED',
  ]);

  if (internalCode === 'ACTION_DENIED') {
    status = HttpStatus.NOT_FOUND;
    code = 'REMOTE_ACTION_UNKNOWN';
    message = 'Federation action is not available';
  } else if ([
    'ACTOR_KIND_DENIED',
    'ROLE_DENIED',
    'ROLE_CEILING_EXCEEDED',
    'PERMISSION_DENIED',
    'SERVICE_PERMISSION_DENIED',
    'SERVICE_SCOPE_DENIED',
  ].includes(internalCode)) {
    status = HttpStatus.FORBIDDEN;
    code = 'REMOTE_PERMISSION_DENIED';
    message = 'Federation action is not permitted';
  } else if (internalCode.startsWith('IDEMPOTENCY_')) {
    status = HttpStatus.CONFLICT;
    code = 'REMOTE_IDEMPOTENCY_CONFLICT';
    message = 'Federation mutation requires reconciliation';
  } else if (internalCode === 'REPLAY_DETECTED') {
    status = HttpStatus.CONFLICT;
    code = 'REMOTE_REPLAY_REJECTED';
    message = 'Federation replay was rejected';
  } else if (internalCode === 'REPLAY_CAPACITY_EXCEEDED') {
    status = HttpStatus.SERVICE_UNAVAILABLE;
    code = 'REMOTE_REPLAY_REJECTED';
    message = 'Federation replay capacity is unavailable';
    retryable = true;
    retryAfterSeconds = 1;
  }

  const correlation = verifiedBoundaryCodes.has(internalCode) ? decoded : null;
  throw new HttpException({
    success: false,
    error: {
      code,
      message,
      requestId: correlation?.requestId ?? randomUUID(),
      targetInstallationId: correlation?.targetInstallationId ?? null,
      actionId: correlation?.actionId ?? null,
      retryable,
      retryAfterSeconds,
      targetStatus: status,
    },
  }, status);
}

function signedHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const value = headers[name];
  if (typeof value !== 'string' || value.length === 0) reject();
  return value;
}

function assertFederationHeaderNamespace(
  pairs: readonly (readonly [string, string])[],
): void {
  for (const [rawName] of pairs) {
    const name = rawName.toLowerCase();
    if (
      name.startsWith('x-meowbox-') &&
      name !== FEDERATION_ASSERTION_HEADER &&
      name !== FEDERATION_SIGNATURE_HEADER
    ) reject();
  }
}

@Injectable()
export class FederationDelegationGuard implements CanActivate {
  constructor(private readonly verifier: FederationDelegationVerifierService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<SignedRequest>();
    if (!hasFederationAssertionAttempt(request.headers)) return true;

    let decoded: DelegationClaims | null = null;
    try {
      const assertion = signedHeader(request.headers, FEDERATION_ASSERTION_HEADER);
      const signature = signedHeader(request.headers, FEDERATION_SIGNATURE_HEADER);
      decoded = decodeDelegationClaims(assertion);
      if (!Array.isArray(request.rawHeaders)) reject();
      const pairs = rawHeaderPairs(request.rawHeaders);
      assertFederationHeaderNamespace(pairs);
      const canonicalHeaders = canonicalizeFederationHeaders(pairs);

      if (request.body !== undefined && !Buffer.isBuffer(request.body)) reject();
      const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const method = request.method.toUpperCase();
      const control = validateGenericControlRequest(method, canonicalHeaders, rawBody);
      const target = parseExactTargetApiRequest(request.originalUrl || request.url || '');
      const federationContext = await this.verifier.verify({
        encoded: { assertion, signature },
        binding: {
          method,
          targetPathAndQuery: target.targetPathAndQuery,
          headers: canonicalHeaders,
          bodySha256: control.bodySha256,
        },
        concretePath: target.rawPath,
        idempotencyKey: control.idempotencyKey,
      });

      request.federationContext = federationContext;
      request.networkContext = buildNetworkContext(request);
      request.user = federationContext.actorKind === 'OPERATOR'
        ? {
            id: federationContext.userId!,
            sub: federationContext.userId!,
            username: 'federated-operator',
            role: federationContext.role,
            actorKind: 'OPERATOR',
          }
        : {
            sub: `service:${federationContext.principalId}`,
            username: 'federation-service',
            role: 'SERVICE',
            actorKind: 'SERVICE',
          };
      request.body = rawBody.length === 0
        ? undefined
        : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody));
      return true;
    } catch (error) {
      rejectClassified(error, decoded);
    }
  }
}
