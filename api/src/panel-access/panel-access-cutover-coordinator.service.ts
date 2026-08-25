import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { request } from 'undici';
import { io } from 'socket.io-client';
import {
  FEDERATION_PROTOCOL_VERSION,
  type SignedFederationManifest,
} from '@meowbox/shared';
import { PrismaService } from '../common/prisma.service';
import {
  FederationDispatcherService,
  MasterFederationActor,
} from '../federation/federation-dispatcher.service';
import { FederationManifestVerifierService } from '../federation/federation-manifest-verifier.service';
import { createPinnedFederationDispatcher } from '../federation/pinned-dispatcher';
import { createPinnedSocketAgent } from '../federation/federation-socket-dialer';
import { FederationWsChannelIssuerService } from '../federation/federation-ws-channel-issuer.service';
import { RemoteRegistryService } from '../federation/remote-registry.service';
import { RemoteOperationLinkService } from '../operations/remote-operation-link.service';
import { StartPanelAccessCutoverDto } from './panel-access.dto';
import { PANEL_ACCESS_CUTOVER_ACTION } from './panel-access-cutover.types';

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TERMINAL_OPERATION_STATES = new Set([
  'CANCELLED',
  'FAILED',
  'NEEDS_ATTENTION',
  'SUCCEEDED',
  'UNKNOWN_RECOVERY_REQUIRED',
]);
const ROLLBACK_SAFE_OPERATION_STATES = new Set(['CANCELLED', 'FAILED', 'SUCCEEDED']);
const MAX_JSON_BYTES = 1024 * 1024;

interface TargetOperationTicket {
  operationId: string;
  requestId: string;
  state: string;
}

interface TargetOperationView {
  id: string;
  status: string;
  result: unknown;
  errorMessage: string | null;
}

interface CandidateResult {
  cutoverId: string;
  state: 'STAGED';
  candidate: {
    endpoints: {
      apiOrigin: string;
      apiPath: '/api';
      wsOrigin: string;
      socketPath: string;
      browserPublicOrigin: string;
      directTransferOrigin: string;
    };
    spkiSha256: string;
    manifest: SignedFederationManifest;
  };
}

