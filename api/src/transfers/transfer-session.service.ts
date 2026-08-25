import {
  ConflictException,
  GoneException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validatePublicDelivery, type TransferSessionDelivery } from '@meowbox/shared';
import { Prisma, type TransferSession as PrismaTransferSession } from '@prisma/client';
import type { Response } from 'express';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';
import { decryptWithDomain, deriveKey, encryptWithDomain } from '../common/crypto/master-key';
import { attachmentDisposition } from '../common/http/content-disposition';
import { PrismaService } from '../common/prisma.service';
import { PanelIdentityService } from '../federation/panel-identity.service';
import { PublicDeliveryOriginService } from '../public-delivery/public-delivery-origin.service';
import { setTransferCorsHeaders } from './transfer-http';
import {
  assertTransferActor,
  assertTransferPresentation,
  assertTransferResource,
  type TransferActor,
  TRANSFER_SOURCE_KIND,
  TRANSFER_UUID,
} from './transfer-validation';

const SECRET = /^[A-Za-z0-9_-]{43}$/;
const IDEMPOTENCY_KEY = /^[\x20-\x7e]{8,128}$/;
const DEFAULT_FIRST_BYTE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_STAGED_LEASE_TTL_MS = 4 * 60 * 60 * 1000;
const SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

export type { TransferActor } from './transfer-validation';

export interface GeneratedStreamSource {
  stream(
    resourceId: string,
    actor: TransferActor,
    response: Response,
    resourcePayload: unknown,
  ): Promise<void>;
}

export interface IssueGeneratedStreamInput {
  sourceKind: string;
  resourceId: string;
  actor: TransferActor;
  filename: string;
  contentType: string;
  resourceExpiresAt: Date;
  resourcePayload?: unknown;
}

export interface IssueStagedArtifactInput {
  artifactId: string;
  actor: TransferActor;
}

export interface IssueStagedUploadInput {
  sourceKind: string;
  resourceId: string;
  actor: TransferActor;
  filename: string;
  contentType: string;
  contentLength: number;
  resourceExpiresAt: Date;
  idempotencyKey: string;
}

export interface StagedTransferSession {
  id: string;
  targetInstallationId: string;
  artifactId: string;
  sourceKind: string;
  resourceId: string;
  actorUserId: string;
  actorRole: string;
  contentType: string;
  filename: string;
  contentLength: bigint;
  sha256: string;
  expiresAt: Date;
}

export interface StagedUploadSession {
  id: string;
  targetInstallationId: string;
  artifactId: string;
  sourceKind: string;
  resourceId: string;
  actorUserId: string;
  actorRole: string;
  contentType: string;
  filename: string;
  contentLength: bigint;
  expiresAt: Date;
}

export interface CompletedUpload {
  artifactId: string;
  sizeBytes: number;
  sha256: string;
}

export interface StagedDeliveryHandler {
  prepareUploadAdmission(expectedBytes: number): Promise<void>;
  upload(session: StagedUploadSession, source: Readable): Promise<CompletedUpload>;
  reconcileUpload(session: StagedUploadSession): Promise<CompletedUpload | null>;
  head(session: StagedTransferSession, response: Response): Promise<void>;
  download(
    session: StagedTransferSession,
    rangeHeader: string | undefined,
    ifRangeHeader: string | undefined,
    response: Response,
  ): Promise<void>;
}

function positiveInt(config: ConfigService, key: string, fallback: number): number {
  const value = Number(config.get(key, fallback));
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function secureHashMatch(stored: string, candidate: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(stored) || !/^[0-9a-f]{64}$/.test(candidate)) return false;
  return timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(candidate, 'hex'));
}

