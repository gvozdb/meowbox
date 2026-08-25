import { Injectable } from '@nestjs/common';
import {
  FederationActionDescriptor,
  FederationErrorCode,
  FederationErrorContract,
  RemoteActionCapability,
} from '@meowbox/shared';
import { Dispatcher, request as undiciRequest } from 'undici';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import {
  canonicalizeFederationHeaders,
  rawHeaderPairs,
  validateGenericControlRequest,
} from './delegation-headers';
import {
  DelegatedRole,
  DelegationClaims,
  encodeDelegationAssertion,
  newDelegationNonce,
} from './delegation-envelope';
import { FederationActionCatalogueService } from './federation-action-catalogue.service';
import {
  assertDelegatedActionPolicy,
  federationCapabilityMatchesDescriptor,
} from './federation-action-policy';
import { FederationDispatcherPoolService } from './federation-dispatcher-pool.service';
import { parseExactFederationTarget } from './exact-request-target';
import { FederationRelationshipKey } from './federation-key-material';
import { PanelIdentityService } from './panel-identity.service';
import { RemoteContextService } from './remote-context.service';

const MUTATION_METHODS = new Set(['DELETE', 'PATCH', 'POST', 'PUT']);
const FORBIDDEN_RESPONSE_HEADERS = new Set(['set-cookie']);
const SAFE_RESPONSE_HEADERS = new Set([
  'accept-ranges',
  'cache-control',
  'content-disposition',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
  'retry-after',
]);

export interface MasterFederationActor {
  id: string;
  role: 'ADMIN' | 'MANAGER' | 'VIEWER';
}

export interface FederationDispatchInput {
  targetInstallationId: string;
  inboundTarget: string;
  method: string;
  rawHeaders: readonly string[];
  body: Buffer;
  actor: MasterFederationActor;
  browserIp: string;
  signal?: AbortSignal;
}

export interface FederationServiceDispatchInput {
  targetInstallationId: string;
  inboundTarget: string;
  method: string;
  rawHeaders: readonly string[];
  body: Buffer;
  serviceSubject: string;
  browserIp: string;
  signal?: AbortSignal;
}

type MasterDelegatedActor =
  | Readonly<{ kind: 'OPERATOR'; subject: string; role: MasterFederationActor['role'] }>
  | Readonly<{ kind: 'SERVICE'; subject: string; role: 'SERVICE' }>;

type FederationActorDispatchInput = Omit<FederationDispatchInput, 'actor'> & {
  actor: MasterDelegatedActor;
};

export interface FederationDispatchResponse {
  requestId: string;
  actionId: string;
  targetInstallationId: string;
  issuerInstallationId: string;
  keyId: string;
  statusCode: number;
  headers: Readonly<Record<string, string | readonly string[]>>;
  body: Dispatcher.ResponseData['body'];
}

export type FederationRouteTarget =
  | Readonly<{ kind: 'V1'; serverId: string; displayName: string; targetInstallationId: string }>
  | Readonly<{ kind: 'LEGACY_UPGRADE_ONLY'; serverId: string; displayName: string }>
  | Readonly<{ kind: 'LEGACY_STATIC_V0' }>;

export class FederationDispatchError extends Error {
  constructor(
    readonly contract: FederationErrorContract,
    readonly httpStatus: number,
    options?: ErrorOptions,
  ) {
    super(contract.message, options);
    this.name = 'FederationDispatchError';
  }
}

function assertCapability(
  descriptor: FederationActionDescriptor,
  capability: RemoteActionCapability | undefined,
  role: DelegatedRole,
): RemoteActionCapability {
  if (
    !capability ||
    !capability.enabled ||
    !federationCapabilityMatchesDescriptor(descriptor, capability) ||
    !capability.roles.includes(role) ||
    !descriptor.authorization.roles.includes(role)
  ) throw new Error('Target capability does not match the local action catalogue');
  return capability;
}

function safeResponseHeaders(
  headers: Record<string, string | string[] | undefined>,
): Readonly<Record<string, string | readonly string[]>> {
  const result: Record<string, string | readonly string[]> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (value === undefined || !SAFE_RESPONSE_HEADERS.has(name)) continue;
    result[name] = value;
  }
  return result;
}