function deterministicCutoverId(
  serverId: string,
  userId: string,
  idempotencyKey: string,
): string {
  const bytes = createHash('sha256')
    .update('MEOWBOX-PANEL-ACCESS-CUTOVER-V1\0')
    .update(serverId)
    .update('\0')
    .update(userId)
    .update('\0')
    .update(idempotencyKey)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function targetTicket(value: unknown): TargetOperationTicket {
  const ticket = value as TargetOperationTicket;
  if (
    !ticket ||
    !UUID.test(ticket.operationId) ||
    !UUID.test(ticket.requestId) ||
    typeof ticket.state !== 'string'
  ) throw new ConflictException('Target returned an invalid operation ticket');
  return ticket;
}

function targetOperation(value: unknown, expectedId: string): TargetOperationView {
  const operation = value as TargetOperationView;
  if (
    !operation ||
    operation.id !== expectedId ||
    typeof operation.status !== 'string' ||
    (operation.errorMessage !== null && typeof operation.errorMessage !== 'string')
  ) throw new ConflictException('Target returned an invalid operation status');
  return operation;
}

function candidateResult(value: unknown, cutoverId: string): CandidateResult {
  const result = value as CandidateResult;
  if (
    !result ||
    result.cutoverId !== cutoverId ||
    result.state !== 'STAGED' ||
    !result.candidate ||
    typeof result.candidate.spkiSha256 !== 'string' ||
    !result.candidate.endpoints
  ) throw new ConflictException('Target returned an invalid endpoint candidate');
  return result;
}

@Injectable()
export class PanelAccessCutoverCoordinatorService
implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: FederationDispatcherService,
    private readonly manifests: FederationManifestVerifierService,
    private readonly wsIssuer: FederationWsChannelIssuerService,
    private readonly registry: RemoteRegistryService,
    private readonly operationLinks: RemoteOperationLinkService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.reconcileExpired().catch(() => undefined);
    }, 10_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async start(
    serverId: string,
    dto: StartPanelAccessCutoverDto,
    actor: MasterFederationActor,
    browserIp: string,
    idempotencyKey?: string,
  ) {
    if (actor.role !== 'ADMIN') throw new BadRequestException('Panel Access cutover requires ADMIN');
    this.assertIdempotencyKey(idempotencyKey);
    const cutoverId = deterministicCutoverId(serverId, actor.id, idempotencyKey);
    const existing = await this.prisma.remoteEndpointCutover.findUnique({ where: { id: cutoverId } });
    if (existing) {
      if (existing.remoteServerId !== serverId) throw new ConflictException('Cutover idempotency conflict');
      if (existing.state === 'PREPARED') {
        const link = await this.prisma.remoteOperationLink.findFirst({
          where: { remoteServerId: serverId, correlationId: cutoverId },
        });
        if (!link) {
          await this.startTargetStage(
            await this.server(serverId),
            existing.deadlineAt,
            cutoverId,
            dto,
            actor,
            browserIp,
          );
        }
      }
      await this.reconcile(cutoverId, actor, browserIp);
      return this.view(cutoverId);
    }
    const server = await this.server(serverId);
    const deadlineAt = new Date(Date.now() + 15 * 60_000);
    await this.registry.prepareEndpointCutover({ cutoverId, remoteServerId: serverId, deadlineAt });
    await this.startTargetStage(server, deadlineAt, cutoverId, dto, actor, browserIp);
    return this.view(cutoverId);
  }

  private async startTargetStage(
    server: Awaited<ReturnType<PanelAccessCutoverCoordinatorService['server']>>,
    deadlineAt: Date,
    cutoverId: string,
    dto: StartPanelAccessCutoverDto,
    actor: MasterFederationActor,
    browserIp: string,
  ): Promise<void> {
    const request = {
      cutoverId,
      domain: dto.domain.trim().toLowerCase(),
      email: dto.email.trim().toLowerCase(),
      httpsRedirect: dto.httpsRedirect,
      denyIpAccess: dto.denyIpAccess,
      deadlineAt: deadlineAt.toISOString(),
    };
    const response = await this.targetJson(
      server.installationId,
      actor,
      browserIp,
      'POST',
      '/panel-access/federation-cutovers',
      request,
      `panel-access-stage-${cutoverId}`,
    );
    const ticket = targetTicket(response);
    await this.operationLinks.record({
      remoteServerId: server.id,
      targetOperationId: ticket.operationId,
      masterUserId: actor.id,
      actionId: PANEL_ACCESS_CUTOVER_ACTION,
      requestId: ticket.requestId,
      correlationId: cutoverId,
    });
  }

  async get(
    serverId: string,
    cutoverId: string,
    actor: MasterFederationActor,
    browserIp: string,
  ) {
    const cutover = await this.cutover(serverId, cutoverId);
    if (cutover.state === 'PREPARED') {
      await this.reconcile(cutoverId, actor, browserIp);
    } else if (
      ['ACTIVATED', 'NEEDS_ATTENTION'].includes(cutover.state) &&
      cutover.remoteServer.activeEndpointGeneration === cutover.toGeneration
    ) {
      await this.reconcileActivated(cutoverId, actor, browserIp);
    }
    return this.view(cutoverId);
  }

  async confirmBrowser(
    serverId: string,
    cutoverId: string,
    candidateOrigin: string,
    actor: MasterFederationActor,
    browserIp: string,
    idempotencyKey?: string,
  ) {
    this.assertIdempotencyKey(idempotencyKey);
    const cutover = await this.cutover(serverId, cutoverId);
    if (cutover.state === 'FINALIZED') return this.view(cutoverId);
    if (
      ['ACTIVATED', 'NEEDS_ATTENTION'].includes(cutover.state) &&
      cutover.remoteServer.activeEndpointGeneration === cutover.toGeneration
    ) {
      await this.reconcileActivated(cutoverId, actor, browserIp);
      return this.view(cutoverId);
    }
    if (cutover.state !== 'STAGED') {
      throw new ConflictException(`Endpoint cutover cannot confirm from ${cutover.state}`);
    }
    const candidate = cutover.remoteServer.endpoints.find(
      (endpoint) => endpoint.generation === cutover.toGeneration && endpoint.state === 'CANDIDATE',
    );
    if (!candidate || candidate.browserPublicOrigin !== candidateOrigin) {
      throw new ConflictException('Browser probe is stale or bound to another candidate');
    }
    const targetState = await this.targetJson(
      cutover.remoteServer.installationId!,
      actor,
      browserIp,
      'GET',
      `/panel-access/federation-cutovers/${cutoverId}`,
    ) as { candidate?: CandidateResult['candidate'] };
    if (!targetState.candidate) throw new ConflictException('Target candidate state is unavailable');
    if (
      targetState.candidate.spkiSha256 !== candidate.spkiSha256 ||
      targetState.candidate.endpoints.apiOrigin !== candidate.apiOrigin ||
      targetState.candidate.endpoints.wsOrigin !== candidate.wsOrigin ||
      targetState.candidate.endpoints.socketPath !== candidate.wsPath ||
      targetState.candidate.endpoints.browserPublicOrigin !== candidate.browserPublicOrigin ||
      targetState.candidate.endpoints.directTransferOrigin !== candidate.directTransferOrigin
    ) throw new ConflictException('Target candidate changed after staging');
    await this.verifyCandidate(cutover.remoteServer, targetState.candidate, actor, browserIp);
    await this.registry.activateEndpointCutover(cutoverId);
    try {
      const finalized = await this.targetJson(
        cutover.remoteServer.installationId!,
        actor,
        browserIp,
        'POST',
        `/panel-access/federation-cutovers/${cutoverId}/finalize`,
        {},
        `panel-access-finalize-${cutoverId}`,
      ) as { state?: string };
      if (finalized.state !== 'FINALIZED') {
        throw new ConflictException('Target did not confirm endpoint finalization');
      }
      await this.registry.finalizeEndpointCutover(cutoverId);
    } catch (error) {
      // Registry already points to a staged, verified listener. Keep evidence and
      // let status/deadline reconciliation decide finalize versus rollback.
      await this.registry.markEndpointCutoverNeedsAttention(
        cutoverId,
        'TARGET_FINALIZE_ACK_LOST',
      ).catch(() => undefined);
      throw new ConflictException('Endpoint activated but target finalize acknowledgement was lost', {
        cause: error,
      });
    }
    return this.view(cutoverId);
  }

  async rollback(
    serverId: string,
    cutoverId: string,
    actor: MasterFederationActor,
    browserIp: string,
    idempotencyKey?: string,
  ) {
    this.assertIdempotencyKey(idempotencyKey);
    const cutover = await this.cutover(serverId, cutoverId);
    if (cutover.state === 'ROLLED_BACK') return this.view(cutoverId);
    if (cutover.state === 'FINALIZED') {
      throw new ConflictException('Finalized endpoint requires a new recovery cutover');
    }
    const server = cutover.remoteServer;
    await this.ensureTargetRollbackSafe(
      server.installationId!,
      serverId,
      cutoverId,
      actor,
      browserIp,
    );
    try {
      await this.targetJson(
        server.installationId!,
        actor,
        browserIp,
        'POST',
        `/panel-access/federation-cutovers/${cutoverId}/rollback`,
        {},
        `panel-access-rollback-${cutoverId}`,
      );
    } catch (error) {
      await this.registry.markEndpointCutoverNeedsAttention(
        cutoverId,
        'TARGET_ROLLBACK_ACK_LOST',
      ).catch(() => undefined);
      throw new ConflictException('Target rollback could not be confirmed', { cause: error });
    }
    await this.registry.rollbackEndpointCutover(cutoverId, 'OPERATOR_ROLLBACK');
    return this.view(cutoverId);
  }

  private async reconcile(
    cutoverId: string,
    actor: MasterFederationActor,
    browserIp: string,
  ): Promise<void> {
    const cutover = await this.prisma.remoteEndpointCutover.findUnique({
      where: { id: cutoverId },
      include: {
        remoteServer: {
          include: {
            endpoints: true,
            operationLinks: { where: { correlationId: cutoverId }, take: 1 },
          },
        },
      },
    });
    if (!cutover || cutover.state !== 'PREPARED') return;
    const link = cutover.remoteServer.operationLinks[0];
    if (!link) return;
    const rawOperation = await this.targetJson(
      cutover.remoteServer.installationId!,
      actor,
      browserIp,
      'GET',
      `/operations/${link.targetOperationId}`,
    );
    const operation = targetOperation(rawOperation, link.targetOperationId);
    await this.operationLinks.touch(cutover.remoteServerId, link.targetOperationId);
    if (!TERMINAL_OPERATION_STATES.has(operation.status)) return;
    if (operation.status !== 'SUCCEEDED') {
      if (!ROLLBACK_SAFE_OPERATION_STATES.has(operation.status)) {
        await this.registry.markEndpointCutoverNeedsAttention(
          cutoverId,
          'TARGET_OPERATION_UNSAFE_TO_ROLLBACK',
        );
        return;
      }
      await this.rollbackUncommitted(
        cutoverId,
        cutover.remoteServer.installationId!,
        actor,
        browserIp,
        operation.status === 'NEEDS_ATTENTION' ? 'TARGET_NEEDS_ATTENTION' : 'TARGET_STAGE_FAILED',
      );
      return;
    }
    const result = candidateResult(operation.result, cutoverId);
    try {
      await this.verifyCandidate(cutover.remoteServer, result.candidate, actor, browserIp);
      await this.registry.stageEndpointCutover({
        cutoverId,
        apiOrigin: result.candidate.endpoints.apiOrigin,
        wsOrigin: result.candidate.endpoints.wsOrigin,
        wsPath: result.candidate.endpoints.socketPath,
        browserPublicOrigin: result.candidate.endpoints.browserPublicOrigin,
        directTransferOrigin: result.candidate.endpoints.directTransferOrigin,
        spkiSha256: result.candidate.spkiSha256,
        now: new Date(),
      });
    } catch (error) {
      await this.rollbackUncommitted(
        cutoverId,
        cutover.remoteServer.installationId!,
        actor,
        browserIp,
        'CANDIDATE_VERIFICATION_FAILED',
      );
      throw error;
    }
  }

  private async reconcileActivated(
    cutoverId: string,
    actor: MasterFederationActor,
    browserIp: string,
  ): Promise<void> {
    const cutover = await this.prisma.remoteEndpointCutover.findUnique({
      where: { id: cutoverId },
      include: { remoteServer: true },
    });
    if (
      !cutover ||
      !cutover.remoteServer.installationId ||
      cutover.remoteServer.activeEndpointGeneration !== cutover.toGeneration ||
      !['ACTIVATED', 'NEEDS_ATTENTION'].includes(cutover.state)
    ) return;
    let targetState: { state?: string };
    try {
      targetState = await this.targetJson(
        cutover.remoteServer.installationId,
        actor,
        browserIp,
        'GET',
        `/panel-access/federation-cutovers/${cutoverId}`,
      ) as { state?: string };
    } catch (error) {
      await this.registry.markEndpointCutoverNeedsAttention(
        cutoverId,
        'TARGET_STATUS_UNAVAILABLE',
      ).catch(() => undefined);
      throw new ConflictException('Activated target endpoint status is unavailable', { cause: error });
    }
    if (targetState.state === 'FINALIZED') {
      await this.registry.finalizeEndpointCutover(cutoverId);
      return;
    }
    if (targetState.state === 'ROLLED_BACK') {
      await this.registry.rollbackEndpointCutover(cutoverId, 'TARGET_CONFIRMED_ROLLBACK');
      return;
    }
    if (cutover.deadlineAt.getTime() <= Date.now()) {
      await this.rollbackUncommitted(
        cutoverId,
        cutover.remoteServer.installationId,
        actor,
        browserIp,
        'CUTOVER_DEADLINE_EXPIRED',
      );
      return;
    }
    if (!['STAGED', 'FINALIZING', 'NEEDS_ATTENTION'].includes(targetState.state ?? '')) {
      await this.registry.markEndpointCutoverNeedsAttention(
        cutoverId,
        'TARGET_STATE_INCONSISTENT',
      );
      throw new ConflictException('Activated target endpoint state is inconsistent');
    }
    try {
      const finalized = await this.targetJson(
        cutover.remoteServer.installationId,
        actor,
        browserIp,
        'POST',
        `/panel-access/federation-cutovers/${cutoverId}/finalize`,
        {},
        `panel-access-finalize-${cutoverId}`,
      ) as { state?: string };
      if (finalized.state !== 'FINALIZED') {
        throw new ConflictException('Target did not confirm endpoint finalization');
      }
      await this.registry.finalizeEndpointCutover(cutoverId);
    } catch (error) {
      await this.registry.markEndpointCutoverNeedsAttention(
        cutoverId,
        'TARGET_FINALIZE_ACK_LOST',
      ).catch(() => undefined);
      throw new ConflictException('Activated target endpoint needs reconciliation', { cause: error });
    }
  }

  private async rollbackUncommitted(
    cutoverId: string,
    targetInstallationId: string,
    actor: MasterFederationActor,
    browserIp: string,
    reasonCode: string,
  ): Promise<void> {
    try {
      await this.targetJson(
        targetInstallationId,
        actor,
        browserIp,
        'POST',
        `/panel-access/federation-cutovers/${cutoverId}/rollback`,
        {},
        `panel-access-reconcile-${cutoverId}`,
      );
    } catch (error) {
      await this.registry.markEndpointCutoverNeedsAttention(
        cutoverId,
        'TARGET_ROLLBACK_UNCONFIRMED',
      ).catch(() => undefined);
      throw new ConflictException('Target rollback could not be confirmed', { cause: error });
    }
    await this.registry.rollbackEndpointCutover(cutoverId, reasonCode);
  }

  private async ensureTargetRollbackSafe(
    targetInstallationId: string,
    remoteServerId: string,
    cutoverId: string,
    actor: MasterFederationActor,
    browserIp: string,
  ): Promise<void> {
    const link = await this.prisma.remoteOperationLink.findFirst({
      where: { remoteServerId, correlationId: cutoverId },
    });
    if (!link) {
      await this.registry.markEndpointCutoverNeedsAttention(
        cutoverId,
        'TARGET_OPERATION_LINK_MISSING',
      );
      throw new ConflictException('Target stage operation identity is unavailable');
    }
    const operation = targetOperation(
      await this.targetJson(
        targetInstallationId,
        actor,
        browserIp,
        'GET',
        `/operations/${link.targetOperationId}`,
      ),
      link.targetOperationId,
    );
    if (ROLLBACK_SAFE_OPERATION_STATES.has(operation.status)) return;
    if (TERMINAL_OPERATION_STATES.has(operation.status)) {
      await this.registry.markEndpointCutoverNeedsAttention(
        cutoverId,
        'TARGET_OPERATION_UNSAFE_TO_ROLLBACK',
      );
      throw new ConflictException('Target stage operation requires manual reconciliation');
    }
    await this.targetJson(
      targetInstallationId,
      actor,
      browserIp,
      'POST',
      `/operations/${link.targetOperationId}/cancel`,
      {},
      `panel-access-cancel-${cutoverId}`,
    );
    await this.registry.markEndpointCutoverNeedsAttention(
      cutoverId,
      'TARGET_OPERATION_CANCEL_REQUESTED',
    );
    throw new ConflictException('Target stage cancellation requested; retry rollback after it stops');
  }

  private async verifyCandidate(
    server: {
      installationId: string | null;
      targetManifestKid: string | null;
      targetManifestPublicKeySpki: string | null;
    },
    candidate: CandidateResult['candidate'],
    actor: MasterFederationActor,
    browserIp: string,
  ): Promise<void> {
    if (
      !server.installationId ||
      !server.targetManifestKid ||
      !server.targetManifestPublicKeySpki
    ) throw new ConflictException('Target manifest identity is unavailable');
    const manifest = this.manifests.verify({
      manifest: candidate.manifest,
      targetInstallationId: server.installationId,
      manifestKid: server.targetManifestKid,
      manifestPublicKeySpki: server.targetManifestPublicKeySpki,
    });
    if (
      manifest.endpointState !== 'READY' ||
      JSON.stringify(manifest.endpoints) !== JSON.stringify(candidate.endpoints)
    ) throw new ConflictException('Signed candidate manifest endpoint mismatch');
    const pinned = createPinnedFederationDispatcher(candidate.endpoints.apiOrigin, {
      spkiSha256: candidate.spkiSha256,
      connectTimeoutMs: 5_000,
    });
    try {
      const health = await request(`${candidate.endpoints.apiOrigin}/api/federation/v1/health`, {
        method: 'GET',
        dispatcher: pinned.dispatcher,
        maxRedirections: 0,
        headersTimeout: 10_000,
        bodyTimeout: 10_000,
        headers: { accept: 'application/json' },
      });
      if (health.statusCode !== 200) throw new Error('Candidate health failed');
      const payload = await this.readJsonBody(health.body) as {
        status?: unknown;
        protocolMin?: unknown;
        protocolMax?: unknown;
      };
      if (
        payload?.status !== 'ok' ||
        payload.protocolMin !== FEDERATION_PROTOCOL_VERSION ||
        payload.protocolMax !== FEDERATION_PROTOCOL_VERSION
      ) throw new Error('Candidate health contract mismatch');
    } finally {
      await pinned.close();
    }
    const issued = await this.wsIssuer.issue({
      targetInstallationId: server.installationId,
      actor,
      browserIp,
      epoch: 1,
    });
    const socketAgent = createPinnedSocketAgent(candidate.endpoints.wsOrigin, {
      spkiSha256: candidate.spkiSha256,
      connectTimeoutMs: 5_000,
    });
    const socket = io(candidate.endpoints.wsOrigin, {
      path: candidate.endpoints.socketPath,
      transports: ['websocket'],
      upgrade: false,
      reconnection: false,
      forceNew: true,
      timeout: 10_000,
      agent: socketAgent.agent,
      rejectUnauthorized: true,
      auth: { federationChannel: issued.assertion },
    } as unknown as Parameters<typeof io>[1]);
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Candidate WS probe timed out')), 10_000);
        timeout.unref();
        socket.once('connect', () => { clearTimeout(timeout); resolve(); });
        socket.once('connect_error', (error) => { clearTimeout(timeout); reject(error); });
      });
    } finally {
      socket.disconnect();
      socketAgent.destroy();
    }
  }

  private async targetJson(
    targetInstallationId: string,
    actor: MasterFederationActor,
    browserIp: string,
    method: 'GET' | 'POST',
    suffix: string,
    bodyValue?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const body = method === 'GET' ? Buffer.alloc(0) : Buffer.from(JSON.stringify(bodyValue ?? {}));
    const rawHeaders = method === 'GET'
      ? ['accept', 'application/json']
      : [
          'accept', 'application/json',
          'content-type', 'application/json',
          'idempotency-key', idempotencyKey!,
        ];
    const response = await this.dispatcher.dispatch({
      targetInstallationId,
      inboundTarget: `/api/proxy/${targetInstallationId}${suffix}`,
      method,
      rawHeaders,
      body,
      actor,
      browserIp,
    });
    const parsed = await this.readJsonBody(response.body);
    if (
      response.statusCode < 200 ||
      response.statusCode >= 300 ||
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as { success?: unknown }).success !== true
    ) throw new ConflictException('Target Panel Access cutover request failed');
    return (parsed as { data: unknown }).data;
  }

  private assertIdempotencyKey(
    key: string | undefined,
  ): asserts key is string {
    if (!key || !IDEMPOTENCY_KEY.test(key)) {
      throw new BadRequestException('Idempotency-Key must be 8-128 printable ASCII characters');
    }
  }

  private async readJsonBody(body: AsyncIterable<Buffer>): Promise<unknown> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const raw of body) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      bytes += chunk.length;
      if (bytes > MAX_JSON_BYTES) throw new ConflictException('Target response exceeds 1 MiB');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ConflictException('Target returned invalid JSON'); }
  }

  private async server(serverId: string) {
    const server = await this.prisma.remoteServer.findUnique({
      where: { id: serverId },
      include: { endpoints: true },
    });
    if (
      !server ||
      !server.installationId ||
      !server.targetManifestKid ||
      !server.targetManifestPublicKeySpki
    ) throw new NotFoundException('Federated target not found');
    return {
      ...server,
      installationId: server.installationId,
      targetManifestKid: server.targetManifestKid,
      targetManifestPublicKeySpki: server.targetManifestPublicKeySpki,
    };
  }

  private async cutover(serverId: string, cutoverId: string) {
    if (!UUID.test(cutoverId)) throw new BadRequestException('Invalid cutover ID');
    const cutover = await this.prisma.remoteEndpointCutover.findFirst({
      where: { id: cutoverId, remoteServerId: serverId },
      include: { remoteServer: { include: { endpoints: true } } },
    });
    if (!cutover || !cutover.remoteServer.installationId) {
      throw new NotFoundException('Endpoint cutover not found');
    }
    return cutover;
  }

  private async view(cutoverId: string) {
    const cutover = await this.prisma.remoteEndpointCutover.findUnique({
      where: { id: cutoverId },
      include: {
        remoteServer: {
          include: {
            endpoints: true,
            operationLinks: { where: { correlationId: cutoverId }, take: 1 },
          },
        },
      },
    });
    if (!cutover) throw new NotFoundException('Endpoint cutover not found');
    const candidate = cutover.remoteServer.endpoints.find(
      (endpoint) => endpoint.generation === cutover.toGeneration,
    );
    return {
      id: cutover.id,
      serverId: cutover.remoteServerId,
      state: cutover.state,
      deadlineAt: cutover.deadlineAt.toISOString(),
      operationId: cutover.remoteServer.operationLinks[0]?.targetOperationId ?? null,
      candidateOrigin: candidate?.browserPublicOrigin ?? null,
      browserProbeRequired: cutover.state === 'STAGED',
      reasonCode: cutover.sanitizedErrorCode,
      activatedAt: cutover.activatedAt?.toISOString() ?? null,
      finalizedAt: cutover.finalizedAt?.toISOString() ?? null,
      rolledBackAt: cutover.rolledBackAt?.toISOString() ?? null,
    };
  }

  private async reconcileExpired(): Promise<void> {
    const expired = await this.prisma.remoteEndpointCutover.findMany({
      where: {
        deadlineAt: { lte: new Date() },
        state: { in: ['PREPARED', 'STAGED', 'ACTIVATED', 'NEEDS_ATTENTION'] },
      },
      include: { remoteServer: true },
      take: 8,
    });
    for (const cutover of expired) {
      const link = await this.prisma.remoteOperationLink.findFirst({
        where: {
          remoteServerId: cutover.remoteServerId,
          correlationId: cutover.id,
        },
      });
      const user = link
        ? await this.prisma.user.findUnique({ where: { id: link.masterUserId }, select: { id: true, role: true } })
        : null;
      if (user?.role !== 'ADMIN' || !cutover.remoteServer.installationId) {
        await this.registry.markEndpointCutoverNeedsAttention(
          cutover.id,
          link ? 'CUTOVER_OPERATOR_UNAVAILABLE' : 'TARGET_OPERATION_LINK_MISSING',
        ).catch(() => undefined);
        continue;
      }
      const actor = { id: user.id, role: 'ADMIN' as const };
      try {
        if (cutover.remoteServer.activeEndpointGeneration === cutover.toGeneration) {
          await this.reconcileActivated(cutover.id, actor, '127.0.0.1');
          continue;
        }
        await this.ensureTargetRollbackSafe(
          cutover.remoteServer.installationId,
          cutover.remoteServerId,
          cutover.id,
          actor,
          '127.0.0.1',
        );
        await this.rollbackUncommitted(
          cutover.id,
          cutover.remoteServer.installationId,
          actor,
          '127.0.0.1',
          'CUTOVER_DEADLINE_EXPIRED',
        );
      } catch {
        // Helpers persist a bounded NEEDS_ATTENTION reason. The next pass may
        // continue only after operation/transport state becomes safe.
      }
    }
  }
}
