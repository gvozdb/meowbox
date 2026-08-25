import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { RemoteActionCapability, SignedFederationManifest } from '@meowbox/shared';
import { PrismaService } from '../common/prisma.service';
import { assertPublicHttpUrl } from '../common/validators/safe-url';
import { LegacyRegistryFileService } from './legacy-registry-file.service';
import {
  decryptLegacyToken,
  encryptLegacyToken,
  legacyRegistryDigest,
  LegacyServerRecord,
  normalizeLegacyServerUrl,
  parseLegacyRegistry,
  renderLegacyRegistry,
  validateLegacyServerRecord,
} from './legacy-registry';
import { PanelIdentityService } from './panel-identity.service';
import type { FederationManifestEvaluation } from './federation-compatibility.service';
import { parseFederationOrigin } from './endpoint-normalizer';
import { validateFederationSocketPath } from './federation-local-endpoint.service';
import { validateFederationSpkiPin } from './pinned-dispatcher';
import { hasFederatedTargetUpdateCapabilities } from './federation-update-actions';
import { generateFederationRelationshipKey } from './federation-key-material';
import {
  evaluateFederationCanary,
  FEDERATION_ROLLOUT_STAGES,
  FederationCanaryDecision,
  FederationRolloutRequest,
  FederationRolloutStage,
  rolloutStageIndex,
} from './federation-rollout-policy';

export interface CommitFederatedEnrollmentInput {
  enrollmentId: string;
  issuerId: string;
  displayName: string;
  targetInstallationId: string;
  targetManifestKid: string;
  targetManifestPublicKeySpki: string;
  endpoint: {
    apiOrigin: string;
    wsOrigin: string;
    wsPath: string;
    browserPublicOrigin: string;
    directTransferOrigin: string;
    sshHost: string;
    sshPort: number;
    spkiSha256: string;
    normalizedHash: string;
  };
  manifest: SignedFederationManifest;
  evaluation: FederationManifestEvaluation;
  now: Date;
}

export interface FederatedServerSummary {
  id: string;
  name: string;
  registryGeneration: number;
  publicOrigin: string;
  online: boolean;
  version?: string;
  protocolVersion: number | null;
  activationMode: string;
  capabilityState: string;
  reasonCode: string;
  lastCheckedAt?: string;
  fleetUpdateReady: boolean;
  fleetUpdateReason: string | null;
  rolloutStage: string;
  rolloutStageStartedAt?: string;
}

export interface FederationRolloutState {
  serverId: string;
  registryGeneration: number;
  stage: FederationRolloutStage;
  stageStartedAt: string | null;
  approvedAt: string | null;
  activationMode: string;
  killSwitches: {
    http: boolean;
    ws: boolean;
    publicDelivery: boolean;
    legacy: boolean;
  };
  evidence: unknown;
  replayed: boolean;
}

export interface UpdateFederationRolloutInput extends FederationRolloutRequest {
  serverId: string;
  requestKeyHash: string;
  now?: Date;
}

export interface FederationKeyRotationPreparation {
  serverId: string;
  targetInstallationId: string;
  previousKid: string;
  newKid: string;
  newPublicKeySpki: string;
  registryGeneration: number;
  replayed: boolean;
}

export type RegistryAuthority = 'JSON' | 'DB' | 'FROZEN';
type RegistryTx = Prisma.TransactionClient;

export interface StageRemoteEndpointCutoverInput {
  cutoverId: string;
  apiOrigin: string;
  wsOrigin: string;
  wsPath: string;
  browserPublicOrigin: string;
  directTransferOrigin: string;
  spkiSha256: string;
  now: Date;
}

const CUTOVER_TERMINAL_STATES = ['FINALIZED', 'ROLLED_BACK'];

function endpointHash(input: Omit<StageRemoteEndpointCutoverInput, 'cutoverId' | 'now'>): string {
  return createHash('sha256').update(JSON.stringify({
    apiOrigin: input.apiOrigin,
    wsOrigin: input.wsOrigin,
    wsPath: input.wsPath,
    browserPublicOrigin: input.browserPublicOrigin,
    directTransferOrigin: input.directTransferOrigin,
    spkiSha256: input.spkiSha256,
  })).digest('hex');
}

const ACTIVATION_MODE_BY_STAGE: Readonly<Record<FederationRolloutStage, string>> = {
  DISABLED: 'DISABLED',
  OBSERVE: 'OBSERVE',
  READ_ONLY: 'V1_READ_ONLY',
  CANARY_5: 'V1_ENABLED',
  CANARY_25: 'V1_ENABLED',
  BROAD: 'V1_ENABLED',
};

function rolloutSwitches(
  current: { rolloutStage: string; httpEnabled: boolean; wsEnabled: boolean; publicEnabled: boolean },
  input: FederationRolloutRequest,
) {
  const direction = rolloutStageIndex(input.stage) - rolloutStageIndex(
    current.rolloutStage as FederationRolloutStage,
  );
  if (input.stage === 'DISABLED' || input.stage === 'OBSERVE') {
    return { httpEnabled: false, wsEnabled: false, publicEnabled: false };
  }
  if (direction < 0) {
    return { httpEnabled: false, wsEnabled: false, publicEnabled: false };
  }
  const defaults = direction === 0
    ? {
        httpEnabled: current.httpEnabled,
        wsEnabled: current.wsEnabled,
        publicEnabled: current.publicEnabled,
      }
    : {
        httpEnabled: true,
        wsEnabled: false,
        publicEnabled: false,
      };
  return {
    httpEnabled: input.httpEnabled ?? defaults.httpEnabled,
    wsEnabled: input.wsEnabled ?? defaults.wsEnabled,
    publicEnabled: input.publicEnabled ?? defaults.publicEnabled,
  };
}