function responseMedia(headers: Record<string, string | string[] | undefined>): string | null {
  const value = headers['content-type'];
  const first = Array.isArray(value) ? value[0] : value;
  return first?.split(';', 1)[0].trim().toLowerCase() || null;
}

function transportErrorCode(error: unknown): FederationErrorCode {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  if (code === 'UND_ERR_CONNECT_TIMEOUT') return 'REMOTE_CONNECT_TIMEOUT';
  if (code === 'UND_ERR_HEADERS_TIMEOUT') return 'REMOTE_HEADER_TIMEOUT';
  if (code === 'UND_ERR_BODY_TIMEOUT') return 'REMOTE_IDLE_TIMEOUT';
  if (/CERT|TLS|SSL|SELF_SIGNED|ALTNAME/i.test(code)) return 'REMOTE_TLS_FAILED';
  if (/ENOTFOUND|EAI_AGAIN|DNS/i.test(code)) return 'REMOTE_DNS_FAILED';
  if (error instanceof Error && error.name === 'AbortError') return 'REMOTE_ABORTED';
  return 'REMOTE_OFFLINE';
}

function errorContract(
  code: FederationErrorCode,
  requestId: string,
  targetInstallationId: string | null,
  actionId: string | null,
  message: string,
  targetStatus: number | null = null,
): FederationErrorContract {
  return {
    code,
    message,
    requestId,
    targetInstallationId,
    actionId,
    retryable: [
      'REMOTE_OFFLINE',
      'REMOTE_DNS_FAILED',
      'REMOTE_CONNECT_TIMEOUT',
      'REMOTE_HEADER_TIMEOUT',
      'REMOTE_IDLE_TIMEOUT',
    ].includes(code),
    retryAfterSeconds: null,
    targetStatus,
  };
}

