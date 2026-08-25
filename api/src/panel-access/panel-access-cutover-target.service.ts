import {
  BadRequestException,
  ConflictException,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  FederationManifestEndpointSet,
  validateSignedFederationManifest,
} from '@meowbox/shared';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { OperationNeedsAttentionError } from '../operations/operation-errors';
import { OperationAdmissionService } from '../operations/operation-admission.service';
import {
  OperationExecutionContext,
  OperationsWorkerService,
} from '../operations/operations-worker.service';
import { FederationLocalEndpointService } from '../federation/federation-local-endpoint.service';
import { FederationManifestService } from '../federation/federation-manifest.service';
import { parseFederationOrigin } from '../federation/endpoint-normalizer';
import { validateFederationSpkiPin } from '../federation/pinned-dispatcher';
import { PanelSettingsService } from '../panel-settings/panel-settings.service';
import type { PanelAccessSettings } from './panel-access.service';
import {
  PANEL_ACCESS_AGENT_ACTION,
  PANEL_ACCESS_CUTOVER_ACTION,
  PANEL_ACCESS_TARGET_CUTOVER_STATES,
  PanelAccessAgentStageResult,
  PanelAccessCutoverRequest,
  PanelAccessTargetCutoverJournal,
} from './panel-access-cutover.types';

const CUTOVER_SETTING_KEY = 'panel-access-cutover';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACTIVE_STATES = new Set([
  'PREPARED',
  'STAGING',
  'STAGED',
  'FINALIZING',
  'ROLLING_BACK',
]);
const ROLLBACK_SAFE_OPERATION_STATES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

function validateRequest(value: unknown): PanelAccessCutoverRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Panel Access cutover request is invalid');
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).sort().join(',') !==
      ['cutoverId', 'deadlineAt', 'denyIpAccess', 'domain', 'email', 'httpsRedirect'].sort().join(',') ||
    typeof input.cutoverId !== 'string' || !UUID.test(input.cutoverId) ||
    typeof input.domain !== 'string' || !DOMAIN.test(input.domain) ||
    typeof input.email !== 'string' || !EMAIL.test(input.email) ||
    typeof input.httpsRedirect !== 'boolean' ||
    typeof input.denyIpAccess !== 'boolean' ||
    typeof input.deadlineAt !== 'string' ||
    !Number.isFinite(Date.parse(input.deadlineAt))
  ) throw new BadRequestException('Panel Access cutover request is invalid');
  return input as unknown as PanelAccessCutoverRequest;
}

function validateSettings(value: unknown): PanelAccessSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Panel Access settings are invalid');
  }
  const settings = value as PanelAccessSettings;
  if (
    (settings.domain !== null && (typeof settings.domain !== 'string' || !DOMAIN.test(settings.domain))) ||
    !['NONE', 'SELFSIGNED', 'LE'].includes(settings.certMode) ||
    typeof settings.httpsRedirect !== 'boolean' ||
    typeof settings.denyIpAccess !== 'boolean'
  ) throw new Error('Panel Access settings are invalid');
  return settings;
}

function validateAgentStageResult(
  value: unknown,
  request: PanelAccessCutoverRequest,
): PanelAccessAgentStageResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent returned an invalid Panel Access candidate');
  }
  const result = value as PanelAccessAgentStageResult;
  if (
    result.cutoverId !== request.cutoverId ||
    result.state !== 'STAGED' ||
    typeof result.candidateOrigin !== 'string' ||
    validateFederationSpkiPin(result.spkiSha256) !== result.spkiSha256
  ) throw new Error('Agent returned an invalid Panel Access candidate');
  const origin = parseFederationOrigin(result.candidateOrigin);
  if (origin.hostname !== request.domain) {
    throw new Error('Panel Access candidate origin does not match the requested domain');
  }
  const settings = validateSettings(result.candidateSettings);
  if (
    settings.domain !== request.domain ||
    settings.certMode !== 'LE' ||
    settings.httpsRedirect !== request.httpsRedirect ||
    settings.denyIpAccess !== request.denyIpAccess ||
    !settings.certPath ||
    !settings.keyPath
  ) throw new Error('Agent returned mismatched Panel Access settings');
  return result;
}

function endpointForOrigin(
  origin: string,
  socketPath: string,
): FederationManifestEndpointSet {
  parseFederationOrigin(origin);
  return {
    apiOrigin: origin,
    apiPath: '/api',
    wsOrigin: origin,
    socketPath,
    browserPublicOrigin: origin,
    directTransferOrigin: origin,
  };
}