function parseRolloutEvidence(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isRolloutStage(value: string): value is FederationRolloutStage {
  return (FEDERATION_ROLLOUT_STAGES as readonly string[]).includes(value);
}

function rolloutRequestFingerprint(input: FederationRolloutRequest): string {
  return createHash('sha256').update(JSON.stringify({
    stage: input.stage,
    expectedRegistryGeneration: input.expectedRegistryGeneration,
    reason: input.reason,
    httpEnabled: input.httpEnabled ?? null,
    wsEnabled: input.wsEnabled ?? null,
    publicEnabled: input.publicEnabled ?? null,
    evidence: input.evidence ?? null,
  })).digest('hex');
}

function rolloutStateFromRow(row: {
  id: string;
  registryGeneration: number;
  rolloutStage: string;
  rolloutStageStartedAt: Date | null;
  rolloutApprovedAt: Date | null;
  rolloutEvidenceJson: string | null;
  activationMode: string;
  httpEnabled: boolean;
  wsEnabled: boolean;
  publicEnabled: boolean;
  legacyEnabled: boolean;
}, replayed = false): FederationRolloutState {
  if (!isRolloutStage(row.rolloutStage)) {
    throw new ServiceUnavailableException('Federation rollout state is invalid');
  }
  const persisted = parseRolloutEvidence(row.rolloutEvidenceJson);
  const evidence = persisted
    ? {
        reason: typeof persisted.reason === 'string' ? persisted.reason : null,
        recordedAt: typeof persisted.recordedAt === 'string' ? persisted.recordedAt : null,
        decision: persisted.decision ?? null,
        metrics: persisted.evidence ?? null,
      }
    : null;
  return {
    serverId: row.id,
    registryGeneration: row.registryGeneration,
    stage: row.rolloutStage,
    stageStartedAt: row.rolloutStageStartedAt?.toISOString() ?? null,
    approvedAt: row.rolloutApprovedAt?.toISOString() ?? null,
    activationMode: row.activationMode,
    killSwitches: {
      http: !row.httpEnabled,
      ws: !row.wsEnabled,
      publicDelivery: !row.publicEnabled,
      legacy: !row.legacyEnabled,
    },
    evidence,
    replayed,
  };
}

interface RegistryMutationDecision<T> {
  changed: boolean;
  value: T;
}

function rowsToLegacyRecords(rows: ReadonlyArray<{
  id: string;
  displayName: string;
  legacyUrl: string | null;
  legacyTokenEnc: string | null;
  legacyEnabled: boolean;
}>): LegacyServerRecord[] {
  return rows
    .filter((row) => row.legacyEnabled)
    .map((row) => {
      if (!row.legacyUrl || !row.legacyTokenEnc) {
        throw new Error(`Legacy projection is incomplete for server ${row.id}`);
      }
      return validateLegacyServerRecord({
        id: row.id,
        name: row.displayName,
        url: row.legacyUrl,
        token: decryptLegacyToken(row.id, row.legacyTokenEnc),
      });
    });
}

@Injectable()
export class RemoteRegistryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly panelIdentity: PanelIdentityService,
    private readonly legacyFile: LegacyRegistryFileService,
  ) {}

  async assertControlPlane(): Promise<void> {
    const identity = await this.panelIdentity.getLocalIdentity();
    if (identity.installationRole !== 'MASTER') {
      throw new BadRequestException('Remote registry exists only on a control-plane installation');
    }
  }

  async authority(): Promise<RegistryAuthority> {
    const latest = await this.prisma.registryProjectionJournal.findFirst({
      orderBy: { registryGeneration: 'desc' },
      select: { state: true },
    });
    if (!latest || latest.state === 'IMPORTED' || latest.state === 'ROLLED_BACK') return 'JSON';
    if (latest.state === 'COMMITTED') return 'DB';
    return 'FROZEN';
  }

  async getLegacyServers(): Promise<LegacyServerRecord[]> {
    const authority = await this.authority();
    if (authority === 'FROZEN') {
      throw new ServiceUnavailableException('Remote registry is frozen pending projection repair');
    }
    if (authority === 'JSON') return parseLegacyRegistry(await this.legacyFile.read());
    return this.getLegacyServersFromDb();
  }

  async listFederatedServerSummaries(
    now = new Date(),
  ): Promise<FederatedServerSummary[]> {
    await this.assertControlPlane();
    const rows = await this.prisma.remoteServer.findMany({
      where: { installationId: { not: null } },
      include: {
        endpoints: { orderBy: { generation: 'desc' } },
        manifests: { orderBy: { fetchedAt: 'desc' }, take: 1 },
      },
      orderBy: { displayName: 'asc' },
    });
    return rows.map((row) => {
      const endpoint = row.endpoints.find((candidate) =>
        candidate.generation === row.activeEndpointGeneration &&
        candidate.state === 'ACTIVE',
      );
      const fresh = !!row.transportFreshUntil &&
        row.transportFreshUntil.getTime() > now.getTime();
      const online = row.transportState === 'ONLINE' && fresh;
      let capabilities: Record<string, RemoteActionCapability> = {};
      try {
        const parsed = JSON.parse(row.manifests[0]?.capabilitiesJson ?? '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          capabilities = parsed as Record<string, RemoteActionCapability>;
        }
      } catch {
        capabilities = {};
      }
      const fleetUpdateReady = online &&
        row.protocolVersion === 1 &&
        row.activationMode === 'V1_ENABLED' &&
        ['FRESH', 'PARTIAL'].includes(row.capabilityState) &&
        hasFederatedTargetUpdateCapabilities(capabilities);
      const fleetUpdateReason = fleetUpdateReady
        ? null
        : !online
          ? 'TARGET_OFFLINE'
          : row.protocolVersion !== 1 || row.activationMode !== 'V1_ENABLED'
            ? 'PROTOCOL_INCOMPATIBLE'
            : 'UPDATE_CAPABILITY_UNAVAILABLE';
      return {
        id: row.id,
        name: row.displayName,
        registryGeneration: row.registryGeneration,
        publicOrigin: endpoint?.browserPublicOrigin ?? '',
        online,
        ...(row.productVersion ? { version: row.productVersion } : {}),
        protocolVersion: row.protocolVersion,
        activationMode: row.activationMode,
        capabilityState: row.capabilityState,
        reasonCode: online
          ? row.reasonCode ?? 'READY'
          : !fresh
            ? 'STATUS_STALE'
            : row.reasonCode ?? row.transportReasonCode ?? 'OFFLINE',
        ...(row.statusCheckedAt
          ? { lastCheckedAt: row.statusCheckedAt.toISOString() }
          : {}),
        fleetUpdateReady,
        fleetUpdateReason,
        rolloutStage: row.rolloutStage,
        ...(row.rolloutStageStartedAt
          ? { rolloutStageStartedAt: row.rolloutStageStartedAt.toISOString() }
          : {}),
      };
    });
  }

  async getFederationRollout(serverId: string): Promise<FederationRolloutState> {
    await this.assertControlPlane();
    const server = await this.prisma.remoteServer.findUnique({ where: { id: serverId } });
    if (!server?.installationId) throw new NotFoundException('Federated remote server not found');
    return rolloutStateFromRow(server);
  }

  async updateFederationRollout(
    input: UpdateFederationRolloutInput,
  ): Promise<FederationRolloutState> {
    if (!/^[0-9a-f]{64}$/.test(input.requestKeyHash)) {
      throw new BadRequestException('Rollout request identity is invalid');
    }
    const now = input.now ?? new Date();
    const requestFingerprint = rolloutRequestFingerprint(input);

    return this.commitMutationDecision<FederationRolloutState>(async (tx, generation) => {
      const server = await tx.remoteServer.findUnique({
        where: { id: input.serverId },
        include: {
          endpoints: { orderBy: { generation: 'desc' } },
          manifests: { orderBy: { fetchedAt: 'desc' }, take: 1 },
        },
      });
      if (!server?.installationId) throw new NotFoundException('Federated remote server not found');
      if (!isRolloutStage(server.rolloutStage)) {
        throw new ServiceUnavailableException('Federation rollout state is invalid');
      }

      const persisted = parseRolloutEvidence(server.rolloutEvidenceJson);
      if (persisted?.requestKeyHash === input.requestKeyHash) {
        if (persisted.requestFingerprint !== requestFingerprint) {
          throw new ConflictException('Idempotency-Key is already bound to another rollout request');
        }
        return { changed: false, value: rolloutStateFromRow(server, true) };
      }
      if (server.registryGeneration !== input.expectedRegistryGeneration) {
        throw new ConflictException('Remote registry generation changed');
      }

      const currentStage = server.rolloutStage;
      const currentIndex = rolloutStageIndex(currentStage);
      const targetIndex = rolloutStageIndex(input.stage);
      const direction = targetIndex - currentIndex;
      if (direction > 1) {
        throw new ConflictException('Federation rollout stages must advance one step at a time');
      }
      const switches = rolloutSwitches(server, input);
      const enablesTraffic = switches.httpEnabled || switches.wsEnabled || switches.publicEnabled;
      const needsActivationChecks = direction > 0 || (direction === 0 && enablesTraffic);
      const latestManifest = server.manifests[0];

      if (needsActivationChecks) {
        const activeEndpoint = server.endpoints.find((endpoint) =>
          endpoint.generation === server.activeEndpointGeneration &&
          endpoint.state === 'ACTIVE' &&
          endpoint.verifiedAt !== null,
        );
        if (
          server.topologyMode !== 'PUBLIC' ||
          server.protocolVersion !== 1 ||
          !activeEndpoint ||
          !server.targetManifestKid ||
          !server.targetManifestPublicKeySpki
        ) throw new ConflictException('Federated target identity or public endpoint is not activation-ready');
        if (
          server.transportState !== 'ONLINE' ||
          !server.transportFreshUntil ||
          server.transportFreshUntil <= now
        ) throw new ConflictException('Federated target transport is not fresh and online');
        if (
          server.trustState !== 'ACTIVE' ||
          !server.trustFreshUntil ||
          server.trustFreshUntil <= now
        ) throw new ConflictException('Federated target trust is not fresh and active');
        if (!['FRESH', 'PARTIAL'].includes(server.capabilityState)) {
          throw new ConflictException('Federated target capabilities are not activation-ready');
        }
        if (
          !latestManifest ||
          !['VALID', 'PARTIAL'].includes(latestManifest.validationState) ||
          latestManifest.validUntil <= now ||
          latestManifest.endpointState !== 'READY'
        ) throw new ConflictException('Federated target manifest is not current and valid');
        if (
          input.stage === 'READ_ONLY' &&
          !['v1-read-only', 'v1-enabled'].includes(latestManifest.protocolMode)
        ) throw new ConflictException('Target has not enabled federation read-only mode');
        if (
          targetIndex >= rolloutStageIndex('CANARY_5') &&
          latestManifest.protocolMode !== 'v1-enabled'
        ) throw new ConflictException('Target has not enabled federation protocol 1');
        if (
          targetIndex < rolloutStageIndex('CANARY_5') &&
          (switches.wsEnabled || switches.publicEnabled)
        ) throw new ConflictException('WS and public delivery require a canary rollout stage');
      }

      const evidenceRequired = needsActivationChecks && (
        targetIndex >= rolloutStageIndex('CANARY_5') ||
        switches.wsEnabled ||
        switches.publicEnabled
      );
      let decision: FederationCanaryDecision | null = null;
      if (evidenceRequired && direction >= 0) {
        if (!input.evidence) throw new BadRequestException('Canary evidence is required');
        decision = evaluateFederationCanary(input.evidence, input.stage);
        if (decision.stopReasons.length > 0) {
          throw new ConflictException(`Federation canary stop: ${decision.stopReasons.join(',')}`);
        }
        if (direction > 0 && !decision.promotionReady) {
          throw new ConflictException(
            `Federation canary evidence is insufficient: ${decision.insufficientReasons.join(',')}`,
          );
        }
      }

      if (
        direction > 0 &&
        (input.stage === 'CANARY_25' || input.stage === 'BROAD') &&
        (
          !server.rolloutStageStartedAt ||
          now.getTime() - server.rolloutStageStartedAt.getTime() < 86_400_000
        )
      ) throw new ConflictException('Current canary stage has not completed its 24-hour window');

      const recorded = {
        schemaVersion: 1,
        requestKeyHash: input.requestKeyHash,
        requestFingerprint,
        stage: input.stage,
        reason: input.reason,
        recordedAt: now.toISOString(),
        switches,
        evidence: input.evidence ?? null,
        decision,
      };
      const stageChanged = currentStage !== input.stage;
      const updated = await tx.remoteServer.updateMany({
        where: {
          id: server.id,
          registryGeneration: input.expectedRegistryGeneration,
        },
        data: {
          registryGeneration: generation,
          rolloutStage: input.stage,
          rolloutStageStartedAt: stageChanged || !server.rolloutStageStartedAt
            ? now
            : server.rolloutStageStartedAt,
          rolloutEvidenceJson: JSON.stringify(recorded),
          rolloutApprovedAt: targetIndex >= rolloutStageIndex('CANARY_5') ? now : null,
          activationMode: ACTIVATION_MODE_BY_STAGE[input.stage],
          httpEnabled: switches.httpEnabled,
          wsEnabled: switches.wsEnabled,
          publicEnabled: switches.publicEnabled,
          legacyEnabled: false,
          reasonCode: input.stage === 'DISABLED' || input.stage === 'OBSERVE'
            ? 'DISABLED'
            : 'READY',
        },
      });
      if (updated.count !== 1) throw new ConflictException('Remote registry generation changed');
      const value = await tx.remoteServer.findUniqueOrThrow({ where: { id: server.id } });
      return { changed: true, value: rolloutStateFromRow(value) };
    });
  }

  async prepareFederationKeyRotation(
    serverId: string,
    now = new Date(),
  ): Promise<FederationKeyRotationPreparation> {
    const identity = await this.panelIdentity.getLocalIdentity();
    if (identity.installationRole !== 'MASTER') {
      throw new BadRequestException('Federation key rotation is control-plane only');
    }
    const target = await this.prisma.remoteServer.findUnique({
      where: { id: serverId },
      select: { installationId: true },
    });
    if (!target?.installationId) throw new NotFoundException('Federated remote server not found');
    const generated = generateFederationRelationshipKey(
      identity.installationId,
      target.installationId,
    );

    return this.commitMutationDecision<FederationKeyRotationPreparation>(async (tx, generation) => {
      const server = await tx.remoteServer.findUnique({
        where: { id: serverId },
        include: { issuers: { include: { keys: { orderBy: { validFrom: 'desc' } } } } },
      });
      if (!server?.installationId || server.installationId !== generated.targetInstallationId) {
        throw new ConflictException('Federated target identity changed');
      }
      const issuer = server.issuers.find((candidate) =>
        candidate.issuerInstallationId === identity.installationId &&
        candidate.targetInstallationId === server.installationId &&
        candidate.state === 'ACTIVE' &&
        candidate.revokedAt === null);
      const previous = issuer?.keys.find((key) =>
        key.state === 'ACTIVE' &&
        key.revokedAt === null &&
        key.encryptedPrivateKey !== null &&
        key.validFrom <= now &&
        (key.expiresAt === null || key.expiresAt > now));
      if (!issuer || !previous) throw new ConflictException('Active federation relationship key is unavailable');
      const pending = issuer.keys.filter((key) =>
        key.state === 'PENDING' && key.revokedAt === null && key.encryptedPrivateKey !== null);
      if (pending.length > 1) throw new ConflictException('Federation key rotation state is inconsistent');
      if (pending[0]) {
        return {
          changed: false,
          value: {
            serverId: server.id,
            targetInstallationId: server.installationId,
            previousKid: previous.kid,
            newKid: pending[0].kid,
            newPublicKeySpki: pending[0].publicKeySpki,
            registryGeneration: server.registryGeneration,
            replayed: true,
          },
        };
      }
      await tx.federationKey.create({
        data: {
          issuerId: issuer.id,
          kid: generated.kid,
          publicKeySpki: generated.publicKeySpki,
          encryptedPrivateKey: generated.encryptedPrivateKey,
          state: 'PENDING',
          validFrom: now,
        },
      });
      await tx.remoteServer.update({
        where: { id: server.id },
        data: { registryGeneration: generation, reasonCode: 'KEY_ROTATION_PENDING' },
      });
      return {
        changed: true,
        value: {
          serverId: server.id,
          targetInstallationId: server.installationId,
          previousKid: previous.kid,
          newKid: generated.kid,
          newPublicKeySpki: generated.publicKeySpki,
          registryGeneration: generation,
          replayed: false,
        },
      };
    });
  }

  async activateFederationKeyRotation(
    serverId: string,
    newKid: string,
    graceUntil: Date,
    now = new Date(),
  ): Promise<Readonly<{ activeKid: string; graceUntil: string; replayed: boolean }>> {
    if (
      !Number.isFinite(graceUntil.getTime()) ||
      graceUntil.getTime() < now.getTime() + 30_000 ||
      graceUntil.getTime() > now.getTime() + 86_460_000
    ) throw new BadRequestException('Federation key grace deadline is invalid');
    const identity = await this.panelIdentity.getLocalIdentity();
    if (identity.installationRole !== 'MASTER') {
      throw new BadRequestException('Federation key rotation is control-plane only');
    }
    return this.commitMutationDecision<{
      activeKid: string;
      graceUntil: string;
      replayed: boolean;
    }>(async (tx, generation) => {
      const server = await tx.remoteServer.findUnique({
        where: { id: serverId },
        include: { issuers: { include: { keys: true } } },
      });
      if (!server?.installationId) throw new NotFoundException('Federated remote server not found');
      const issuer = server.issuers.find((candidate) =>
        candidate.issuerInstallationId === identity.installationId &&
        candidate.targetInstallationId === server.installationId &&
        candidate.state === 'ACTIVE' &&
        candidate.revokedAt === null);
      const next = issuer?.keys.find((key) => key.kid === newKid);
      if (!issuer || !next || !next.encryptedPrivateKey || next.revokedAt) {
        throw new ConflictException('Pending federation relationship key is unavailable');
      }
      if (next.state === 'ACTIVE') {
        return {
          changed: false,
          value: { activeKid: next.kid, graceUntil: graceUntil.toISOString(), replayed: true },
        };
      }
      if (next.state !== 'PENDING') throw new ConflictException('Federation key cannot be activated');
      await tx.federationKey.update({
        where: { id: next.id },
        data: { state: 'ACTIVE', validFrom: now },
      });
      await tx.federationKey.updateMany({
        where: {
          issuerId: issuer.id,
          id: { not: next.id },
          state: 'ACTIVE',
          revokedAt: null,
        },
        data: { expiresAt: graceUntil },
      });
      await tx.remoteServer.update({
        where: { id: server.id },
        data: {
          registryGeneration: generation,
          trustState: 'ACTIVE',
          trustReasonCode: 'READY',
          reasonCode: 'READY',
        },
      });
      return {
        changed: true,
        value: { activeKid: next.kid, graceUntil: graceUntil.toISOString(), replayed: false },
      };
    });
  }

  async revokeFederationTrust(
    serverId: string,
    now = new Date(),
  ): Promise<Readonly<{ state: 'REVOKED'; revokedAt: string; replayed: boolean }>> {
    return this.commitMutationDecision<{
      state: 'REVOKED';
      revokedAt: string;
      replayed: boolean;
    }>(async (tx, generation) => {
      const server = await tx.remoteServer.findUnique({
        where: { id: serverId },
        include: { issuers: true },
      });
      if (!server?.installationId) throw new NotFoundException('Federated remote server not found');
      const activeIssuers = server.issuers.filter((issuer) => issuer.revokedAt === null);
      if (
        activeIssuers.length === 0 &&
        server.trustState === 'REVOKED' &&
        !server.httpEnabled &&
        !server.wsEnabled &&
        !server.publicEnabled
      ) {
        return {
          changed: false,
          value: {
            state: 'REVOKED' as const,
            revokedAt: (server.trustCheckedAt ?? now).toISOString(),
            replayed: true,
          },
        };
      }
      const issuerIds = activeIssuers.map(({ id }) => id);
      if (issuerIds.length > 0) {
        await tx.federationKey.updateMany({
          where: { issuerId: { in: issuerIds }, revokedAt: null },
          data: { state: 'REVOKED', revokedAt: now, expiresAt: now },
        });
        await tx.federationIssuer.updateMany({
          where: { id: { in: issuerIds }, revokedAt: null },
          data: { state: 'REVOKED', revokedAt: now },
        });
      }
      await tx.remoteServer.update({
        where: { id: server.id },
        data: {
          registryGeneration: generation,
          activationMode: 'DISABLED',
          rolloutStage: 'DISABLED',
          rolloutStageStartedAt: now,
          rolloutEvidenceJson: null,
          rolloutApprovedAt: null,
          httpEnabled: false,
          wsEnabled: false,
          publicEnabled: false,
          legacyEnabled: false,
          trustState: 'REVOKED',
          trustReasonCode: 'TRUST_REVOKED',
          trustCheckedAt: now,
          trustFreshUntil: null,
          reasonCode: 'TRUST_REVOKED',
        },
      });
      return {
        changed: true,
        value: { state: 'REVOKED' as const, revokedAt: now.toISOString(), replayed: false },
      };
    });
  }

  async getLegacyServersFromDb(tx: PrismaService | RegistryTx = this.prisma): Promise<LegacyServerRecord[]> {
    const rows = await tx.remoteServer.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        displayName: true,
        legacyUrl: true,
        legacyTokenEnc: true,
        legacyEnabled: true,
      },
    });
    return rowsToLegacyRecords(rows);
  }

  async renderDbProjection(tx: PrismaService | RegistryTx = this.prisma): Promise<string> {
    return renderLegacyRegistry(await this.getLegacyServersFromDb(tx));
  }

  async addLegacyServer(input: Omit<LegacyServerRecord, 'id'> & { id?: string }): Promise<LegacyServerRecord> {
    const id = input.id ?? randomUUID();
    const record = validateLegacyServerRecord({ ...input, id });
    await assertPublicHttpUrl(record.url, { protocols: ['http:', 'https:'] });
    return this.commitMutation(async (tx, generation) => {
      const created = await tx.remoteServer.create({
        data: {
          id: record.id,
          displayName: record.name,
          registryGeneration: generation,
          activationMode: 'LEGACY_UPGRADE_ONLY',
          topologyMode: 'PUBLIC',
          transportState: 'UNKNOWN',
          trustState: 'UNENROLLED',
          capabilityState: 'UNKNOWN',
          browserState: 'UNKNOWN',
          reasonCode: 'LEGACY_UPGRADE_REQUIRED',
          legacyEnabled: true,
          legacyUrl: record.url,
          legacyTokenEnc: encryptLegacyToken(record.id, record.token),
        },
      });
      return {
        id: created.id,
        name: created.displayName,
        url: record.url,
        token: record.token,
      };
    });
  }

  async updateLegacyServer(
    id: string,
    patch: Partial<Omit<LegacyServerRecord, 'id'>>,
  ): Promise<LegacyServerRecord> {
    const current = await this.findLegacyServerOrThrow(id);
    const next = validateLegacyServerRecord({ ...current, ...patch, id });
    if (patch.url !== undefined) {
      await assertPublicHttpUrl(next.url, { protocols: ['http:', 'https:'] });
    }
    return this.commitMutation(async (tx, generation) => {
      await tx.remoteServer.update({
        where: { id },
        data: {
          displayName: next.name,
          legacyUrl: normalizeLegacyServerUrl(next.url),
          legacyTokenEnc: patch.token === undefined
            ? undefined
            : encryptLegacyToken(id, next.token),
          registryGeneration: generation,
        },
      });
      return next;
    });
  }

  async removeLegacyServer(id: string): Promise<void> {
    const existing = await this.prisma.remoteServer.findUnique({
      where: { id },
      include: {
        issuers: { select: { id: true }, take: 1 },
        enrollments: { select: { id: true }, take: 1 },
      },
    });
    if (!existing || !existing.legacyEnabled) throw new NotFoundException(`Server "${id}" not found`);
    if (existing.installationId || existing.issuers.length || existing.enrollments.length) {
      throw new ConflictException('Enrolled server must be revoked and removed through federation lifecycle');
    }
    await this.commitMutation(async (tx) => {
      await tx.remoteServer.delete({ where: { id } });
      return undefined;
    });
  }

  async commitFederatedEnrollment(
    input: CommitFederatedEnrollmentInput,
  ): Promise<Readonly<{ id: string; displayName: string }>> {
    if (
      !input.evaluation.compatible ||
      !input.evaluation.hasMatchingEndpoint ||
      input.evaluation.validationState === 'INCOMPATIBLE' ||
      input.manifest.installationId !== input.targetInstallationId ||
      input.manifest.signature.kid !== input.targetManifestKid
    ) throw new ConflictException('Federation enrollment is not activation-safe');

    return this.commitMutation(async (tx, generation) => {
      const enrollment = await tx.federationEnrollment.findUnique({
        where: { id: input.enrollmentId },
      });
      const issuer = await tx.federationIssuer.findUnique({
        where: { id: input.issuerId },
        include: { keys: true },
      });
      if (
        !enrollment ||
        enrollment.enrollmentRole !== 'CONTROL_PLANE' ||
        enrollment.state !== 'MANIFEST_VERIFIED' ||
        enrollment.remoteServerId !== null ||
        enrollment.targetInstallationId !== input.targetInstallationId ||
        enrollment.targetManifestKid !== input.targetManifestKid ||
        enrollment.targetManifestKeySpki !== input.targetManifestPublicKeySpki ||
        enrollment.delegationIssuerId !== input.issuerId ||
        !issuer ||
        issuer.remoteServerId !== null ||
        issuer.targetInstallationId !== input.targetInstallationId ||
        issuer.state !== 'PENDING' ||
        issuer.keys.length !== 1 ||
        issuer.keys[0].state !== 'PENDING' ||
        !issuer.keys[0].encryptedPrivateKey
      ) throw new ConflictException('Federation enrollment state changed');

      await tx.remoteServer.create({
        data: {
          id: input.enrollmentId,
          installationId: input.targetInstallationId,
          displayName: input.displayName,
          registryGeneration: generation,
          activationMode: 'DISABLED',
          topologyMode: 'PUBLIC',
          protocolVersion: input.evaluation.selectedProtocol,
          manifestRevision: input.manifest.revision,
          targetManifestKid: input.targetManifestKid,
          targetManifestPublicKeySpki: input.targetManifestPublicKeySpki,
          targetManifestPinnedAt: input.now,
          productVersion: input.manifest.productVersion,
          transportState: 'ONLINE',
          trustState: 'ACTIVE',
          capabilityState: input.evaluation.capabilityState,
          browserState: 'UNKNOWN',
          reasonCode: 'ACTIVATION_DISABLED',
          transportReasonCode: 'READY',
          trustReasonCode: 'READY',
          capabilityReasonCode: input.evaluation.capabilityReasonCode,
          browserReasonCode: 'BROWSER_NOT_PROBED',
          statusCheckedAt: input.now,
          transportFreshUntil: new Date(input.manifest.validUntil),
          trustCheckedAt: input.now,
          trustFreshUntil: new Date(input.manifest.validUntil),
          manifestFetchedAt: input.now,
          activeEndpointGeneration: 1,
          httpEnabled: false,
          wsEnabled: false,
          publicEnabled: false,
          legacyEnabled: false,
          endpoints: {
            create: {
              generation: 1,
              state: 'ACTIVE',
              ...input.endpoint,
              verifiedAt: input.now,
            },
          },
          manifests: {
            create: {
              schemaVersion: input.manifest.schemaVersion,
              revision: input.manifest.revision,
              catalogueSha256: input.manifest.catalogueSha256,
              protocolMode: input.manifest.protocolMode,
              protocolMin: input.manifest.protocol.min,
              protocolMax: input.manifest.protocol.max,
              acceptedMasterRange: JSON.stringify(input.manifest.acceptedMasterProtocol),
              capabilitiesJson: JSON.stringify(input.evaluation.capabilities),
              endpointState: input.manifest.endpointState,
              endpointsJson: JSON.stringify(input.manifest.endpoints),
              signingKid: input.manifest.signature.kid,
              signature: input.manifest.signature.value,
              validationState: input.evaluation.validationState,
              generatedAt: new Date(input.manifest.generatedAt),
              validUntil: new Date(input.manifest.validUntil),
              fetchedAt: input.now,
            },
          },
        },
      });
      await tx.federationIssuer.update({
        where: { id: issuer.id },
        data: { remoteServerId: input.enrollmentId, state: 'ACTIVE' },
      });
      await tx.federationKey.update({
        where: { id: issuer.keys[0].id },
        data: { state: 'ACTIVE' },
      });
      await tx.federationEnrollment.update({
        where: { id: enrollment.id },
        data: {
          remoteServerId: input.enrollmentId,
          state: 'COMPLETED',
          bootstrapSecretEnc: null,
          sanitizedErrorCode: null,
          completedAt: input.now,
        },
      });
      return { id: input.enrollmentId, displayName: input.displayName };
    });
  }

  async prepareEndpointCutover(input: {
    cutoverId: string;
    remoteServerId: string;
    deadlineAt: Date;
  }) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.cutoverId) ||
      !Number.isFinite(input.deadlineAt.getTime()) ||
      input.deadlineAt.getTime() < Date.now() + 30_000 ||
      input.deadlineAt.getTime() > Date.now() + 20 * 60_000
    ) throw new BadRequestException('Endpoint cutover identity or deadline is invalid');
    return this.commitMutation(async (tx, generation) => {
      const server = await tx.remoteServer.findUnique({
        where: { id: input.remoteServerId },
        include: {
          endpoints: { orderBy: { generation: 'desc' } },
          cutovers: {
            where: { state: { notIn: CUTOVER_TERMINAL_STATES } },
            take: 1,
          },
        },
      });
      if (
        !server ||
        !server.installationId ||
        !server.activeEndpointGeneration ||
        server.trustState !== 'ACTIVE' ||
        server.topologyMode !== 'PUBLIC'
      ) throw new ConflictException('Remote server is not ready for endpoint cutover');
      if (server.cutovers.length > 0) {
        if (server.cutovers[0].id === input.cutoverId) return server.cutovers[0];
        throw new ConflictException('Another endpoint cutover is already active');
      }
      const active = server.endpoints.find(
        (endpoint) => endpoint.generation === server.activeEndpointGeneration && endpoint.state === 'ACTIVE',
      );
      if (!active?.verifiedAt) throw new ConflictException('Active endpoint is not verified');
      const toGeneration = (server.endpoints[0]?.generation ?? 0) + 1;
      const cutover = await tx.remoteEndpointCutover.create({
        data: {
          id: input.cutoverId,
          remoteServerId: server.id,
          fromGeneration: active.generation,
          toGeneration,
          state: 'PREPARED',
          deadlineAt: input.deadlineAt,
        },
      });
      await tx.remoteServer.update({
        where: { id: server.id },
        data: {
          registryGeneration: generation,
          reasonCode: 'ENDPOINT_CUTOVER',
        },
      });
      return cutover;
    });
  }

  async stageEndpointCutover(input: StageRemoteEndpointCutoverInput) {
    for (const origin of [
      input.apiOrigin,
      input.wsOrigin,
      input.browserPublicOrigin,
      input.directTransferOrigin,
    ]) parseFederationOrigin(origin);
    validateFederationSocketPath(input.wsPath);
    validateFederationSpkiPin(input.spkiSha256);
    return this.commitMutation(async (tx, generation) => {
      const cutover = await tx.remoteEndpointCutover.findUnique({
        where: { id: input.cutoverId },
        include: { remoteServer: { include: { endpoints: true } } },
      });
      if (!cutover) throw new NotFoundException('Endpoint cutover not found');
      if (cutover.state === 'STAGED') return cutover;
      if (cutover.state !== 'PREPARED') {
        throw new ConflictException(`Endpoint cutover cannot stage from ${cutover.state}`);
      }
      const server = cutover.remoteServer;
      if (
        server.activeEndpointGeneration !== cutover.fromGeneration ||
        server.candidateEndpointGeneration !== null ||
        cutover.deadlineAt <= input.now
      ) throw new ConflictException('Endpoint cutover registry state changed');
      const active = server.endpoints.find(
        (endpoint) => endpoint.generation === cutover.fromGeneration && endpoint.state === 'ACTIVE',
      );
      if (!active) throw new ConflictException('Active endpoint disappeared');
      const normalizedHash = endpointHash(input);
      await tx.remoteEndpoint.create({
        data: {
          remoteServerId: server.id,
          generation: cutover.toGeneration,
          state: 'CANDIDATE',
          apiOrigin: input.apiOrigin,
          wsOrigin: input.wsOrigin,
          wsPath: input.wsPath,
          browserPublicOrigin: input.browserPublicOrigin,
          directTransferOrigin: input.directTransferOrigin,
          sshHost: active.sshHost,
          sshPort: active.sshPort,
          spkiSha256: input.spkiSha256,
          caCertificatePem: null,
          normalizedHash,
          verifiedAt: input.now,
        },
      });
      await tx.remoteServer.update({
        where: { id: server.id },
        data: {
          candidateEndpointGeneration: cutover.toGeneration,
          registryGeneration: generation,
          reasonCode: 'ENDPOINT_CUTOVER',
        },
      });
      return tx.remoteEndpointCutover.update({
        where: { id: cutover.id },
        data: { state: 'STAGED', sanitizedErrorCode: null },
      });
    });
  }

  async activateEndpointCutover(cutoverId: string, now = new Date()) {
    return this.commitMutation(async (tx, generation) => {
      const cutover = await tx.remoteEndpointCutover.findUnique({
        where: { id: cutoverId },
        include: { remoteServer: { include: { endpoints: true } } },
      });
      if (!cutover) throw new NotFoundException('Endpoint cutover not found');
      if (cutover.state === 'ACTIVATED' || cutover.state === 'FINALIZED') return cutover;
      if (cutover.state !== 'STAGED' || cutover.deadlineAt <= now) {
        throw new ConflictException(`Endpoint cutover cannot activate from ${cutover.state}`);
      }
      const server = cutover.remoteServer;
      const candidate = server.endpoints.find(
        (endpoint) => endpoint.generation === cutover.toGeneration && endpoint.state === 'CANDIDATE',
      );
      if (
        server.activeEndpointGeneration !== cutover.fromGeneration ||
        server.candidateEndpointGeneration !== cutover.toGeneration ||
        !candidate?.verifiedAt
      ) throw new ConflictException('Endpoint cutover candidate is not activation-safe');
      await tx.remoteEndpoint.update({
        where: {
          remoteServerId_generation: {
            remoteServerId: server.id,
            generation: cutover.fromGeneration,
          },
        },
        data: { state: 'PREVIOUS' },
      });
      await tx.remoteEndpoint.update({
        where: { id: candidate.id },
        data: { state: 'ACTIVE' },
      });
      await tx.remoteServer.update({
        where: { id: server.id },
        data: {
          activeEndpointGeneration: cutover.toGeneration,
          candidateEndpointGeneration: null,
          previousEndpointGeneration: cutover.fromGeneration,
          registryGeneration: generation,
          reasonCode: 'ENDPOINT_CUTOVER',
          browserState: 'REACHABLE',
          browserReasonCode: 'READY',
          browserCheckedAt: now,
          browserFreshUntil: new Date(now.getTime() + 5 * 60_000),
        },
      });
      return tx.remoteEndpointCutover.update({
        where: { id: cutover.id },
        data: { state: 'ACTIVATED', activatedAt: now, sanitizedErrorCode: null },
      });
    });
  }

  async finalizeEndpointCutover(cutoverId: string, now = new Date()) {
    return this.commitMutation(async (tx, generation) => {
      const cutover = await tx.remoteEndpointCutover.findUnique({
        where: { id: cutoverId },
        include: { remoteServer: true },
      });
      if (!cutover) throw new NotFoundException('Endpoint cutover not found');
      if (cutover.state === 'FINALIZED') return cutover;
      if (
        !['ACTIVATED', 'NEEDS_ATTENTION'].includes(cutover.state) ||
        cutover.remoteServer.activeEndpointGeneration !== cutover.toGeneration
      ) {
        throw new ConflictException(`Endpoint cutover cannot finalize from ${cutover.state}`);
      }
      await tx.remoteServer.update({
        where: { id: cutover.remoteServerId },
        data: { registryGeneration: generation, reasonCode: 'READY' },
      });
      return tx.remoteEndpointCutover.update({
        where: { id: cutover.id },
        data: { state: 'FINALIZED', finalizedAt: now, sanitizedErrorCode: null },
      });
    });
  }

  async markEndpointCutoverNeedsAttention(
    cutoverId: string,
    code: string,
  ) {
    return this.commitMutation(async (tx, generation) => {
      const cutover = await tx.remoteEndpointCutover.findUnique({ where: { id: cutoverId } });
      if (!cutover) throw new NotFoundException('Endpoint cutover not found');
      if (CUTOVER_TERMINAL_STATES.includes(cutover.state)) return cutover;
      await tx.remoteServer.update({
        where: { id: cutover.remoteServerId },
        data: {
          registryGeneration: generation,
          reasonCode: 'ENDPOINT_CUTOVER_NEEDS_ATTENTION',
        },
      });
      return tx.remoteEndpointCutover.update({
        where: { id: cutover.id },
        data: {
          state: 'NEEDS_ATTENTION',
          sanitizedErrorCode: code.slice(0, 64),
        },
      });
    });
  }

  async rollbackEndpointCutover(
    cutoverId: string,
    code = 'CUTOVER_ROLLED_BACK',
    now = new Date(),
  ) {
    return this.commitMutation(async (tx, generation) => {
      const cutover = await tx.remoteEndpointCutover.findUnique({
        where: { id: cutoverId },
        include: { remoteServer: { include: { endpoints: true } } },
      });
      if (!cutover) throw new NotFoundException('Endpoint cutover not found');
      if (cutover.state === 'ROLLED_BACK') return cutover;
      if (cutover.state === 'FINALIZED') {
        throw new ConflictException('Finalized endpoint cutover requires an explicit recovery cutover');
      }
      const server = cutover.remoteServer;
      const from = server.endpoints.find((endpoint) => endpoint.generation === cutover.fromGeneration);
      const to = server.endpoints.find((endpoint) => endpoint.generation === cutover.toGeneration);
      if (!from?.verifiedAt) throw new ConflictException('Previous endpoint is not rollback-safe');
      const activeOnCandidate = server.activeEndpointGeneration === cutover.toGeneration;
      const activeOnPrevious = server.activeEndpointGeneration === cutover.fromGeneration;
      if (!activeOnCandidate && !activeOnPrevious) {
        throw new ConflictException('Endpoint cutover active generation is inconsistent');
      }
      if (activeOnCandidate) {
        if (!to) {
          throw new ConflictException('Activated endpoint cutover state is inconsistent');
        }
        await tx.remoteEndpoint.update({ where: { id: from.id }, data: { state: 'ACTIVE' } });
        await tx.remoteEndpoint.update({ where: { id: to.id }, data: { state: 'ROLLED_BACK' } });
      } else if (to) {
        await tx.remoteEndpoint.update({ where: { id: to.id }, data: { state: 'ROLLED_BACK' } });
      }
      await tx.remoteServer.update({
        where: { id: server.id },
        data: {
          activeEndpointGeneration: cutover.fromGeneration,
          candidateEndpointGeneration: null,
          previousEndpointGeneration: to ? cutover.toGeneration : server.previousEndpointGeneration,
          registryGeneration: generation,
          reasonCode: 'READY',
        },
      });
      return tx.remoteEndpointCutover.update({
        where: { id: cutover.id },
        data: {
          state: 'ROLLED_BACK',
          rolledBackAt: now,
          sanitizedErrorCode: code.slice(0, 64),
        },
      });
    });
  }

  async repairProjection(): Promise<void> {
    await this.assertControlPlane();
    const latest = await this.prisma.registryProjectionJournal.findFirst({
      orderBy: { registryGeneration: 'desc' },
    });
    if (!latest || !['PREPARED', 'FAILED'].includes(latest.state)) {
      throw new ConflictException('No failed registry projection requires repair');
    }
    const projection = await this.renderDbProjection();
    await this.legacyFile.writeMode600(projection);
    await this.prisma.$transaction([
      this.prisma.registryProjectionJournal.update({
        where: { id: latest.id },
        data: {
          state: 'COMMITTED',
          projectionDigest: legacyRegistryDigest(projection),
          sanitizedErrorCode: null,
          committedAt: new Date(),
        },
      }),
      this.prisma.remoteServer.updateMany({ data: { mutationFrozenAt: null } }),
    ]);
  }

  async rollbackAuthorityToJson(): Promise<void> {
    await this.assertControlPlane();
    if (await this.authority() !== 'DB') throw new ConflictException('DB registry is not authoritative');
    const [operators, services] = await Promise.all([
      this.prisma.federatedPrincipal.count(),
      this.prisma.servicePrincipal.count(),
    ]);
    if (operators > 0 || services > 0) {
      throw new ConflictException('Federation principals establish the expand-compatible rollback floor');
    }
    const projection = await this.renderDbProjection();
    await this.legacyFile.writeMode600(projection);
    await this.prisma.$transaction(async (tx) => {
      const generation = await this.nextGeneration(tx);
      await tx.registryProjectionJournal.create({
        data: {
          registryGeneration: generation,
          sourceDigest: legacyRegistryDigest(projection),
          projectionDigest: legacyRegistryDigest(projection),
          state: 'ROLLED_BACK',
          committedAt: new Date(),
        },
      });
      await tx.remoteServer.updateMany({ data: { mutationFrozenAt: null } });
    });
  }

  async freezeProjection(journalId: string, code = 'PROJECTION_WRITE_FAILED'): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.registryProjectionJournal.update({
        where: { id: journalId },
        data: { state: 'FAILED', sanitizedErrorCode: code },
      }),
      this.prisma.remoteServer.updateMany({ data: { mutationFrozenAt: now } }),
    ]);
  }

  async nextGeneration(tx: RegistryTx): Promise<number> {
    const latest = await tx.registryProjectionJournal.aggregate({
      _max: { registryGeneration: true },
    });
    return (latest._max.registryGeneration ?? 0) + 1;
  }

  private async findLegacyServerOrThrow(id: string): Promise<LegacyServerRecord> {
    const rows = await this.prisma.remoteServer.findMany({
      where: { id, legacyEnabled: true },
      select: {
        id: true,
        displayName: true,
        legacyUrl: true,
        legacyTokenEnc: true,
        legacyEnabled: true,
      },
    });
    const [record] = rowsToLegacyRecords(rows);
    if (!record) throw new NotFoundException(`Server "${id}" not found`);
    return record;
  }

  private async commitMutation<T>(
    mutate: (tx: RegistryTx, generation: number) => Promise<T>,
  ): Promise<T> {
    return this.commitMutationDecision(async (tx, generation) => ({
      changed: true,
      value: await mutate(tx, generation),
    }));
  }

  private async commitMutationDecision<T>(
    mutate: (tx: RegistryTx, generation: number) => Promise<RegistryMutationDecision<T>>,
  ): Promise<T> {
    await this.assertControlPlane();
    if (await this.authority() !== 'DB') {
      throw new ServiceUnavailableException('DB registry is not mutable in the current authority state');
    }
    const prepared = await this.prisma.$transaction(async (tx) => {
      const frozen = await tx.remoteServer.count({ where: { mutationFrozenAt: { not: null } } });
      if (frozen > 0) throw new ServiceUnavailableException('Remote registry is frozen');
      const generation = await this.nextGeneration(tx);
      const decision = await mutate(tx, generation);
      if (!decision.changed) {
        return {
          changed: false as const,
          value: decision.value,
        };
      }
      const projection = await this.renderDbProjection(tx);
      const journal = await tx.registryProjectionJournal.create({
        data: {
          registryGeneration: generation,
          sourceDigest: legacyRegistryDigest(projection),
          state: 'PREPARED',
        },
        select: { id: true },
      });
      return {
        changed: true as const,
        generation,
        journalId: journal.id,
        projection,
        value: decision.value,
      };
    });
    if (!prepared.changed) return prepared.value;
    try {
      await this.legacyFile.writeMode600(prepared.projection);
      await this.prisma.registryProjectionJournal.update({
        where: { id: prepared.journalId },
        data: {
          state: 'COMMITTED',
          projectionDigest: legacyRegistryDigest(prepared.projection),
          committedAt: new Date(),
        },
      });
      return prepared.value;
    } catch (error) {
      await this.freezeProjection(prepared.journalId);
      throw new ServiceUnavailableException('Registry projection failed; further mutations are frozen', {
        cause: error,
      });
    }
  }
}
