import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { safeErrorMessage } from '@meowbox/shared';
import {
  FederationDispatcherService,
  FederationDispatchResponse,
  MasterFederationActor,
} from '../federation/federation-dispatcher.service';
import {
  federationResponseData,
  readBoundedFederationJson,
} from '../federation/federation-json-response';
import { RemoteContextService } from '../federation/remote-context.service';
import { RemoteRegistryService } from '../federation/remote-registry.service';
import { ProxyAuditService } from './proxy-audit.service';

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,128}$/;

export interface FederationTrustActor extends MasterFederationActor {
  browserIp: string;
  peerIp: string;
  userAgent: string | null;
}

interface TargetKeyStatus {
  kid: string;
  expiresAt: string | null;
  usable: boolean;
}

function targetRequestKey(requestKey: string, serverId: string, purpose: string): string {
  return `trust-${createHash('sha256')
    .update('MEOWBOX-FEDERATION-TRUST-V1\0')
    .update(requestKey)
    .update('\0')
    .update(serverId)
    .update('\0')
    .update(purpose)
    .digest('hex')}`;
}

function parseRotationResponse(value: unknown, expectedKid: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ServiceUnavailableException('Target key rotation response is invalid');
  }
  const data = value as Record<string, unknown>;
  if (
    data.newKid !== expectedKid ||
    typeof data.graceUntil !== 'string' ||
    !Number.isFinite(Date.parse(data.graceUntil))
  ) throw new ServiceUnavailableException('Target key rotation response is inconsistent');
  return { newKid: expectedKid, graceUntil: new Date(data.graceUntil) };
}

function parseTargetKeys(value: unknown): TargetKeyStatus[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const keys = (value as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) return [];
  return keys.flatMap((raw): TargetKeyStatus[] => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const key = raw as Record<string, unknown>;
    if (
      typeof key.kid !== 'string' ||
      typeof key.usable !== 'boolean' ||
      !(key.expiresAt === null || typeof key.expiresAt === 'string')
    ) return [];
    return [{ kid: key.kid, usable: key.usable, expiresAt: key.expiresAt as string | null }];
  });
}

@Injectable()
export class FederationTrustLifecycleService {
  constructor(
    private readonly contexts: RemoteContextService,
    private readonly registry: RemoteRegistryService,
    private readonly dispatcher: FederationDispatcherService,
    private readonly audit: ProxyAuditService,
  ) {}

  async rotate(
    serverId: string,
    actor: FederationTrustActor,
    idempotencyKey: string | undefined,
    graceSeconds = 3_600,
  ) {
    const requestKey = this.assertMutationInput(idempotencyKey, graceSeconds);
    await this.assertTrustActionReady(serverId, 'http.post.federation-v1-trust-keys');
    const prepared = await this.registry.prepareFederationKeyRotation(serverId);
    let rotation: { newKid: string; graceUntil: Date };
    try {
      const response = await this.dispatchJson(
        prepared,
        '/federation/v1/trust/keys',
        'POST',
        {
          previousKid: prepared.previousKid,
          newKid: prepared.newKid,
          newPublicKeySpki: prepared.newPublicKeySpki,
          graceSeconds,
        },
        actor,
        targetRequestKey(requestKey, serverId, prepared.newKid),
      );
      rotation = parseRotationResponse(response, prepared.newKid);
    } catch (rotationError) {
      try {
        const status = parseTargetKeys(await this.dispatchJson(
          prepared,
          '/federation/v1/trust/keys',
          'GET',
          undefined,
          actor,
        ));
        const next = status.find((key) => key.kid === prepared.newKid && key.usable);
        const previous = status.find((key) => key.kid === prepared.previousKid);
        if (!next || !previous?.expiresAt) throw rotationError;
        rotation = { newKid: next.kid, graceUntil: new Date(previous.expiresAt) };
      } catch {
        throw rotationError;
      }
    }
    const activated = await this.registry.activateFederationKeyRotation(
      serverId,
      rotation.newKid,
      rotation.graceUntil,
    );
    return {
      serverId,
      previousKid: prepared.previousKid,
      activeKid: activated.activeKid,
      graceUntil: activated.graceUntil,
      reconciled: prepared.replayed || activated.replayed,
    };
  }