function uuidFromDigest(digest: Buffer): string {
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function deriveUploadMaterial(
  targetInstallationId: string,
  actorUserId: string,
  idempotencyKey: string,
): { sessionId: string; artifactId: string; secret: string } {
  const key = deriveKey('transfers');
  const seed = `${targetInstallationId}\0${actorUserId}\0${idempotencyKey}`;
  const digest = (label: string) => createHmac('sha256', key)
    .update(`meowbox:transfer-upload:${label}:v1\0`, 'utf8')
    .update(seed, 'utf8')
    .digest();
  return {
    sessionId: uuidFromDigest(digest('session')),
    artifactId: uuidFromDigest(digest('artifact')),
    secret: digest('secret').toString('base64url'),
  };
}

@Injectable()
export class TransferSessionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TransferSessionService.name);
  private readonly sources = new Map<string, GeneratedStreamSource>();
  private readonly firstByteTtlMs: number;
  private readonly maxNewPerMinute: number;
  private readonly maxActivePerActor: number;
  private readonly maxActivePerTarget: number;
  private readonly stagedLeaseTtlMs: number;
  private stagedHandler: StagedDeliveryHandler | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly identity: PanelIdentityService,
    private readonly origins: PublicDeliveryOriginService,
  ) {
    this.firstByteTtlMs = positiveInt(config, 'TRANSFER_FIRST_BYTE_TTL_MS', DEFAULT_FIRST_BYTE_TTL_MS);
    this.maxNewPerMinute = positiveInt(config, 'TRANSFER_NEW_PER_MINUTE_PER_ACTOR', 5);
    this.maxActivePerActor = positiveInt(config, 'TRANSFER_ACTIVE_PER_ACTOR', 2);
    this.maxActivePerTarget = positiveInt(config, 'TRANSFER_ACTIVE_PER_TARGET', 4);
    this.stagedLeaseTtlMs = positiveInt(config, 'TRANSFER_STAGED_LEASE_TTL_MS', DEFAULT_STAGED_LEASE_TTL_MS);
  }

  onModuleInit(): void {
    void this.cleanupExpired();
    this.cleanupTimer = setInterval(() => void this.cleanupExpired(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    this.sources.clear();
    this.stagedHandler = null;
  }

  registerGeneratedSource(sourceKind: string, source: GeneratedStreamSource): () => void {
    if (!TRANSFER_SOURCE_KIND.test(sourceKind) || this.sources.has(sourceKind)) {
      throw new Error(`Transfer source registration is invalid: ${sourceKind}`);
    }
    this.sources.set(sourceKind, source);
    return () => {
      if (this.sources.get(sourceKind) === source) this.sources.delete(sourceKind);
    };
  }

  registerStagedDeliveryHandler(handler: StagedDeliveryHandler): () => void {
    if (this.stagedHandler) throw new Error('Staged transfer handler is already registered');
    this.stagedHandler = handler;
    return () => {
      if (this.stagedHandler === handler) this.stagedHandler = null;
    };
  }

  async issueGeneratedStream(input: IssueGeneratedStreamInput): Promise<TransferSessionDelivery> {
    this.validateIssue(input);
    const localIdentity = await this.identity.getLocalIdentity();
    const now = new Date();
    const expiresAt = new Date(Math.min(
      input.resourceExpiresAt.getTime(),
      now.getTime() + this.firstByteTtlMs,
    ));
    if (expiresAt.getTime() <= now.getTime() + 1_000) {
      throw new GoneException('Transfer resource is expired');
    }
    await this.assertAdmission(input.actor.userId, localIdentity.installationId, now);
    const id = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const resourcePayloadEnc = input.resourcePayload === undefined
      ? null
      : encryptWithDomain('transfers', {
          sessionId: id,
          sourceKind: input.sourceKind,
          resourceId: input.resourceId,
          payload: input.resourcePayload,
        });
    await this.prisma.transferSession.create({
      data: {
        id,
        targetInstallationId: localIdentity.installationId,
        purpose: 'DOWNLOAD',
        sourceKind: input.sourceKind,
        resourceId: input.resourceId,
        resourcePayloadEnc,
        transferMode: 'GENERATED_STREAM',
        secretHash: sha256(secret),
        actorUserId: input.actor.userId,
        actorRole: input.actor.role,
        contentType: input.contentType,
        filename: input.filename,
        expiresAt,
      },
    });
    const delivery: TransferSessionDelivery = {
      kind: 'TransferSession',
      purpose: 'DOWNLOAD',
      targetInstallationId: localIdentity.installationId,
      resource: { kind: input.sourceKind, id: input.resourceId },
      method: 'GET',
      allowedHeaders: [],
      cachePolicy: 'NO_STORE',
      referrerPolicy: 'NO_REFERRER',
      expiresAt: expiresAt.toISOString(),
      browserReachabilityRequired: true,
      rangeSupported: false,
      resumeSupported: false,
      fallbackReason: null,
      url: `${this.origins.directTransferOrigin()}/api/public/v1/transfers/${id}/download?secret=${secret}`,
      reusable: false,
      transferMode: 'GENERATED_STREAM',
      contentLength: null,
      sha256: null,
      leaseId: id,
    };
    this.logger.log(`transfer.session outcome=issued mode=GENERATED_STREAM source=${input.sourceKind}`);
    return validatePublicDelivery(delivery) as TransferSessionDelivery;
  }

  async issueStagedArtifact(input: IssueStagedArtifactInput): Promise<TransferSessionDelivery> {
    assertTransferActor(input.actor);
    if (!TRANSFER_UUID.test(input.artifactId) || !this.stagedHandler) {
      throw new Error('Staged transfer session request is invalid');
    }
    const artifact = await this.prisma.transferArtifact.findUnique({ where: { id: input.artifactId } });
    if (!artifact) throw new NotFoundException('Transfer artifact not found');
    if (artifact.state !== 'READY' || !artifact.readyAt || artifact.deletedAt) {
      throw new ConflictException('Transfer artifact is not ready');
    }
    if (input.actor.role !== 'ADMIN' && artifact.createdByUserId !== input.actor.userId) {
      throw new UnauthorizedException('Transfer artifact does not belong to actor');
    }
    if (
      artifact.expiresAt.getTime() <= Date.now() ||
      artifact.sizeBytes === null || artifact.sizeBytes < 0n ||
      artifact.sizeBytes > BigInt(Number.MAX_SAFE_INTEGER) ||
      !artifact.sha256 || !/^[0-9a-f]{64}$/.test(artifact.sha256)
    ) throw new GoneException('Transfer artifact is expired or incomplete');

    const localIdentity = await this.identity.getLocalIdentity();
    if (artifact.targetInstallationId !== localIdentity.installationId) {
      throw new UnauthorizedException('Transfer artifact target mismatch');
    }
    const now = new Date();
    const expiresAt = new Date(Math.min(
      artifact.expiresAt.getTime(),
      now.getTime() + this.stagedLeaseTtlMs,
    ));
    await this.assertAdmission(input.actor.userId, localIdentity.installationId, now);
    const id = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    await this.prisma.transferSession.create({
      data: {
        id,
        targetInstallationId: localIdentity.installationId,
        purpose: 'DOWNLOAD',
        sourceKind: artifact.sourceKind,
        resourceId: artifact.resourceId,
        transferMode: 'STAGED_ARTIFACT',
        secretHash: sha256(secret),
        actorUserId: input.actor.userId,
        actorRole: input.actor.role,
        contentType: artifact.contentType,
        filename: artifact.filename,
        artifactId: artifact.id,
        contentLength: artifact.sizeBytes,
        sha256: artifact.sha256,
        expiresAt,
      },
    });
    const delivery: TransferSessionDelivery = {
      kind: 'TransferSession',
      purpose: 'DOWNLOAD',
      targetInstallationId: localIdentity.installationId,
      resource: { kind: artifact.sourceKind, id: artifact.resourceId },
      method: 'GET',
      allowedHeaders: ['range', 'if-range'],
      cachePolicy: 'NO_STORE',
      referrerPolicy: 'NO_REFERRER',
      expiresAt: expiresAt.toISOString(),
      browserReachabilityRequired: true,
      rangeSupported: true,
      resumeSupported: true,
      fallbackReason: null,
      url: `${this.origins.directTransferOrigin()}/api/public/v1/transfers/${id}/download?secret=${secret}`,
      reusable: true,
      transferMode: 'STAGED_ARTIFACT',
      contentLength: Number(artifact.sizeBytes),
      sha256: artifact.sha256,
      leaseId: id,
    };
    this.logger.log(`transfer.session outcome=issued mode=STAGED_ARTIFACT source=${artifact.sourceKind}`);
    return validatePublicDelivery(delivery) as TransferSessionDelivery;
  }

  async issueStagedUpload(input: IssueStagedUploadInput): Promise<TransferSessionDelivery> {
    assertTransferResource(input.sourceKind, input.resourceId);
    assertTransferPresentation(input.filename, input.contentType);
    assertTransferActor(input.actor);
    if (
      !IDEMPOTENCY_KEY.test(input.idempotencyKey) ||
      !Number.isSafeInteger(input.contentLength) || input.contentLength < 0 ||
      !(input.resourceExpiresAt instanceof Date) ||
      !Number.isFinite(input.resourceExpiresAt.getTime())
    ) throw new Error('Staged upload session request is invalid');
    const handler = this.stagedHandler;
    if (!handler) throw new NotFoundException('Staged transfer handler is unavailable');

    const localIdentity = await this.identity.getLocalIdentity();
    const now = new Date();
    const artifactExpiresAt = new Date(Math.min(
      input.resourceExpiresAt.getTime(),
      now.getTime() + this.stagedLeaseTtlMs,
    ));
    const expiresAt = new Date(Math.min(
      artifactExpiresAt.getTime(),
      now.getTime() + this.firstByteTtlMs,
    ));
    if (expiresAt.getTime() <= now.getTime() + 1_000) {
      throw new GoneException('Transfer resource is expired');
    }
    const material = deriveUploadMaterial(
      localIdentity.installationId,
      input.actor.userId,
      input.idempotencyKey,
    );
    const existing = await this.prisma.transferSession.findUnique({
      where: { id: material.sessionId },
    });
    if (existing) {
      return this.replayStagedUpload(existing, material.secret, material.artifactId, input);
    }

    await handler.prepareUploadAdmission(input.contentLength);
    await this.assertAdmission(input.actor.userId, localIdentity.installationId, now);
    try {
      await this.prisma.$transaction(async (transaction) => {
        await transaction.transferArtifact.create({
          data: {
            id: material.artifactId,
            targetInstallationId: localIdentity.installationId,
            sourceKind: input.sourceKind,
            resourceId: input.resourceId,
            state: 'STAGING',
            relativePath: `${material.artifactId}.artifact`,
            contentType: input.contentType,
            filename: input.filename,
            createdByUserId: input.actor.userId,
            expiresAt: artifactExpiresAt,
          },
        });
        await transaction.transferSession.create({
          data: {
            id: material.sessionId,
            targetInstallationId: localIdentity.installationId,
            purpose: 'UPLOAD',
            sourceKind: input.sourceKind,
            resourceId: input.resourceId,
            transferMode: 'STAGED_ARTIFACT',
            secretHash: sha256(material.secret),
            actorUserId: input.actor.userId,
            actorRole: input.actor.role,
            contentType: input.contentType,
            filename: input.filename,
            artifactId: material.artifactId,
            contentLength: BigInt(input.contentLength),
            expiresAt,
          },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.prisma.transferSession.findUnique({
          where: { id: material.sessionId },
        });
        if (raced) return this.replayStagedUpload(raced, material.secret, material.artifactId, input);
      }
      throw error;
    }
    this.logger.log(`transfer.session outcome=issued purpose=UPLOAD source=${input.sourceKind}`);
    return this.buildUploadDelivery({
      id: material.sessionId,
      targetInstallationId: localIdentity.installationId,
      sourceKind: input.sourceKind,
      resourceId: input.resourceId,
      contentLength: BigInt(input.contentLength),
      expiresAt,
    }, material.secret);
  }

  async upload(
    id: string,
    secret: string,
    contentLengthHeader: string | undefined,
    contentTypeHeader: string | undefined,
    source: Readable,
  ): Promise<CompletedUpload> {
    const session = await this.requireSession(id, secret);
    if (session.purpose !== 'UPLOAD' || session.transferMode !== 'STAGED_ARTIFACT') {
      throw new ConflictException('Transfer session is not an upload');
    }
    if (!this.stagedHandler) throw new NotFoundException('Staged transfer handler is unavailable');
    if (!/^(0|[1-9]\d*)$/.test(contentLengthHeader ?? '')) {
      throw new HttpException('Content-Length is required', HttpStatus.LENGTH_REQUIRED);
    }
    const contentLength = BigInt(contentLengthHeader!);
    if (session.contentLength === null || contentLength !== session.contentLength) {
      throw new HttpException('Upload length does not match the session', HttpStatus.PAYLOAD_TOO_LARGE);
    }
    if ((contentTypeHeader ?? '').trim().toLowerCase() !== session.contentType.toLowerCase()) {
      throw new HttpException('Upload content type does not match the session', HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    }

    const stagedSession = this.toStagedUploadSession(session);
    const claimed = await this.prisma.transferSession.updateMany({
      where: {
        id: session.id,
        purpose: 'UPLOAD',
        startedAt: null,
        completedAt: null,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { startedAt: new Date(), failureCode: null },
    });
    if (claimed.count !== 1) {
      const reconciled = await this.stagedHandler.reconcileUpload(stagedSession);
      if (!reconciled) throw new ConflictException('Transfer upload is already in progress');
      await this.finalizeUpload(session.id, reconciled);
      return reconciled;
    }

    try {
      const completed = await this.stagedHandler.upload(stagedSession, source);
      await this.finalizeUpload(session.id, completed);
      this.logger.log(`transfer.session outcome=completed purpose=UPLOAD source=${session.sourceKind}`);
      return completed;
    } catch (error) {
      await this.prisma.transferSession.updateMany({
        where: { id: session.id, completedAt: null },
        data: {
          completedAt: new Date(),
          consumedAt: new Date(),
          failureCode: 'UPLOAD_FAILED',
        },
      }).catch(() => undefined);
      throw error;
    }
  }

  async head(id: string, secret: string, response: Response): Promise<void> {
    const session = await this.requireSession(id, secret);
    if (session.purpose !== 'DOWNLOAD') throw new ConflictException('Transfer session is not a download');
    if (session.transferMode === 'STAGED_ARTIFACT') {
      if (!this.stagedHandler) throw new NotFoundException('Staged transfer handler is unavailable');
      await this.stagedHandler.head(this.toStagedSession(session), response);
      return;
    }
    if (session.transferMode !== 'GENERATED_STREAM') throw new ConflictException('Transfer mode is not available');
    this.setResponseHeaders(response, session.contentType, session.filename);
    response.setHeader('Accept-Ranges', 'none');
  }

  async streamGenerated(
    id: string,
    secret: string,
    rangeHeader: string | undefined,
    response: Response,
  ): Promise<void> {
    const session = await this.requireSession(id, secret);
    if (session.purpose !== 'DOWNLOAD') throw new ConflictException('Transfer session is not a download');
    if (session.transferMode !== 'GENERATED_STREAM') {
      throw new ConflictException('Transfer mode is not available');
    }
    await this.streamGeneratedSession(session, rangeHeader, response);
  }

  async download(
    id: string,
    secret: string,
    rangeHeader: string | undefined,
    ifRangeHeader: string | undefined,
    response: Response,
  ): Promise<void> {
    const session = await this.requireSession(id, secret);
    if (session.purpose !== 'DOWNLOAD') throw new ConflictException('Transfer session is not a download');
    if (session.transferMode === 'GENERATED_STREAM') {
      await this.streamGeneratedSession(session, rangeHeader, response);
      return;
    }
    if (session.transferMode !== 'STAGED_ARTIFACT' || !this.stagedHandler) {
      throw new ConflictException('Transfer mode is not available');
    }
    await this.prisma.transferSession.updateMany({
      where: { id: session.id, startedAt: null, expiresAt: { gt: new Date() } },
      data: { startedAt: new Date(), failureCode: null },
    });
    let finalized = false;
    const finalize = (failureCode: string | null) => {
      if (finalized) return;
      finalized = true;
      void this.prisma.transferSession.update({
        where: { id: session.id },
        data: { completedAt: new Date(), failureCode },
      }).catch((error: unknown) => {
        this.logger.warn(`transfer.session outcome=finalize_failed type=${(error as Error).name}`);
      });
    };
    response.once('finish', () => finalize(response.statusCode >= 400 ? 'ARTIFACT_FAILED' : null));
    response.once('close', () => {
      if (!response.writableFinished) finalize('CLIENT_ABORTED');
    });
    try {
      await this.stagedHandler.download(
        this.toStagedSession(session),
        rangeHeader,
        ifRangeHeader,
        response,
      );
      this.logger.log(`transfer.session outcome=started mode=STAGED_ARTIFACT source=${session.sourceKind}`);
    } catch (error) {
      finalize('ARTIFACT_FAILED');
      throw error;
    }
  }

  private async streamGeneratedSession(
    session: PrismaTransferSession,
    rangeHeader: string | undefined,
    response: Response,
  ): Promise<void> {
    if (rangeHeader) {
      throw new HttpException(
        'Range is not supported for generated streams',
        HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
      );
    }
    const source = this.sources.get(session.sourceKind);
    if (!source) throw new NotFoundException('Transfer source is unavailable');
    const claimed = await this.prisma.transferSession.updateMany({
      where: {
        id: session.id,
        startedAt: null,
        completedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { startedAt: new Date() },
    });
    if (claimed.count !== 1) throw new GoneException('Transfer session was already started');

    this.setResponseHeaders(response, session.contentType, session.filename);
    response.setHeader('Accept-Ranges', 'none');
    let finalized = false;
    const finalize = (failureCode: string | null) => {
      if (finalized) return;
      finalized = true;
      void this.prisma.transferSession.updateMany({
        where: { id: session.id, completedAt: null },
        data: {
          completedAt: new Date(),
          consumedAt: new Date(),
          failureCode,
        },
      }).catch((error: unknown) => {
        this.logger.warn(`transfer.session outcome=finalize_failed type=${(error as Error).name}`);
      });
    };
    const responseFailure = () => {
      const code = response.locals?.transferFailureCode;
      return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)
        ? code
        : null;
    };
    response.once('finish', () => finalize(
      responseFailure() ?? (response.statusCode >= 400 ? 'SOURCE_FAILED' : null),
    ));
    response.once('close', () => finalize(
      responseFailure() ?? (response.writableFinished ? null : 'CLIENT_ABORTED'),
    ));
    try {
      let resourcePayload: unknown = null;
      if (session.resourcePayloadEnc) {
        try {
          const envelope = decryptWithDomain<{
            sessionId: string;
            sourceKind: string;
            resourceId: string;
            payload: unknown;
          }>('transfers', session.resourcePayloadEnc);
          if (
            envelope.sessionId !== session.id ||
            envelope.sourceKind !== session.sourceKind ||
            envelope.resourceId !== session.resourceId
          ) throw new Error('Generated transfer payload binding mismatch');
          resourcePayload = envelope.payload;
        } catch {
          throw new GoneException('Generated transfer payload is unavailable');
        }
      }
      await source.stream(
        session.resourceId,
        { userId: session.actorUserId, role: session.actorRole },
        response,
        resourcePayload,
      );
      this.logger.log(`transfer.session outcome=started mode=GENERATED_STREAM source=${session.sourceKind}`);
    } catch (error) {
      finalize('SOURCE_FAILED');
      throw error;
    }
  }

  private replayStagedUpload(
    session: PrismaTransferSession,
    secret: string,
    artifactId: string,
    input: IssueStagedUploadInput,
  ): TransferSessionDelivery {
    if (
      session.purpose !== 'UPLOAD' ||
      session.transferMode !== 'STAGED_ARTIFACT' ||
      session.artifactId !== artifactId ||
      session.sourceKind !== input.sourceKind ||
      session.resourceId !== input.resourceId ||
      session.actorUserId !== input.actor.userId ||
      session.actorRole !== input.actor.role ||
      session.contentType !== input.contentType ||
      session.filename !== input.filename ||
      session.contentLength !== BigInt(input.contentLength) ||
      !secureHashMatch(session.secretHash, sha256(secret))
    ) throw new ConflictException('Idempotency key is bound to a different upload');
    if (
      session.expiresAt.getTime() <= Date.now() ||
      session.failureCode || session.completedAt || session.consumedAt
    ) throw new GoneException('Idempotent upload session is no longer writable');
    return this.buildUploadDelivery(session, secret);
  }

  private buildUploadDelivery(
    session: Pick<
      PrismaTransferSession,
      'id' | 'targetInstallationId' | 'sourceKind' | 'resourceId' | 'contentLength' | 'expiresAt'
    >,
    secret: string,
  ): TransferSessionDelivery {
    if (session.contentLength === null || session.contentLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ConflictException('Upload session length is invalid');
    }
    const delivery: TransferSessionDelivery = {
      kind: 'TransferSession',
      purpose: 'UPLOAD',
      targetInstallationId: session.targetInstallationId,
      resource: { kind: session.sourceKind, id: session.resourceId },
      method: 'PUT',
      allowedHeaders: ['content-type'],
      cachePolicy: 'NO_STORE',
      referrerPolicy: 'NO_REFERRER',
      expiresAt: session.expiresAt.toISOString(),
      browserReachabilityRequired: true,
      rangeSupported: false,
      resumeSupported: false,
      fallbackReason: null,
      url: `${this.origins.directTransferOrigin()}/api/public/v1/transfers/${session.id}/upload?secret=${secret}`,
      reusable: false,
      transferMode: 'STAGED_ARTIFACT',
      contentLength: Number(session.contentLength),
      sha256: null,
      leaseId: session.id,
    };
    return validatePublicDelivery(delivery) as TransferSessionDelivery;
  }

  private async finalizeUpload(sessionId: string, completed: CompletedUpload): Promise<void> {
    if (
      !TRANSFER_UUID.test(completed.artifactId) ||
      !Number.isSafeInteger(completed.sizeBytes) || completed.sizeBytes < 0 ||
      !/^[0-9a-f]{64}$/.test(completed.sha256)
    ) throw new ConflictException('Completed upload metadata is invalid');
    const session = await this.prisma.transferSession.findUnique({ where: { id: sessionId } });
    if (
      !session || session.purpose !== 'UPLOAD' ||
      session.artifactId !== completed.artifactId ||
      session.contentLength !== BigInt(completed.sizeBytes)
    ) throw new ConflictException('Completed upload binding mismatch');
    const now = new Date();
    const updated = await this.prisma.transferSession.updateMany({
      where: { id: sessionId, completedAt: null, consumedAt: null },
      data: {
        sha256: completed.sha256,
        completedAt: now,
        consumedAt: now,
        failureCode: null,
      },
    });
    if (updated.count === 1) return;
    const current = await this.prisma.transferSession.findUnique({ where: { id: sessionId } });
    if (
      current?.completedAt && current.consumedAt && !current.failureCode &&
      current.artifactId === completed.artifactId &&
      current.contentLength === BigInt(completed.sizeBytes) &&
      current.sha256 === completed.sha256
    ) return;
    throw new ConflictException('Upload session completion is inconsistent');
  }

  private validateIssue(input: IssueGeneratedStreamInput): void {
    assertTransferResource(input.sourceKind, input.resourceId);
    assertTransferPresentation(input.filename, input.contentType);
    assertTransferActor(input.actor);
    let payloadBytes = 0;
    if (input.resourcePayload !== undefined) {
      try {
        payloadBytes = Buffer.byteLength(JSON.stringify(input.resourcePayload), 'utf8');
      } catch {
        throw new Error('Transfer resource payload is not serializable');
      }
    }
    if (
      !(input.resourceExpiresAt instanceof Date) ||
      !Number.isFinite(input.resourceExpiresAt.getTime()) ||
      payloadBytes > 16 * 1024 ||
      !this.sources.has(input.sourceKind)
    ) throw new Error('Transfer session request is invalid');
  }

  private async assertAdmission(actorUserId: string, targetInstallationId: string, now: Date): Promise<void> {
    const oneMinuteAgo = new Date(now.getTime() - 60_000);
    const activeWhere = { expiresAt: { gt: now }, completedAt: null } as const;
    const [recent, actorActive, targetActive] = await Promise.all([
      this.prisma.transferSession.count({
        where: { actorUserId, createdAt: { gte: oneMinuteAgo } },
      }),
      this.prisma.transferSession.count({ where: { actorUserId, ...activeWhere } }),
      this.prisma.transferSession.count({ where: { targetInstallationId, ...activeWhere } }),
    ]);
    if (recent >= this.maxNewPerMinute) throw new ConflictException('Transfer creation rate exceeded');
    if (actorActive >= this.maxActivePerActor) throw new ConflictException('Actor transfer limit exceeded');
    if (targetActive >= this.maxActivePerTarget) throw new ConflictException('Target transfer limit exceeded');
  }

  private async requireSession(id: string, secret: string) {
    if (!SECRET.test(secret)) throw new UnauthorizedException('Transfer session is invalid');
    const session = await this.prisma.transferSession.findUnique({ where: { id } });
    if (!session || !secureHashMatch(session.secretHash, sha256(secret))) {
      throw new UnauthorizedException('Transfer session is invalid');
    }
    const identity = await this.identity.getLocalIdentity();
    if (session.targetInstallationId !== identity.installationId) {
      throw new UnauthorizedException('Transfer target mismatch');
    }
    if (
      session.expiresAt.getTime() <= Date.now() ||
      session.consumedAt ||
      (session.transferMode === 'GENERATED_STREAM' && session.completedAt)
    ) {
      throw new GoneException('Transfer session expired or was consumed');
    }
    return session;
  }

  private toStagedSession(session: PrismaTransferSession): StagedTransferSession {
    if (
      session.transferMode !== 'STAGED_ARTIFACT' ||
      !session.artifactId || session.contentLength === null ||
      !session.sha256 || !/^[0-9a-f]{64}$/.test(session.sha256)
    ) throw new ConflictException('Staged transfer metadata is incomplete');
    return {
      id: session.id,
      targetInstallationId: session.targetInstallationId,
      artifactId: session.artifactId,
      sourceKind: session.sourceKind,
      resourceId: session.resourceId,
      actorUserId: session.actorUserId,
      actorRole: session.actorRole,
      contentType: session.contentType,
      filename: session.filename,
      contentLength: session.contentLength,
      sha256: session.sha256,
      expiresAt: session.expiresAt,
    };
  }

  private toStagedUploadSession(session: PrismaTransferSession): StagedUploadSession {
    if (
      session.purpose !== 'UPLOAD' ||
      session.transferMode !== 'STAGED_ARTIFACT' ||
      !session.artifactId || session.contentLength === null || session.contentLength < 0n
    ) throw new ConflictException('Staged upload metadata is incomplete');
    return {
      id: session.id,
      targetInstallationId: session.targetInstallationId,
      artifactId: session.artifactId,
      sourceKind: session.sourceKind,
      resourceId: session.resourceId,
      actorUserId: session.actorUserId,
      actorRole: session.actorRole,
      contentType: session.contentType,
      filename: session.filename,
      contentLength: session.contentLength,
      expiresAt: session.expiresAt,
    };
  }

  private setResponseHeaders(response: Response, contentType: string, filename: string): void {
    setTransferCorsHeaders(response);
    response.setHeader('Content-Type', contentType);
    response.setHeader('Content-Disposition', attachmentDisposition(filename));
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }

  private async cleanupExpired(): Promise<void> {
    const cutoff = new Date(Date.now() - SESSION_RETENTION_MS);
    try {
      const deleted = await this.prisma.transferSession.deleteMany({
        where: { expiresAt: { lt: cutoff } },
      });
      if (deleted.count > 0) this.logger.log(`transfer.session outcome=cleanup count=${deleted.count}`);
    } catch (error) {
      this.logger.warn(`transfer.session outcome=cleanup_failed type=${(error as Error).name}`);
    }
  }
}