@Injectable()
export class PanelAccessCutoverTargetService
implements OnModuleInit, OnModuleDestroy {
  private unregisterHandler: (() => void) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PanelSettingsService,
    private readonly agent: AgentRelayService,
    private readonly admission: OperationAdmissionService,
    private readonly worker: OperationsWorkerService,
    private readonly localEndpoint: FederationLocalEndpointService,
    private readonly manifests: FederationManifestService,
  ) {}

  onModuleInit(): void {
    this.unregisterHandler = this.worker.registerHandler(
      PANEL_ACCESS_CUTOVER_ACTION,
      (request, context) => this.stage(request, context),
    );
  }

  onModuleDestroy(): void {
    this.unregisterHandler?.();
    this.unregisterHandler = null;
  }

  async start(
    raw: PanelAccessCutoverRequest,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    const request = validateRequest(raw);
    const deadlineAt = Date.parse(request.deadlineAt);
    const remaining = deadlineAt - Date.now();
    if (remaining < 30_000 || remaining > 20 * 60_000) {
      throw new BadRequestException('Panel Access cutover deadline is invalid');
    }
    if (actor.role !== 'ADMIN') {
      throw new BadRequestException('Panel Access cutover requires ADMIN');
    }
    const existing = await this.getJournal();
    if (
      existing &&
      ACTIVE_STATES.has(existing.state) &&
      existing.cutoverId !== request.cutoverId
    ) throw new ConflictException('Another Panel Access cutover is active');

    return this.admission.admit({
      actionId: PANEL_ACCESS_CUTOVER_ACTION,
      type: 'PANEL_ACCESS_CUTOVER',
      idempotencyKey,
      actor,
      request,
      deadlineMs: remaining,
      recoveryPolicy: 'MANUAL',
      retryable: false,
      globalLockKey: 'panel-access-cutover',
    });
  }

  async status(cutoverId: string): Promise<PanelAccessTargetCutoverJournal> {
    if (!UUID.test(cutoverId)) throw new BadRequestException('Invalid cutover ID');
    const journal = await this.getJournal();
    if (!journal || journal.cutoverId !== cutoverId) {
      throw new ConflictException('Panel Access cutover is not present on this target');
    }
    return this.reconcileAgentState(journal);
  }

  async finalize(cutoverId: string): Promise<PanelAccessTargetCutoverJournal> {
    const journal = await this.status(cutoverId);
    if (journal.state === 'FINALIZED') return journal;
    if (
      !['STAGED', 'FINALIZING', 'NEEDS_ATTENTION'].includes(journal.state) ||
      !journal.candidateSettings ||
      !journal.candidate
    ) {
      throw new ConflictException(`Panel Access cutover cannot finalize from ${journal.state}`);
    }
    const finalizing = { ...journal, state: 'FINALIZING' as const, updatedAt: new Date().toISOString() };
    await this.setJournal(finalizing);
    const response = await this.agent.emitToAgent(
      'panel-access:finalize-cutover',
      {
        cutoverId,
        candidateOrigin: journal.candidate.endpoints.apiOrigin,
      },
      60_000,
    );
    const ack = response as unknown as { success?: boolean; error?: string };
    if (ack.success !== true) {
      await this.setJournal({
        ...finalizing,
        state: 'NEEDS_ATTENTION',
        sanitizedErrorCode: 'TARGET_FINALIZE_FAILED',
        updatedAt: new Date().toISOString(),
      });
      throw new ConflictException(ack.error || 'Target Panel Access finalize failed');
    }
    const finalized: PanelAccessTargetCutoverJournal = {
      ...journal,
      state: 'FINALIZED',
      sanitizedErrorCode: null,
      updatedAt: new Date().toISOString(),
    };
    await this.setSettingsAndJournal(journal.candidateSettings, finalized);
    this.manifests.invalidateCache();
    return finalized;
  }

  async rollback(cutoverId: string): Promise<PanelAccessTargetCutoverJournal> {
    if (!UUID.test(cutoverId)) throw new BadRequestException('Invalid cutover ID');
    const stored = await this.getJournal();
    if (!stored) {
      const endpoint = this.localEndpoint.getClaim();
      if (endpoint.state !== 'READY') {
        throw new ConflictException('Target federation endpoint is not configured');
      }
      return {
        schemaVersion: 1,
        cutoverId,
        state: 'ROLLED_BACK',
        operationId: cutoverId,
        deadlineAt: new Date().toISOString(),
        previousSettings: await this.settings.getPanelAccess(),
        previousEndpoint: endpoint.endpoints,
        candidateSettings: null,
        candidate: null,
        sanitizedErrorCode: null,
        updatedAt: new Date().toISOString(),
      };
    }
    if (stored.cutoverId !== cutoverId) {
      throw new ConflictException('Another Panel Access cutover is present on this target');
    }
    const operation = await this.prisma.operation.findUnique({
      where: { id: stored.operationId },
      select: { status: true },
    });
    if (!operation || !ROLLBACK_SAFE_OPERATION_STATES.has(operation.status)) {
      throw new ConflictException('Panel Access stage operation must reach a rollback-safe terminal state');
    }
    const journal = await this.reconcileAgentState(stored);
    if (journal.state === 'ROLLED_BACK') return journal;
    if (!ACTIVE_STATES.has(journal.state) && journal.state !== 'FINALIZED' && journal.state !== 'NEEDS_ATTENTION') {
      throw new ConflictException(`Panel Access cutover cannot roll back from ${journal.state}`);
    }
    const rolling = { ...journal, state: 'ROLLING_BACK' as const, updatedAt: new Date().toISOString() };
    await this.setJournal(rolling);
    const response = await this.agent.emitToAgent(
      'panel-access:rollback-cutover',
      { cutoverId },
      60_000,
    );
    const ack = response as unknown as { success?: boolean; error?: string };
    if (ack.success !== true) {
      await this.setJournal({
        ...rolling,
        state: 'NEEDS_ATTENTION',
        sanitizedErrorCode: 'TARGET_ROLLBACK_FAILED',
        updatedAt: new Date().toISOString(),
      });
      throw new ConflictException(ack.error || 'Target Panel Access rollback failed');
    }
    const rolledBack: PanelAccessTargetCutoverJournal = {
      ...journal,
      state: 'ROLLED_BACK',
      sanitizedErrorCode: null,
      updatedAt: new Date().toISOString(),
    };
    await this.setSettingsAndJournal(journal.previousSettings, rolledBack);
    this.manifests.invalidateCache();
    return rolledBack;
  }

  private async stage(
    raw: unknown,
    context: OperationExecutionContext,
  ): Promise<unknown> {
    const request = validateRequest(raw);
    if (context.actor.role !== 'ADMIN') {
      throw new OperationNeedsAttentionError('Panel Access cutover actor is not ADMIN');
    }
    const endpoint = this.localEndpoint.getClaim();
    if (endpoint.state !== 'READY') {
      throw new OperationNeedsAttentionError('Target federation endpoint is not configured');
    }
    const currentSettings = await this.settings.getPanelAccess();
    if (currentSettings.certMode === 'NONE') {
      throw new OperationNeedsAttentionError('Current federation endpoint has no rollback-safe TLS listener');
    }
    const existing = await this.getJournal();
    if (existing?.cutoverId === request.cutoverId && existing.candidate) {
      return { cutoverId: request.cutoverId, state: existing.state, candidate: existing.candidate };
    }
    if (existing && ACTIVE_STATES.has(existing.state) && existing.cutoverId !== request.cutoverId) {
      throw new OperationNeedsAttentionError('Another Panel Access cutover is active');
    }
    const staging: PanelAccessTargetCutoverJournal = {
      schemaVersion: 1,
      cutoverId: request.cutoverId,
      state: 'STAGING',
      operationId: context.operationId,
      deadlineAt: request.deadlineAt,
      previousSettings: currentSettings,
      previousEndpoint: endpoint.endpoints,
      candidateSettings: null,
      candidate: null,
      sanitizedErrorCode: null,
      updatedAt: new Date().toISOString(),
    };
    await this.setJournal(staging);
    try {
      await context.heartbeat('stage-candidate', 10);
      const result = validateAgentStageResult(
        await this.agent.runAgentJob({
          operationId: context.operationId,
          actionId: PANEL_ACCESS_AGENT_ACTION,
          step: 'stage-candidate',
          payload: {
            cutoverId: request.cutoverId,
            domain: request.domain,
            email: request.email,
            httpsRedirect: request.httpsRedirect,
            denyIpAccess: request.denyIpAccess,
            previousSettings: currentSettings,
            previousEndpoint: {
              apiOrigin: endpoint.endpoints.apiOrigin,
              wsOrigin: endpoint.endpoints.wsOrigin,
              wsPath: endpoint.endpoints.socketPath,
              browserPublicOrigin: endpoint.endpoints.browserPublicOrigin,
              directTransferOrigin: endpoint.endpoints.directTransferOrigin,
            },
          },
          deadlineAt: context.deadlineAt,
          cancelSafe: false,
        }),
        request,
      );
      const candidateEndpoints = endpointForOrigin(
        result.candidateOrigin,
        endpoint.endpoints.socketPath,
      );
      const candidate = {
        endpoints: candidateEndpoints,
        spkiSha256: result.spkiSha256,
        manifest: await this.manifests.manifestForEndpoint(candidateEndpoints),
      };
      validateSignedFederationManifest(candidate.manifest);
      const staged: PanelAccessTargetCutoverJournal = {
        ...staging,
        state: 'STAGED',
        candidateSettings: result.candidateSettings,
        candidate,
        updatedAt: new Date().toISOString(),
      };
      await this.setJournal(staged);
      await context.heartbeat('candidate-ready', 100);
      return { cutoverId: request.cutoverId, state: 'STAGED', candidate };
    } catch (error) {
      await this.setJournal({
        ...staging,
        state: 'NEEDS_ATTENTION',
        sanitizedErrorCode: 'TARGET_STAGE_FAILED',
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  private async getJournal(): Promise<PanelAccessTargetCutoverJournal | null> {
    const row = await this.prisma.panelSetting.findUnique({
      where: { key: CUTOVER_SETTING_KEY },
      select: { value: true },
    });
    if (!row) return null;
    let value: PanelAccessTargetCutoverJournal;
    try { value = JSON.parse(row.value); } catch { throw new ConflictException('Panel Access cutover journal is corrupt'); }
    if (
      value.schemaVersion !== 1 ||
      !UUID.test(value.cutoverId) ||
      !UUID.test(value.operationId) ||
      !(PANEL_ACCESS_TARGET_CUTOVER_STATES as readonly string[]).includes(value.state) ||
      !Number.isFinite(Date.parse(value.deadlineAt)) ||
      !Number.isFinite(Date.parse(value.updatedAt))
    ) throw new ConflictException('Panel Access cutover journal is corrupt');
    validateSettings(value.previousSettings);
    if (value.candidateSettings) validateSettings(value.candidateSettings);
    if (value.candidate) {
      validateFederationSpkiPin(value.candidate.spkiSha256);
      validateSignedFederationManifest(value.candidate.manifest);
    }
    return value;
  }

  private async reconcileAgentState(
    journal: PanelAccessTargetCutoverJournal,
  ): Promise<PanelAccessTargetCutoverJournal> {
    if (!['FINALIZING', 'ROLLING_BACK', 'NEEDS_ATTENTION'].includes(journal.state)) {
      return journal;
    }
    let response: unknown;
    try {
      response = await this.agent.emitToAgent(
        'panel-access:cutover-status',
        { cutoverId: journal.cutoverId },
        10_000,
      );
    } catch {
      return journal;
    }
    const status = response as {
      success?: boolean;
      state?: 'STAGED' | 'FINALIZED' | 'ROLLED_BACK';
      candidateOrigin?: string;
    };
    if (status.success !== true || !status.state) return journal;
    if (
      journal.candidate &&
      status.candidateOrigin !== journal.candidate.endpoints.apiOrigin
    ) {
      const attention = {
        ...journal,
        state: 'NEEDS_ATTENTION' as const,
        sanitizedErrorCode: 'AGENT_CUTOVER_IDENTITY_MISMATCH',
        updatedAt: new Date().toISOString(),
      };
      await this.setJournal(attention);
      return attention;
    }
    if (status.state === 'FINALIZED' && journal.candidateSettings) {
      const finalized = {
        ...journal,
        state: 'FINALIZED' as const,
        sanitizedErrorCode: null,
        updatedAt: new Date().toISOString(),
      };
      await this.setSettingsAndJournal(journal.candidateSettings, finalized);
      this.manifests.invalidateCache();
      return finalized;
    }
    if (status.state === 'ROLLED_BACK') {
      const rolledBack = {
        ...journal,
        state: 'ROLLED_BACK' as const,
        sanitizedErrorCode: null,
        updatedAt: new Date().toISOString(),
      };
      await this.setSettingsAndJournal(journal.previousSettings, rolledBack);
      this.manifests.invalidateCache();
      return rolledBack;
    }
    return journal;
  }

  private async setSettingsAndJournal(
    settings: PanelAccessSettings,
    journal: PanelAccessTargetCutoverJournal,
  ): Promise<void> {
    const settingsValue = JSON.stringify(settings);
    const journalValue = JSON.stringify(journal);
    if (Buffer.byteLength(journalValue, 'utf8') > 1024 * 1024) {
      throw new ConflictException('Panel Access cutover journal is too large');
    }
    await this.prisma.$transaction([
      this.prisma.panelSetting.upsert({
        where: { key: 'panel-access' },
        create: { key: 'panel-access', value: settingsValue },
        update: { value: settingsValue },
      }),
      this.prisma.panelSetting.upsert({
        where: { key: CUTOVER_SETTING_KEY },
        create: { key: CUTOVER_SETTING_KEY, value: journalValue },
        update: { value: journalValue },
      }),
    ]);
  }

  private async setJournal(journal: PanelAccessTargetCutoverJournal): Promise<void> {
    const value = JSON.stringify(journal);
    if (Buffer.byteLength(value, 'utf8') > 1024 * 1024) {
      throw new ConflictException('Panel Access cutover journal is too large');
    }
    await this.prisma.panelSetting.upsert({
      where: { key: CUTOVER_SETTING_KEY },
      create: { key: CUTOVER_SETTING_KEY, value },
      update: { value },
    });
  }
}