  async revoke(
    serverId: string,
    actor: FederationTrustActor,
    idempotencyKey: string | undefined,
  ) {
    const requestKey = this.assertMutationInput(idempotencyKey, 3_600);
    let targetConfirmed = false;
    let targetError: string | null = null;
    try {
      const context = await this.contexts.getRemoteContext(serverId);
      await this.dispatchJson(
        { serverId, targetInstallationId: context.targetInstallationId },
        '/federation/v1/trust/revoke',
        'POST',
        {},
        actor,
        targetRequestKey(requestKey, serverId, 'revoke'),
      );
      targetConfirmed = true;
    } catch (error) {
      targetError = safeErrorMessage(error, 'Target revocation was not confirmed', 256);
    }
    const local = await this.registry.revokeFederationTrust(serverId);
    return { ...local, targetConfirmed, targetError };
  }

  private assertMutationInput(
    idempotencyKey: string | undefined,
    graceSeconds: number,
  ): string {
    const value = idempotencyKey?.trim() ?? '';
    if (!IDEMPOTENCY_KEY.test(value)) {
      throw new BadRequestException('Idempotency-Key must be 8-128 printable ASCII characters');
    }
    if (!Number.isSafeInteger(graceSeconds) || graceSeconds < 60 || graceSeconds > 86_400) {
      throw new BadRequestException('graceSeconds must be an integer between 60 and 86400');
    }
    return value;
  }

  private async assertTrustActionReady(serverId: string, actionId: string): Promise<void> {
    const context = await this.contexts.getRemoteContext(serverId);
    if (
      context.protocol.selected !== 1 ||
      context.protocol.mode !== 'v1-enabled' ||
      context.killSwitches.http ||
      context.status.transport.state !== 'ONLINE' ||
      context.status.trust.state !== 'ACTIVE' ||
      !context.capabilities[actionId]?.enabled
    ) throw new ServiceUnavailableException('Federated target is not ready for trust rotation');
  }

  private async dispatchJson(
    target: { serverId: string; targetInstallationId: string },
    suffix: string,
    method: 'GET' | 'POST',
    payload: unknown,
    actor: FederationTrustActor,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const body = payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload));
    const rawHeaders = [
      'accept',
      'application/json',
      ...(payload === undefined ? [] : ['content-type', 'application/json']),
      ...(idempotencyKey ? ['idempotency-key', idempotencyKey] : []),
    ];
    const context = await this.contexts.getRemoteContext(target.serverId);
    const startedAt = Date.now();
    let response: FederationDispatchResponse | null = null;
    let errorMessage: string | null = null;
    try {
      response = await this.dispatcher.dispatch({
        targetInstallationId: target.targetInstallationId,
        inboundTarget: `/api/proxy/${target.targetInstallationId}${suffix}`,
        method,
        rawHeaders,
        body,
        actor: { id: actor.id, role: actor.role },
        browserIp: actor.browserIp,
      });
      const value = await readBoundedFederationJson(
        response.body as unknown as AsyncIterable<Buffer | Uint8Array>,
      );
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new ServiceUnavailableException(`Federated target returned HTTP ${response.statusCode}`);
      }
      return federationResponseData(value);
    } catch (error) {
      errorMessage = safeErrorMessage(error, 'Federated trust request failed', 256);
      throw error;
    } finally {
      await this.audit.logOut({
        userId: actor.id,
        serverId: target.serverId,
        serverName: context.displayName,
        method,
        path: `/api${suffix}`,
        statusCode: response?.statusCode ?? null,
        durationMs: Date.now() - startedAt,
        ipAddress: actor.browserIp,
        peerIp: actor.peerIp,
        browserIp: actor.browserIp,
        userAgent: actor.userAgent,
        errorMsg: errorMessage,
        requestId: response?.requestId ?? null,
        actionId: response?.actionId ?? null,
        issuerInstallationId: response?.issuerInstallationId ?? null,
        targetInstallationId: response?.targetInstallationId ?? target.targetInstallationId,
        keyId: response?.keyId ?? null,
        actorKind: 'OPERATOR',
      });
    }
  }
}

