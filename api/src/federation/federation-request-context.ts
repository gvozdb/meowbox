import { FederationActionDescriptor } from '@meowbox/shared';
import { DelegatedActorKind, DelegatedRole } from './delegation-envelope';

export interface VerifiedFederationContext {
  verified: true;
  requestId: string;
  actionId: string;
  targetInstallationId: string;
  issuerInstallationId: string;
  issuerId: string;
  keyId: string;
  actorKind: DelegatedActorKind;
  subject: string;
  browserIp: string;
  role: DelegatedRole;
  principalVersion: number;
  effectivePermissions: readonly string[];
  descriptor: FederationActionDescriptor;
  userId: string | null;
  principalId: string;
  operationId: string | null;
  idempotencyKey: string | null;
  idempotencyReceiptId: string | null;
  replayHash: string;
}

export interface FederationAuthenticatedUser {
  id?: string;
  sub: string;
  username: string;
  role: DelegatedRole;
  actorKind: DelegatedActorKind;
}

export interface FederationRequestState {
  federationContext?: VerifiedFederationContext;
  user?: FederationAuthenticatedUser | unknown;
  body?: unknown;
  rawHeaders?: string[];
  originalUrl?: string;
  url?: string;
  method?: string;
  ip?: string;
  socket?: { remoteAddress?: string };
}

export function isVerifiedFederationRequest(
  request: FederationRequestState,
): request is FederationRequestState & { federationContext: VerifiedFederationContext } {
  return request.federationContext?.verified === true;
}
