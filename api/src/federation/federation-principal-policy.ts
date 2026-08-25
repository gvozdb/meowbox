const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SUBJECT = /^[\x21-\x7e]{1,128}$/;
const PERMISSION = /^[a-z][a-z0-9]*(?:[.:_-][a-z0-9]+)*$/;

export class FederationPrincipalError extends Error {
  constructor(
    readonly code:
      | 'INVALID_IDENTITY'
      | 'ISSUER_NOT_ACTIVE'
      | 'PRINCIPAL_VERSION_MISMATCH'
      | 'PRINCIPAL_TOMBSTONED'
      | 'PRINCIPAL_STATE_INVALID'
      | 'SERVICE_NOT_ENROLLED'
      | 'SERVICE_SCOPE_DENIED'
      | 'POLICY_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'FederationPrincipalError';
  }
}

export interface FederationIdentityBinding {
  issuerInstallationId: string;
  targetInstallationId: string;
  subject: string;
  principalVersion: number;
}

export function assertFederationIdentityBinding(
  input: FederationIdentityBinding,
): void {
  if (
    !CANONICAL_UUID.test(input.issuerInstallationId) ||
    !CANONICAL_UUID.test(input.targetInstallationId) ||
    input.issuerInstallationId === input.targetInstallationId ||
    !SUBJECT.test(input.subject) ||
    !Number.isSafeInteger(input.principalVersion) ||
    input.principalVersion < 1
  ) {
    throw new FederationPrincipalError(
      'INVALID_IDENTITY',
      'Federation principal identity is invalid',
    );
  }
}

export function assertActiveIssuer(issuer: {
  state: string;
  revokedAt: Date | null;
  principalVersion: number;
}, assertedPrincipalVersion: number): void {
  if (issuer.state !== 'ACTIVE' || issuer.revokedAt !== null) {
    throw new FederationPrincipalError(
      'ISSUER_NOT_ACTIVE',
      'Federation issuer is not active',
    );
  }
  if (issuer.principalVersion !== assertedPrincipalVersion) {
    throw new FederationPrincipalError(
      'PRINCIPAL_VERSION_MISMATCH',
      'Federation principal version is stale',
    );
  }
}

export function parseFederationPermissions(
  raw: string,
  label: string,
): ReadonlySet<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FederationPrincipalError('POLICY_INVALID', `${label} is invalid`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > 128 ||
    parsed.some((value) => typeof value !== 'string' || !PERMISSION.test(value)) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new FederationPrincipalError('POLICY_INVALID', `${label} is invalid`);
  }
  return new Set(parsed as string[]);
}

export function intersectFederationPermissions(
  asserted: readonly string[],
  ...policies: readonly ReadonlySet<string>[]
): string[] {
  if (
    asserted.length > 64 ||
    asserted.some((permission) => !PERMISSION.test(permission)) ||
    new Set(asserted).size !== asserted.length
  ) {
    throw new FederationPrincipalError(
      'INVALID_IDENTITY',
      'Federation permissions are invalid',
    );
  }
  return [...asserted]
    .filter((permission) => policies.every((policy) => policy.has(permission)))
    .sort();
}

