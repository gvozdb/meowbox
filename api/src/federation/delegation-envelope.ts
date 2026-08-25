import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import {
  FederationRelationshipKey,
  signFederationPayload,
  verifyFederationPayload,
} from './federation-key-material';
import { CanonicalFederationHeader } from './delegation-headers';

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_ID = /^ed25519-[A-Za-z0-9_-]{22}$/;
const ACTION_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9_-]+)+$/;
const PERMISSION = /^[a-z][a-z0-9]*(?:[.:_-][a-z0-9]+)*$/;
const METHOD = /^(?:DELETE|GET|HEAD|OPTIONS|PATCH|POST|PUT)$/;
const BODY_SHA256 = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{22,64}$/;
const SUBJECT = /^[\x21-\x7e]{1,128}$/;
const OPTIONAL_ID = /^(?:[A-Za-z0-9._:-]{8,128})$/;
const MAX_ASSERTION_TTL_SECONDS = 60;

export type DelegatedActorKind = 'OPERATOR' | 'SERVICE';
export type DelegatedRole = 'ADMIN' | 'MANAGER' | 'VIEWER' | 'SERVICE';

export interface DelegationClaims {
  keyId: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  requestId: string;
  targetInstallationId: string;
  actionId: string;
  actorKind: DelegatedActorKind;
  issuerInstallationId: string;
  subject: string;
  browserIp: string;
  role: DelegatedRole;
  permissions: readonly string[];
  principalVersion: number;
  operationId: string | null;
  idempotencyId: string | null;
}

export interface DelegationRequestBinding {
  method: string;
  targetPathAndQuery: string;
  headers: readonly CanonicalFederationHeader[];
  bodySha256: string;
}

export interface EncodedDelegationAssertion {
  assertion: string;
  signature: string;
}

export interface DelegationVerificationContext {
  expectedIssuerInstallationId: string;
  expectedTargetInstallationId: string;
  expectedKeyId: string;
  publicKeySpki: string;
  nowSeconds: number;
  clockSkewSeconds?: number;
}

