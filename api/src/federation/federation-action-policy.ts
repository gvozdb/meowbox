import {
  FederationActionDescriptor,
  RemoteActionCapability,
} from '@meowbox/shared';
import { DelegationClaims } from './delegation-envelope';
import {
  intersectFederationPermissions,
  parseFederationPermissions,
} from './federation-principal-policy';

const OPERATOR_ROLE_RANK: Readonly<Record<'VIEWER' | 'MANAGER' | 'ADMIN', number>> = {
  VIEWER: 1,
  MANAGER: 2,
  ADMIN: 3,
};

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join('\0') === [...right].sort().join('\0');
}

export function federationCapabilityMatchesDescriptor(
  descriptor: FederationActionDescriptor,
  capability: RemoteActionCapability | undefined,
): capability is RemoteActionCapability {
  const deadline = descriptor.deadline;
  return !!capability &&
    capability.actionId === descriptor.actionId &&
    capability.schemaVersion === 1 &&
    sameStrings(capability.roles, descriptor.authorization.roles) &&
    sameStrings(capability.permissions, descriptor.authorization.permissions) &&
    sameStrings(capability.requestMedia, descriptor.request.media) &&
    sameStrings(capability.responseMedia, descriptor.response.media) &&
    capability.executionMode === descriptor.execution.mode &&
    capability.idempotency === descriptor.idempotency.policy &&
    capability.cancellation === descriptor.cancellation.policy &&
    capability.connectMs === deadline.connectMs &&
    capability.headersMs === deadline.headersMs &&
    capability.idleMs === deadline.idleMs &&
    capability.operationMs === deadline.operationMs &&
    capability.legacySafe === false;
}

export class FederationActionPolicyError extends Error {
  constructor(
    readonly code:
      | 'ACTION_UNKNOWN'
      | 'ACTOR_KIND_DENIED'
      | 'ROLE_DENIED'
      | 'ROLE_CEILING_EXCEEDED'
      | 'PERMISSION_DENIED'
      | 'IDEMPOTENCY_BINDING_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'FederationActionPolicyError';
  }
}

export interface AssertDelegatedActionPolicyInput {
  descriptor: FederationActionDescriptor;
  claims: DelegationClaims;
  issuerMaxRole: string;
  issuerPermissionPolicyJson: string;
  idempotencyKey: string | null;
}

export function assertDelegatedActionPolicy(
  input: AssertDelegatedActionPolicyInput,
): readonly string[] {
  const { claims, descriptor } = input;
  if (claims.actionId !== descriptor.actionId) {
    throw new FederationActionPolicyError('ACTION_UNKNOWN', 'Delegated action does not match the catalogue');
  }

  const serviceAction = descriptor.authorization.roles.includes('SERVICE');
  if ((claims.actorKind === 'SERVICE') !== serviceAction) {
    throw new FederationActionPolicyError('ACTOR_KIND_DENIED', 'Delegated actor kind is not allowed for this action');
  }

  if (claims.actorKind === 'OPERATOR') {
    if (claims.role === 'SERVICE' || !descriptor.authorization.roles.includes(claims.role)) {
      throw new FederationActionPolicyError('ROLE_DENIED', 'Delegated role is not allowed for this action');
    }
    if (!(input.issuerMaxRole in OPERATOR_ROLE_RANK)) {
      throw new FederationActionPolicyError('ROLE_CEILING_EXCEEDED', 'Federation issuer role ceiling is invalid');
    }
    const assertedRank = OPERATOR_ROLE_RANK[claims.role];
    const ceilingRank = OPERATOR_ROLE_RANK[input.issuerMaxRole as keyof typeof OPERATOR_ROLE_RANK];
    if (assertedRank > ceilingRank) {
      throw new FederationActionPolicyError('ROLE_CEILING_EXCEEDED', 'Delegated role exceeds the issuer ceiling');
    }
  } else if (claims.role !== 'SERVICE') {
    throw new FederationActionPolicyError('ROLE_DENIED', 'Service delegation requires the service role');
  }

  const effective = intersectFederationPermissions(
    claims.permissions,
    parseFederationPermissions(input.issuerPermissionPolicyJson, 'Federation issuer permission policy'),
    new Set(descriptor.authorization.permissions),
  );
  if (
    effective.length !== descriptor.authorization.permissions.length ||
    descriptor.authorization.permissions.some((permission) => !effective.includes(permission))
  ) {
    throw new FederationActionPolicyError('PERMISSION_DENIED', 'Delegated permissions do not satisfy the action policy');
  }

  if (claims.idempotencyId !== input.idempotencyKey) {
    throw new FederationActionPolicyError(
      'IDEMPOTENCY_BINDING_MISMATCH',
      'Delegation idempotency binding does not match the request header',
    );
  }
  return effective;
}
