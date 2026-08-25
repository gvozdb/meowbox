import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  FederatedWsChannelAssertion,
  validateFederatedWsChannelAssertion,
} from '@meowbox/shared';
import {
  FederationRelationshipKey,
  signFederationPayload,
  verifyFederationPayload,
} from './federation-key-material';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_ID = /^ed25519-[A-Za-z0-9_-]{22}$/;
const ACTION_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9_-]+)+$/;
const PERMISSION = /^[a-z][a-z0-9]*(?:[.:_-][a-z0-9]+)*$/;
const NONCE = /^[A-Za-z0-9_-]{22,64}$/;
const SUBJECT = /^[\x21-\x7e]{1,128}$/;
const MAX_TTL_SECONDS = 60;

export interface FederationWsChannelClaims {
  keyId: string;
  channelId: string;
  targetInstallationId: string;
  issuerInstallationId: string;
  actorKind: 'OPERATOR' | 'SERVICE';
  subject: string;
  browserIp: string;
  role: 'ADMIN' | 'MANAGER' | 'VIEWER' | 'SERVICE';
  permissions: readonly string[];
  principalVersion: number;
  epoch: number;
  nonce: string;
  actionIds: readonly string[];
  issuedAt: number;
  expiresAt: number;
}

export interface FederationWsChannelVerificationContext {
  expectedIssuerInstallationId: string;
  expectedTargetInstallationId: string;
  expectedKeyId: string;
  publicKeySpki: string;
  nowSeconds: number;
  clockSkewSeconds?: number;
}