export class DelegationAssertionError extends Error {
  constructor(
    readonly code:
      | 'INVALID_ASSERTION'
      | 'NON_CANONICAL_ASSERTION'
      | 'INVALID_CLAIMS'
      | 'ASSERTION_BINDING_MISMATCH'
      | 'ASSERTION_EXPIRED'
      | 'INVALID_SIGNATURE',
    message: string,
  ) {
    super(message);
    this.name = 'DelegationAssertionError';
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

function assertClaims(claims: DelegationClaims): void {
  const permissions = [...claims.permissions];
  if (
    !KEY_ID.test(claims.keyId) ||
    !CANONICAL_UUID.test(claims.requestId) ||
    !CANONICAL_UUID.test(claims.targetInstallationId) ||
    !CANONICAL_UUID.test(claims.issuerInstallationId) ||
    !ACTION_ID.test(claims.actionId) ||
    !NONCE.test(claims.nonce) ||
    !SUBJECT.test(claims.subject) ||
    claims.browserIp.length > 64 ||
    isIP(claims.browserIp) === 0 ||
    !['OPERATOR', 'SERVICE'].includes(claims.actorKind) ||
    !['ADMIN', 'MANAGER', 'VIEWER', 'SERVICE'].includes(claims.role) ||
    (claims.actorKind === 'SERVICE') !== (claims.role === 'SERVICE') ||
    !Number.isSafeInteger(claims.issuedAt) ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.expiresAt <= claims.issuedAt ||
    claims.expiresAt - claims.issuedAt > MAX_ASSERTION_TTL_SECONDS ||
    !Number.isSafeInteger(claims.principalVersion) ||
    claims.principalVersion < 1 ||
    permissions.length > 64 ||
    permissions.some((permission) => !PERMISSION.test(permission)) ||
    new Set(permissions).size !== permissions.length ||
    permissions.some((permission, index) => index > 0 && permissions[index - 1] > permission) ||
    (claims.operationId !== null && !OPTIONAL_ID.test(claims.operationId)) ||
    (claims.idempotencyId !== null && !OPTIONAL_ID.test(claims.idempotencyId))
  ) {
    throw new DelegationAssertionError(
      'INVALID_CLAIMS',
      'Delegation assertion contains invalid claims',
    );
  }
}

function assertBinding(binding: DelegationRequestBinding): void {
  if (
    !METHOD.test(binding.method) ||
    !binding.targetPathAndQuery.startsWith('/api/') ||
    !/^[\x21-\x7e]+$/.test(binding.targetPathAndQuery) ||
    !BODY_SHA256.test(binding.bodySha256)
  ) {
    throw new DelegationAssertionError(
      'INVALID_CLAIMS',
      'Delegation request binding is invalid',
    );
  }
  for (let index = 0; index < binding.headers.length; index += 1) {
    const header = binding.headers[index];
    if (
      !/^[a-z0-9-]+$/.test(header.name) ||
      !/^[\x20-\x7e]+$/.test(header.value) ||
      (index > 0 && binding.headers[index - 1].name >= header.name)
    ) {
      throw new DelegationAssertionError(
        'INVALID_CLAIMS',
        'Delegation headers are not canonical',
      );
    }
  }
}

function assertionBytes(claims: DelegationClaims): Buffer {
  return Buffer.from(canonicalJson(claims), 'utf8');
}

export function buildDelegationPayload(
  claims: DelegationClaims,
  binding: DelegationRequestBinding,
): Buffer {
  assertClaims(claims);
  assertBinding(binding);
  const canonicalHeaders = Buffer.from(canonicalJson(binding.headers), 'utf8').toString('base64url');
  const fields = [
    'MEOWBOX-EDDSA-V1',
    `key-id:${claims.keyId}`,
    `issued-at:${claims.issuedAt}`,
    `expires-at:${claims.expiresAt}`,
    `nonce:${claims.nonce}`,
    `request-id:${claims.requestId}`,
    `target-installation-id:${claims.targetInstallationId}`,
    `action-id:${claims.actionId}`,
    `actor-kind:${claims.actorKind}`,
    `issuer-installation-id:${claims.issuerInstallationId}`,
    `subject:${claims.subject}`,
    `browser-ip:${claims.browserIp}`,
    `role:${claims.role}`,
    `permissions:${claims.permissions.join(',')}`,
    `principal-version:${claims.principalVersion}`,
    `operation-id:${claims.operationId ?? '-'}`,
    `idempotency-id:${claims.idempotencyId ?? '-'}`,
    `method:${binding.method}`,
    `target:${binding.targetPathAndQuery}`,
    `headers:${canonicalHeaders}`,
    `body-sha256:${binding.bodySha256}`,
  ];
  return Buffer.from(`${fields.join('\n')}\n`, 'utf8');
}

export function newDelegationNonce(): string {
  return randomBytes(24).toString('base64url');
}

export function encodeDelegationAssertion(
  claims: DelegationClaims,
  binding: DelegationRequestBinding,
  relationship: FederationRelationshipKey,
): EncodedDelegationAssertion {
  if (
    claims.keyId !== relationship.kid ||
    claims.issuerInstallationId !== relationship.issuerInstallationId ||
    claims.targetInstallationId !== relationship.targetInstallationId
  ) {
    throw new DelegationAssertionError(
      'ASSERTION_BINDING_MISMATCH',
      'Delegation claims do not match the relationship key',
    );
  }
  const payload = buildDelegationPayload(claims, binding);
  return {
    assertion: assertionBytes(claims).toString('base64url'),
    signature: signFederationPayload(payload, relationship),
  };
}

export function decodeDelegationClaims(assertion: string): DelegationClaims {
  if (!/^[A-Za-z0-9_-]{1,8192}$/.test(assertion)) {
    throw new DelegationAssertionError(
      'INVALID_ASSERTION',
      'Delegation assertion encoding is invalid',
    );
  }
  let parsed: DelegationClaims;
  try {
    parsed = JSON.parse(Buffer.from(assertion, 'base64url').toString('utf8')) as DelegationClaims;
  } catch {
    throw new DelegationAssertionError(
      'INVALID_ASSERTION',
      'Delegation assertion JSON is invalid',
    );
  }
  assertClaims(parsed);
  if (assertionBytes(parsed).toString('base64url') !== assertion) {
    throw new DelegationAssertionError(
      'NON_CANONICAL_ASSERTION',
      'Delegation assertion is not canonical',
    );
  }
  return parsed;
}

export function verifyDelegationAssertion(
  encoded: EncodedDelegationAssertion,
  binding: DelegationRequestBinding,
  context: DelegationVerificationContext,
): DelegationClaims {
  const claims = decodeDelegationClaims(encoded.assertion);
  if (
    claims.issuerInstallationId !== context.expectedIssuerInstallationId ||
    claims.targetInstallationId !== context.expectedTargetInstallationId ||
    claims.keyId !== context.expectedKeyId
  ) {
    throw new DelegationAssertionError(
      'ASSERTION_BINDING_MISMATCH',
      'Delegation assertion issuer, target, or key does not match',
    );
  }
  const skew = context.clockSkewSeconds ?? 30;
  if (
    !Number.isSafeInteger(context.nowSeconds) ||
    skew < 0 ||
    claims.issuedAt > context.nowSeconds + skew ||
    claims.expiresAt < context.nowSeconds - skew
  ) {
    throw new DelegationAssertionError(
      'ASSERTION_EXPIRED',
      'Delegation assertion is outside its accepted time window',
    );
  }
  const payload = buildDelegationPayload(claims, binding);
  if (!verifyFederationPayload(payload, encoded.signature, context.publicKeySpki)) {
    throw new DelegationAssertionError(
      'INVALID_SIGNATURE',
      'Delegation signature verification failed',
    );
  }
  return claims;
}