@Injectable()
export class FederationDispatcherService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly panelIdentity: PanelIdentityService,
    private readonly contexts: RemoteContextService,
    private readonly catalogue: FederationActionCatalogueService,
    private readonly dispatcherPool: FederationDispatcherPoolService,
  ) {}

  async resolveRouteTarget(identifier: string): Promise<FederationRouteTarget> {
    const v1 = await this.prisma.remoteServer.findUnique({
      where: { installationId: identifier },
      select: { id: true, displayName: true, installationId: true },
    });
    if (v1?.installationId) {
      return {
        kind: 'V1',
        serverId: v1.id,
        displayName: v1.displayName,
        targetInstallationId: v1.installationId,
      };
    }
    const legacy = await this.prisma.remoteServer.findUnique({
      where: { id: identifier },
      select: { id: true, displayName: true, activationMode: true },
    });
    return legacy?.activationMode === 'LEGACY_UPGRADE_ONLY'
      ? { kind: 'LEGACY_UPGRADE_ONLY', serverId: legacy.id, displayName: legacy.displayName }
      : { kind: 'LEGACY_STATIC_V0' };
  }

  async dispatch(input: FederationDispatchInput): Promise<FederationDispatchResponse> {
    return this.dispatchAs({
      ...input,
      actor: { kind: 'OPERATOR', subject: input.actor.id, role: input.actor.role },
    });
  }

  async dispatchService(
    input: FederationServiceDispatchInput,
  ): Promise<FederationDispatchResponse> {
    return this.dispatchAs({
      ...input,
      actor: { kind: 'SERVICE', subject: input.serviceSubject, role: 'SERVICE' },
    });
  }

  private async dispatchAs(
    input: FederationActorDispatchInput,
  ): Promise<FederationDispatchResponse> {
    const requestId = randomUUID();
    let actionId: string | null = null;
    try {
      const method = input.method.toUpperCase();
      const target = parseExactFederationTarget(
        input.inboundTarget,
        input.targetInstallationId,
      );
      const descriptor = this.catalogue.resolveHttpByConcretePath(method, target.rawPath);
      if (
        !descriptor ||
        descriptor.owner !== 'target' ||
        !['INTERACTIVE', 'OPERATION', 'STAGED_ARTIFACT', 'APP_HANDOFF'].includes(
          descriptor.execution.mode,
        )
      ) {
        throw new FederationDispatchError(
          errorContract(
            'REMOTE_ACTION_UNKNOWN',
            requestId,
            input.targetInstallationId,
            null,
            'Remote action is not catalogued for this transport',
          ),
          404,
        );
      }
      actionId = descriptor.actionId;
      if (!descriptor.authorization.roles.includes(input.actor.role)) {
        throw new FederationDispatchError(
          errorContract('REMOTE_PERMISSION_DENIED', requestId, input.targetInstallationId, actionId, 'Remote action is not allowed for this role'),
          403,
        );
      }

      const server = await this.prisma.remoteServer.findUnique({
        where: { installationId: input.targetInstallationId },
        include: {
          endpoints: { orderBy: { generation: 'desc' } },
          issuers: {
            include: { keys: { orderBy: { validFrom: 'desc' } } },
          },
        },
      });
      if (!server) {
        throw new FederationDispatchError(
          errorContract('REMOTE_DISABLED', requestId, input.targetInstallationId, actionId, 'Remote target is not registered'),
          404,
        );
      }
      const context = await this.contexts.getRemoteContext(server.id);
      if (
        context.topologyMode !== 'PUBLIC' ||
        context.killSwitches.http ||
        (input.actor.kind === 'SERVICE' && context.killSwitches.publicDelivery) ||
        context.protocol.selected !== 1 ||
        !['v1-read-only', 'v1-enabled'].includes(context.protocol.mode) ||
        context.status.transport.state !== 'ONLINE' ||
        context.status.trust.state !== 'ACTIVE' ||
        !['FRESH', 'PARTIAL'].includes(context.status.capability.state) ||
        Date.parse(context.manifest.validUntil) <= Date.now()
      ) {
        throw new FederationDispatchError(
          errorContract('REMOTE_NOT_READY', requestId, input.targetInstallationId, actionId, 'Remote target is not ready for delegated HTTP'),
          503,
        );
      }
      if (context.protocol.mode === 'v1-read-only' && MUTATION_METHODS.has(method)) {
        throw new FederationDispatchError(
          errorContract('REMOTE_POLICY_BLOCKED', requestId, input.targetInstallationId, actionId, 'Remote target is read-only'),
          403,
        );
      }
      const capability = assertCapability(descriptor, context.capabilities[actionId], input.actor.role);
      const canonicalHeaders = canonicalizeFederationHeaders(rawHeaderPairs(input.rawHeaders));
      const control = validateGenericControlRequest(method, canonicalHeaders, input.body);

      const identity = await this.panelIdentity.getLocalIdentity();
      if (identity.installationRole !== 'MASTER') throw new Error('Federation dispatcher requires a master installation');
      const issuer = server.issuers.find((candidate) =>
        candidate.issuerInstallationId === identity.installationId &&
        candidate.targetInstallationId === input.targetInstallationId &&
        candidate.state === 'ACTIVE' &&
        candidate.revokedAt === null);
      const now = new Date();
      const key = issuer?.keys.find((candidate) =>
        candidate.state === 'ACTIVE' &&
        candidate.revokedAt === null &&
        candidate.validFrom <= now &&
        (candidate.expiresAt === null || candidate.expiresAt > now) &&
        candidate.encryptedPrivateKey !== null);
      if (!issuer || !key || !key.encryptedPrivateKey) {
        throw new FederationDispatchError(
          errorContract('REMOTE_AUTH_FAILED', requestId, input.targetInstallationId, actionId, 'Remote trust is unavailable'),
          503,
        );
      }

      const nowSeconds = Math.floor(now.getTime() / 1_000);
      const claims: DelegationClaims = {
        keyId: key.kid,
        issuedAt: nowSeconds,
        expiresAt: nowSeconds + 60,
        nonce: newDelegationNonce(),
        requestId,
        targetInstallationId: input.targetInstallationId,
        actionId,
        actorKind: input.actor.kind,
        issuerInstallationId: identity.installationId,
        subject: input.actor.subject,
        browserIp: input.browserIp,
        role: input.actor.role,
        permissions: [...descriptor.authorization.permissions].sort(),
        principalVersion: issuer.principalVersion,
        operationId: null,
        idempotencyId: control.idempotencyKey,
      };
      assertDelegatedActionPolicy({
        descriptor,
        claims,
        issuerMaxRole: issuer.maxRole,
        issuerPermissionPolicyJson: issuer.permissionPolicyJson,
        idempotencyKey: control.idempotencyKey,
      });
      const binding = {
        method,
        targetPathAndQuery: target.targetPathAndQuery,
        headers: canonicalHeaders,
        bodySha256: control.bodySha256,
      };
      const signed = encodeDelegationAssertion(claims, binding, {
        issuerInstallationId: identity.installationId,
        targetInstallationId: input.targetInstallationId,
        kid: key.kid,
        publicKeySpki: key.publicKeySpki,
        encryptedPrivateKey: key.encryptedPrivateKey,
      } satisfies FederationRelationshipKey);

      const endpoint = server.endpoints.find((candidate) =>
        candidate.generation === server.activeEndpointGeneration &&
        candidate.state === 'ACTIVE' &&
        candidate.verifiedAt !== null);
      if (!endpoint) throw new Error('Active federation endpoint is unavailable');
      const outboundHeaders: Record<string, string> = Object.fromEntries(
        canonicalHeaders.map(({ name, value }) => [name, value]),
      );
      outboundHeaders['x-meowbox-assertion'] = signed.assertion;
      outboundHeaders['x-meowbox-signature'] = signed.signature;

      const response = await undiciRequest(
        `${endpoint.apiOrigin}${target.targetPathAndQuery}`,
        {
          method: method as Dispatcher.HttpMethod,
          headers: outboundHeaders,
          body: input.body.length === 0 ? undefined : input.body,
          dispatcher: this.dispatcherPool.get({
            apiOrigin: endpoint.apiOrigin,
            spkiSha256: endpoint.spkiSha256,
            caCertificatePem: endpoint.caCertificatePem,
            connectTimeoutMs: capability.connectMs,
          }),
          headersTimeout: capability.headersMs,
          bodyTimeout: capability.idleMs,
          maxRedirections: 0,
          signal: input.signal,
        },
      );
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.body.destroy();
        throw new FederationDispatchError(
          errorContract('REMOTE_APPLICATION_ERROR', requestId, input.targetInstallationId, actionId, 'Remote redirect was rejected', response.statusCode),
          502,
        );
      }
      if ([...FORBIDDEN_RESPONSE_HEADERS].some((header) => response.headers[header] !== undefined)) {
        response.body.destroy();
        throw new FederationDispatchError(
          errorContract('REMOTE_APPLICATION_ERROR', requestId, input.targetInstallationId, actionId, 'Remote response attempted to set a cookie', response.statusCode),
          502,
        );
      }
      const media = responseMedia(response.headers);
      if (
        response.statusCode !== 204 &&
        (media === null || !descriptor.response.media.map((value) => value.toLowerCase()).includes(media))
      ) {
        response.body.destroy();
        throw new FederationDispatchError(
          errorContract('REMOTE_SCHEMA_MISMATCH', requestId, input.targetInstallationId, actionId, 'Remote response media is not declared', response.statusCode),
          502,
        );
      }
      return {
        requestId,
        actionId,
        targetInstallationId: input.targetInstallationId,
        issuerInstallationId: identity.installationId,
        keyId: key.kid,
        statusCode: response.statusCode,
        headers: safeResponseHeaders(response.headers),
        body: response.body,
      };
    } catch (error) {
      if (error instanceof FederationDispatchError) throw error;
      const code = transportErrorCode(error);
      throw new FederationDispatchError(
        errorContract(code, requestId, input.targetInstallationId, actionId, 'Remote transport failed'),
        code === 'REMOTE_ABORTED' ? 499 : 502,
        { cause: error },
      );
    }
  }
}