export class FederationWsChannelError extends Error {
  constructor(
    readonly code:
      | 'INVALID_CHANNEL_ASSERTION'
      | 'NON_CANONICAL_CHANNEL_ASSERTION'
      | 'CHANNEL_BINDING_MISMATCH'
      | 'CHANNEL_EXPIRED'
      | 'INVALID_CHANNEL_SIGNATURE',
    message: string,
  ) {
    super(message);
    this.name = FederationWsChannelError.name;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function assertSortedUnique(
  values: readonly string[],
  pattern: RegExp,
  max: number,
): boolean {
  return values.length <= max && values.every((value, index) =>
    pattern.test(value) && (index === 0 || values[index - 1] < value));
}

function assertClaims(claims: FederationWsChannelClaims): void {
  if (
    !KEY_ID.test(claims.keyId) ||
    !UUID.test(claims.channelId) ||
    !UUID.test(claims.targetInstallationId) ||
    !UUID.test(claims.issuerInstallationId) ||
    !NONCE.test(claims.nonce) ||
    !SUBJECT.test(claims.subject) ||
    isIP(claims.browserIp) === 0 ||
    claims.browserIp.length > 64 ||
    !['OPERATOR', 'SERVICE'].includes(claims.actorKind) ||
    !['ADMIN', 'MANAGER', 'VIEWER', 'SERVICE'].includes(claims.role) ||
    (claims.actorKind === 'SERVICE') !== (claims.role === 'SERVICE') ||
    !Number.isSafeInteger(claims.principalVersion) ||
    claims.principalVersion < 1 ||
    !Number.isSafeInteger(claims.epoch) ||
    claims.epoch < 1 ||
    !Number.isSafeInteger(claims.issuedAt) ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.expiresAt <= claims.issuedAt ||
    claims.expiresAt - claims.issuedAt > MAX_TTL_SECONDS ||
    claims.actionIds.length === 0 ||
    !assertSortedUnique(claims.actionIds, ACTION_ID, 128) ||
    !assertSortedUnique(claims.permissions, PERMISSION, 64)
  ) {
    throw new FederationWsChannelError(
      'INVALID_CHANNEL_ASSERTION',
      'Federation WS channel claims are invalid',
    );
  }
}

function assertionBytes(claims: FederationWsChannelClaims): Buffer {
  return Buffer.from(canonicalJson(claims), 'utf8');
}

export function buildFederationWsChannelPayload(
  claims: FederationWsChannelClaims,
): Buffer {
  assertClaims(claims);
  return Buffer.from([
    'MEOWBOX-WS-EDDSA-V1',
    `key-id:${claims.keyId}`,
    `channel-id:${claims.channelId}`,
    `target-installation-id:${claims.targetInstallationId}`,
    `issuer-installation-id:${claims.issuerInstallationId}`,
    `actor-kind:${claims.actorKind}`,
    `subject:${claims.subject}`,
    `browser-ip:${claims.browserIp}`,
    `role:${claims.role}`,
    `permissions:${claims.permissions.join(',')}`,
    `principal-version:${claims.principalVersion}`,
    `epoch:${claims.epoch}`,
    `nonce:${claims.nonce}`,
    `action-ids:${claims.actionIds.join(',')}`,
    `issued-at:${claims.issuedAt}`,
    `expires-at:${claims.expiresAt}`,
    '',
  ].join('\n'), 'utf8');
}

export function newFederationWsChannelNonce(): string {
  return randomBytes(24).toString('base64url');
}

export function issueFederationWsChannelAssertion(
  claims: FederationWsChannelClaims,
  relationship: FederationRelationshipKey,
): FederatedWsChannelAssertion {
  if (
    claims.keyId !== relationship.kid ||
    claims.issuerInstallationId !== relationship.issuerInstallationId ||
    claims.targetInstallationId !== relationship.targetInstallationId
  ) {
    throw new FederationWsChannelError(
      'CHANNEL_BINDING_MISMATCH',
      'Federation WS channel does not match relationship key',
    );
  }
  const assertion = assertionBytes(claims).toString('base64url');
  return validateFederatedWsChannelAssertion({
    channelId: claims.channelId,
    targetInstallationId: claims.targetInstallationId,
    epoch: claims.epoch,
    nonce: claims.nonce,
    actionIds: claims.actionIds,
    issuedAt: new Date(claims.issuedAt * 1_000).toISOString(),
    expiresAt: new Date(claims.expiresAt * 1_000).toISOString(),
    assertion,
    signature: signFederationPayload(
      buildFederationWsChannelPayload(claims),
      relationship,
    ),
  });
}

export function decodeFederationWsChannelClaims(
  assertion: string,
): FederationWsChannelClaims {
  if (!/^[A-Za-z0-9_-]{1,16384}$/.test(assertion)) {
    throw new FederationWsChannelError('INVALID_CHANNEL_ASSERTION', 'Channel assertion encoding is invalid');
  }
  let claims: FederationWsChannelClaims;
  try {
    claims = JSON.parse(Buffer.from(assertion, 'base64url').toString('utf8')) as FederationWsChannelClaims;
  } catch {
    throw new FederationWsChannelError('INVALID_CHANNEL_ASSERTION', 'Channel assertion JSON is invalid');
  }
  assertClaims(claims);
  if (assertionBytes(claims).toString('base64url') !== assertion) {
    throw new FederationWsChannelError(
      'NON_CANONICAL_CHANNEL_ASSERTION',
      'Channel assertion is not canonical',
    );
  }
  return claims;
}

export function verifyFederationWsChannelAssertion(
  input: FederatedWsChannelAssertion,
  context: FederationWsChannelVerificationContext,
): FederationWsChannelClaims {
  const envelope = validateFederatedWsChannelAssertion(input);
  const claims = decodeFederationWsChannelClaims(envelope.assertion);
  if (
    claims.keyId !== context.expectedKeyId ||
    claims.issuerInstallationId !== context.expectedIssuerInstallationId ||
    claims.targetInstallationId !== context.expectedTargetInstallationId ||
    claims.channelId !== envelope.channelId ||
    claims.targetInstallationId !== envelope.targetInstallationId ||
    claims.epoch !== envelope.epoch ||
    claims.nonce !== envelope.nonce ||
    claims.actionIds.length !== envelope.actionIds.length ||
    claims.actionIds.some((actionId, index) => actionId !== envelope.actionIds[index]) ||
    new Date(claims.issuedAt * 1_000).toISOString() !== envelope.issuedAt ||
    new Date(claims.expiresAt * 1_000).toISOString() !== envelope.expiresAt
  ) {
    throw new FederationWsChannelError(
      'CHANNEL_BINDING_MISMATCH',
      'Federation WS channel envelope binding mismatch',
    );
  }
  const skew = context.clockSkewSeconds ?? 30;
  if (
    !Number.isSafeInteger(context.nowSeconds) ||
    skew < 0 ||
    claims.issuedAt > context.nowSeconds + skew ||
    claims.expiresAt < context.nowSeconds - skew
  ) {
    throw new FederationWsChannelError('CHANNEL_EXPIRED', 'Federation WS channel is outside its time window');
  }
  if (!verifyFederationPayload(
    buildFederationWsChannelPayload(claims),
    envelope.signature,
    context.publicKeySpki,
  )) {
    throw new FederationWsChannelError('INVALID_CHANNEL_SIGNATURE', 'Federation WS channel signature is invalid');
  }
  return claims;
}
