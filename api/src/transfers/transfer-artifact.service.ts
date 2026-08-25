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
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TransferArtifact, TransferSession } from '@prisma/client';
import type { Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  type ReadStream,
} from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  statfs,
  unlink,
} from 'node:fs/promises';
import * as path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { attachmentDisposition } from '../common/http/content-disposition';
import { PrismaService } from '../common/prisma.service';
import { PanelIdentityService } from '../federation/panel-identity.service';
import {
  type CompletedUpload,
  type StagedDeliveryHandler,
  type StagedTransferSession,
  type StagedUploadSession,
  TransferSessionService,
} from './transfer-session.service';
import { setTransferCorsHeaders } from './transfer-http';
import {
  assertTransferActor,
  assertTransferPresentation,
  assertTransferResource,
  type TransferActor,
  TRANSFER_UUID,
} from './transfer-validation';

const GIB = 1024 ** 3;
const DEFAULT_MAX_ARTIFACT_BYTES = 50 * GIB;
const DEFAULT_DISK_RESERVE_BYTES = 10 * GIB;
const DEFAULT_DISK_RESERVE_PERCENT = 10;
const STAGING_STALE_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const ARTIFACT_FILE = /^[0-9a-f-]{36}\.artifact$/i;

export interface StageArtifactInput {
  sourceKind: string;
  resourceId: string;
  actor: TransferActor;
  filename: string;
  contentType: string;
  expiresAt: Date;
  expectedMaxBytes: number;
  source: Readable;
  onArtifactCreated?(artifactId: string): Promise<void>;
  onProgress?(sizeBytes: number): Promise<void>;
}

export interface StagedArtifactResult {
  artifactId: string;
  sizeBytes: number;
  sha256: string;
  expiresAt: string;
}

export interface RevokeArtifactInput {
  artifactId: string;
  sourceKind: string;
  resourceId: string;
  createdByUserId: string;
}

export interface UploadedArtifactInput {
  sessionId: string;
  sourceKind: string;
  resourceId: string;
  actorUserId: string;
}

export interface UploadedArtifactResult extends CompletedUpload {
  path: string;
  filename: string;
  contentType: string;
  expiresAt: Date;
}

interface ByteRange {
  start: number;
  end: number;
}

function positiveInt(config: ConfigService, key: string, fallback: number): number {
  const value = Number(config.get(key, fallback));
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function boundedPercent(config: ConfigService, key: string, fallback: number): number {
  const value = Number(config.get(key, fallback));
  return Number.isInteger(value) && value >= 0 && value <= 90 ? value : fallback;
}

function parseSingleRange(header: string, length: number): ByteRange {
  if (!Number.isSafeInteger(length) || length < 0 || !/^bytes=[^,]+$/.test(header)) {
    throw new HttpException('Invalid or multiple Range header', HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || length === 0) {
    throw new HttpException('Range is not satisfiable', HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE);
  }
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      throw new HttpException('Range is not satisfiable', HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE);
    }
    start = Math.max(0, length - suffix);
    end = length - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : length - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= length) {
      throw new HttpException('Range is not satisfiable', HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE);
    }
    end = Math.min(end, length - 1);
  }
  return { start, end };
}

@Injectable()
export class TransferArtifactService implements OnModuleInit, OnModuleDestroy, StagedDeliveryHandler {
  private readonly logger = new Logger(TransferArtifactService.name);
  private readonly spoolRoot: string;
  private readonly artifactsRoot: string;
  private readonly tmpRoot: string;
  private readonly maxArtifactBytes: number;
  private readonly diskReserveBytes: number;
  private readonly diskReservePercent: number;
  private unregisterHandler: (() => void) | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly identity: PanelIdentityService,
    private readonly sessions: TransferSessionService,
  ) {
    const configuredState = String(config.get(
      'MEOWBOX_STATE_DIR',
      process.env.MEOWBOX_STATE_DIR || '/opt/meowbox/state',
    )).trim();
    const stateRoot = path.resolve(configuredState || '/opt/meowbox/state');
    this.spoolRoot = path.join(stateRoot, 'data', 'transfers');
    this.artifactsRoot = path.join(this.spoolRoot, 'artifacts');
    this.tmpRoot = path.join(this.spoolRoot, 'tmp');
    this.maxArtifactBytes = positiveInt(config, 'TRANSFER_MAX_ARTIFACT_BYTES', DEFAULT_MAX_ARTIFACT_BYTES);
    this.diskReserveBytes = positiveInt(config, 'TRANSFER_DISK_RESERVE_BYTES', DEFAULT_DISK_RESERVE_BYTES);
    this.diskReservePercent = boundedPercent(config, 'TRANSFER_DISK_RESERVE_PERCENT', DEFAULT_DISK_RESERVE_PERCENT);
  }

  async onModuleInit(): Promise<void> {
    this.unregisterHandler = this.sessions.registerStagedDeliveryHandler(this);
    await this.initialize();
    this.cleanupTimer = setInterval(() => {
      void this.reconcileAndCleanup().catch((error: unknown) => {
        this.logger.warn(`transfer.artifact outcome=cleanup_failed type=${(error as Error).name}`);
      });
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    this.unregisterHandler?.();
    this.unregisterHandler = null;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  async stage(input: StageArtifactInput): Promise<StagedArtifactResult> {
    this.validateStage(input);
    await this.ensureDirectories();
    await this.assertDiskAdmission(input.expectedMaxBytes);
    const localIdentity = await this.identity.getLocalIdentity();
    const id = randomUUID();
    const relativePath = `${id}.artifact`;
    const finalPath = this.artifactPath(relativePath);
    const temporaryPath = path.join(this.tmpRoot, `${id}.partial`);
    await this.prisma.transferArtifact.create({
      data: {
        id,
        targetInstallationId: localIdentity.installationId,
        sourceKind: input.sourceKind,
        resourceId: input.resourceId,
        state: 'STAGING',
        relativePath,
        contentType: input.contentType,
        filename: input.filename,
        createdByUserId: input.actor.userId,
        expiresAt: input.expiresAt,
      },
    });

    let syncHandle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      await input.onArtifactCreated?.(id);
      const digest = createHash('sha256');
      let sizeBytes = 0;
      let reportedBytes = 0;
      let reportedAt = Date.now();
      const meter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          sizeBytes += chunk.length;
          if (sizeBytes > input.expectedMaxBytes || sizeBytes > this.maxArtifactBytes) {
            callback(new Error('Transfer artifact exceeded declared size budget'));
            return;
          }
          digest.update(chunk);
          const now = Date.now();
          const shouldReport = input.onProgress && (
            sizeBytes - reportedBytes >= 8 * 1024 * 1024 ||
            now - reportedAt >= 5_000
          );
          if (!shouldReport) {
            callback(null, chunk);
            return;
          }
          reportedBytes = sizeBytes;
          reportedAt = now;
          void input.onProgress!(sizeBytes).then(
            () => callback(null, chunk),
            (error: unknown) => callback(error as Error),
          );
        },
      });
      const output = createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 });
      await pipeline(input.source, meter, output);
      syncHandle = await open(temporaryPath, 'r+');
      await syncHandle.sync();
      await syncHandle.close();
      syncHandle = null;
      await rename(temporaryPath, finalPath);
      await chmod(finalPath, 0o600);
      const directory = await open(this.artifactsRoot, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      const checksum = digest.digest('hex');
      await this.prisma.transferArtifact.update({
        where: { id },
        data: {
          state: 'READY',
          sizeBytes: BigInt(sizeBytes),
          sha256: checksum,
          readyAt: new Date(),
        },
      });
      this.logger.log(`transfer.artifact outcome=ready source=${input.sourceKind} bytes=${sizeBytes}`);
      return { artifactId: id, sizeBytes, sha256: checksum, expiresAt: input.expiresAt.toISOString() };
    } catch (error) {
      if (syncHandle) await syncHandle.close().catch(() => undefined);
      await Promise.all([
        this.unlinkIfExists(temporaryPath),
        this.unlinkIfExists(finalPath),
      ]);
      await this.prisma.transferArtifact.updateMany({
        where: { id, state: 'STAGING' },
        data: { state: 'FAILED', deletedAt: new Date() },
      }).catch(() => undefined);
      throw error;
    }
  }

  async prepareUploadAdmission(expectedBytes: number): Promise<void> {
    if (
      !Number.isSafeInteger(expectedBytes) || expectedBytes < 0 ||
      expectedBytes > this.maxArtifactBytes
    ) throw new HttpException('Upload exceeds the artifact size limit', HttpStatus.PAYLOAD_TOO_LARGE);
    await this.ensureDirectories();
    await this.assertDiskAdmission(expectedBytes);
  }

  async upload(session: StagedUploadSession, source: Readable): Promise<CompletedUpload> {
    this.validateUploadSession(session);
    await this.ensureDirectories();
    const artifact = await this.prisma.transferArtifact.findUnique({ where: { id: session.artifactId } });
    if (!artifact) throw new NotFoundException('Transfer artifact not found');
    this.assertUploadArtifactMatchesSession(artifact, session, 'STAGING');

    const finalPath = this.artifactPath(artifact.relativePath);
    const temporaryPath = path.join(this.tmpRoot, `${artifact.id}.partial`);
    let syncHandle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      const digest = createHash('sha256');
      let sizeBytes = 0;
      const expectedBytes = Number(session.contentLength);
      const meter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          sizeBytes += chunk.length;
          if (sizeBytes > expectedBytes || sizeBytes > this.maxArtifactBytes) {
            callback(new HttpException('Upload exceeded the declared length', HttpStatus.PAYLOAD_TOO_LARGE));
            return;
          }
          digest.update(chunk);
          callback(null, chunk);
        },
      });
      const output = createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 });
      await pipeline(source, meter, output);
      if (sizeBytes !== expectedBytes) {
        throw new HttpException('Upload ended before the declared length', HttpStatus.BAD_REQUEST);
      }
      syncHandle = await open(temporaryPath, 'r+');
      await syncHandle.sync();
      await syncHandle.close();
      syncHandle = null;
      await rename(temporaryPath, finalPath);
      await chmod(finalPath, 0o600);
      const directory = await open(this.artifactsRoot, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      const checksum = digest.digest('hex');
      const updated = await this.prisma.transferArtifact.updateMany({
        where: { id: artifact.id, state: 'STAGING', deletedAt: null },
        data: {
          state: 'READY',
          sizeBytes: BigInt(sizeBytes),
          sha256: checksum,
          readyAt: new Date(),
        },
      });
      if (updated.count !== 1) throw new ConflictException('Transfer artifact state changed during upload');
      this.logger.log(`transfer.artifact outcome=ready source=${session.sourceKind} bytes=${sizeBytes}`);
      return { artifactId: artifact.id, sizeBytes, sha256: checksum };
    } catch (error) {
      if (syncHandle) await syncHandle.close().catch(() => undefined);
      await Promise.all([
        this.unlinkIfExists(temporaryPath),
        this.unlinkIfExists(finalPath),
      ]);
      await this.prisma.transferArtifact.updateMany({
        where: { id: artifact.id, state: 'STAGING' },
        data: { state: 'FAILED', deletedAt: new Date() },
      }).catch(() => undefined);
      throw error;
    }
  }

  async reconcileUpload(session: StagedUploadSession): Promise<CompletedUpload | null> {
    this.validateUploadSession(session);
    const artifact = await this.prisma.transferArtifact.findUnique({ where: { id: session.artifactId } });
    if (!artifact) throw new NotFoundException('Transfer artifact not found');
    if (artifact.state === 'STAGING' && !artifact.deletedAt) return null;
    this.assertUploadArtifactMatchesSession(artifact, session, 'READY');
    const file = this.artifactPath(artifact.relativePath);
    const fileState = await lstat(file).catch(() => null);
    if (
      !fileState || !fileState.isFile() || fileState.isSymbolicLink() ||
      artifact.sizeBytes === null || BigInt(fileState.size) !== artifact.sizeBytes ||
      !artifact.sha256 || !/^[0-9a-f]{64}$/.test(artifact.sha256)
    ) throw new GoneException('Uploaded artifact file is unavailable');
    return {
      artifactId: artifact.id,
      sizeBytes: Number(artifact.sizeBytes),
      sha256: artifact.sha256,
    };
  }

  async requireUploadedArtifact(input: UploadedArtifactInput): Promise<UploadedArtifactResult> {
    assertTransferResource(input.sourceKind, input.resourceId);
    if (!TRANSFER_UUID.test(input.sessionId) || !TRANSFER_UUID.test(input.actorUserId)) {
      throw new Error('Uploaded artifact request is invalid');
    }
    const session = await this.prisma.transferSession.findUnique({
      where: { id: input.sessionId },
    });
    if (
      !session || session.purpose !== 'UPLOAD' || session.transferMode !== 'STAGED_ARTIFACT' ||
      session.sourceKind !== input.sourceKind || session.resourceId !== input.resourceId ||
      session.actorUserId !== input.actorUserId || !session.artifactId ||
      !session.completedAt || !session.consumedAt || session.failureCode ||
      session.contentLength === null || !session.sha256
    ) throw new ConflictException('Uploaded artifact session is not ready');
    const uploadSession = this.toUploadSession(session);
    const artifact = await this.prisma.transferArtifact.findUnique({
      where: { id: uploadSession.artifactId },
    });
    if (!artifact) throw new NotFoundException('Uploaded artifact not found');
    this.assertUploadArtifactMatchesSession(artifact, uploadSession, 'READY');
    if (
      artifact.expiresAt.getTime() <= Date.now() ||
      artifact.sizeBytes === null || artifact.sizeBytes !== session.contentLength ||
      !artifact.sha256 || artifact.sha256 !== session.sha256 ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256)
    ) throw new GoneException('Uploaded artifact is expired or incomplete');
    const file = this.artifactPath(artifact.relativePath);
    const fileState = await lstat(file).catch(() => null);
    if (
      !fileState || !fileState.isFile() || fileState.isSymbolicLink() ||
      BigInt(fileState.size) !== artifact.sizeBytes
    ) throw new GoneException('Uploaded artifact file is unavailable');
    return {
      artifactId: artifact.id,
      sizeBytes: Number(artifact.sizeBytes),
      sha256: artifact.sha256,
      path: file,
      filename: artifact.filename,
      contentType: artifact.contentType,
      expiresAt: artifact.expiresAt,
    };
  }

  async revoke(input: RevokeArtifactInput): Promise<void> {
    assertTransferResource(input.sourceKind, input.resourceId);
    if (!TRANSFER_UUID.test(input.artifactId) || !TRANSFER_UUID.test(input.createdByUserId)) {
      throw new Error('Transfer artifact revocation request is invalid');
    }
    const artifact = await this.prisma.transferArtifact.findUnique({
      where: { id: input.artifactId },
    });
    if (!artifact || artifact.deletedAt) return;
    if (
      artifact.sourceKind !== input.sourceKind ||
      artifact.resourceId !== input.resourceId ||
      artifact.createdByUserId !== input.createdByUserId
    ) {
      throw new ConflictException('Transfer artifact revocation binding mismatch');
    }
    const now = new Date();
    await this.prisma.transferSession.updateMany({
      where: { artifactId: artifact.id, expiresAt: { gt: now } },
      data: { expiresAt: now, failureCode: 'ARTIFACT_REVOKED' },
    });
    await Promise.all([
      this.unlinkIfExists(path.join(this.tmpRoot, `${artifact.id}.partial`)),
      this.unlinkIfExists(this.artifactPath(artifact.relativePath)),
    ]);
    await this.prisma.transferArtifact.updateMany({
      where: { id: artifact.id, deletedAt: null },
      data: { state: 'DELETED', deletedAt: now },
    });
  }

  async head(session: StagedTransferSession, response: Response): Promise<void> {
    await this.requireArtifact(session);
    this.setHeaders(session, response);
    response.setHeader('Content-Length', String(session.contentLength));
  }

  async download(
    session: StagedTransferSession,
    rangeHeader: string | undefined,
    ifRangeHeader: string | undefined,
    response: Response,
  ): Promise<void> {
    const file = await this.requireArtifact(session);
    const length = Number(session.contentLength);
    const etag = this.etag(session.sha256);
    let effectiveRange: ByteRange | null = null;
    if (rangeHeader && (!ifRangeHeader || ifRangeHeader.trim() === etag)) {
      try {
        effectiveRange = parseSingleRange(rangeHeader.trim(), length);
      } catch (error) {
        response.setHeader('Content-Range', `bytes */${length}`);
        throw error;
      }
    }
    this.setHeaders(session, response);
    let stream: ReadStream;
    if (effectiveRange) {
      const rangeLength = effectiveRange.end - effectiveRange.start + 1;
      response.statusCode = HttpStatus.PARTIAL_CONTENT;
      response.setHeader('Content-Range', `bytes ${effectiveRange.start}-${effectiveRange.end}/${length}`);
      response.setHeader('Content-Length', String(rangeLength));
      stream = createReadStream(file, { start: effectiveRange.start, end: effectiveRange.end });
    } else {
      response.setHeader('Content-Length', String(length));
      stream = createReadStream(file);
    }
    await pipeline(stream, response);
  }

  async cleanupExpired(): Promise<void> {
    const now = new Date();
    const artifacts = await this.prisma.transferArtifact.findMany({
      where: {
        state: { in: ['READY', 'FAILED'] },
        expiresAt: { lte: now },
        deletedAt: null,
      },
      orderBy: { expiresAt: 'asc' },
      take: 100,
    });
    for (const artifact of artifacts) {
      const activeSessions = await this.prisma.transferSession.count({
        where: { artifactId: artifact.id, expiresAt: { gt: now } },
      });
      if (activeSessions > 0) continue;
      await this.unlinkIfExists(this.artifactPath(artifact.relativePath));
      await this.prisma.transferArtifact.updateMany({
        where: { id: artifact.id, deletedAt: null },
        data: { state: 'DELETED', deletedAt: now },
      });
    }
  }

  private async initialize(): Promise<void> {
    await this.ensureDirectories();
    await this.reconcileAndCleanup();
  }

  private async reconcileAndCleanup(): Promise<void> {
    const stale = await this.prisma.transferArtifact.findMany({
      where: { state: 'STAGING', createdAt: { lt: new Date(Date.now() - STAGING_STALE_MS) } },
      take: 100,
    });
    for (const artifact of stale) {
      const failedAt = new Date();
      await Promise.all([
        this.unlinkIfExists(path.join(this.tmpRoot, `${artifact.id}.partial`)),
        this.unlinkIfExists(this.artifactPath(artifact.relativePath)),
      ]);
      await this.prisma.transferArtifact.updateMany({
        where: { id: artifact.id, state: 'STAGING' },
        data: { state: 'FAILED', deletedAt: failedAt },
      });
      await this.prisma.transferSession.updateMany({
        where: {
          artifactId: artifact.id,
          purpose: 'UPLOAD',
          completedAt: null,
        },
        data: {
          completedAt: failedAt,
          consumedAt: failedAt,
          failureCode: 'UPLOAD_STALE',
        },
      });
    }
    await this.cleanupExpired();
  }

  private validateStage(input: StageArtifactInput): void {
    assertTransferResource(input.sourceKind, input.resourceId);
    assertTransferPresentation(input.filename, input.contentType);
    assertTransferActor(input.actor);
    if (
      !(input.source instanceof Readable) ||
      !(input.expiresAt instanceof Date) || !Number.isFinite(input.expiresAt.getTime()) ||
      input.expiresAt.getTime() <= Date.now() + 1_000 ||
      !Number.isSafeInteger(input.expectedMaxBytes) || input.expectedMaxBytes < 0 ||
      input.expectedMaxBytes > this.maxArtifactBytes
    ) throw new Error('Transfer artifact request is invalid');
  }

  private validateUploadSession(session: StagedUploadSession): void {
    assertTransferResource(session.sourceKind, session.resourceId);
    assertTransferPresentation(session.filename, session.contentType);
    assertTransferActor({ userId: session.actorUserId, role: session.actorRole });
    if (
      !TRANSFER_UUID.test(session.id) || !TRANSFER_UUID.test(session.targetInstallationId) ||
      !TRANSFER_UUID.test(session.artifactId) ||
      session.contentLength < 0n ||
      session.contentLength > BigInt(this.maxArtifactBytes) ||
      session.contentLength > BigInt(Number.MAX_SAFE_INTEGER) ||
      !(session.expiresAt instanceof Date) || !Number.isFinite(session.expiresAt.getTime()) ||
      session.expiresAt.getTime() <= Date.now()
    ) throw new GoneException('Staged upload session is invalid or expired');
  }

  private assertUploadArtifactMatchesSession(
    artifact: TransferArtifact,
    session: StagedUploadSession,
    expectedState: 'STAGING' | 'READY',
  ): void {
    if (
      artifact.state !== expectedState || artifact.deletedAt ||
      artifact.targetInstallationId !== session.targetInstallationId ||
      artifact.sourceKind !== session.sourceKind || artifact.resourceId !== session.resourceId ||
      artifact.contentType !== session.contentType || artifact.filename !== session.filename ||
      artifact.createdByUserId !== session.actorUserId ||
      (expectedState === 'READY' && artifact.sizeBytes !== session.contentLength)
    ) throw new ConflictException('Upload artifact metadata mismatch');
  }

  private toUploadSession(session: TransferSession): StagedUploadSession {
    if (
      session.purpose !== 'UPLOAD' || session.transferMode !== 'STAGED_ARTIFACT' ||
      !session.artifactId || session.contentLength === null
    ) throw new ConflictException('Uploaded artifact session metadata is incomplete');
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

  private async ensureDirectories(): Promise<void> {
    await mkdir(this.artifactsRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.tmpRoot, { recursive: true, mode: 0o700 });
    await chmod(this.spoolRoot, 0o700);
    await chmod(this.artifactsRoot, 0o700);
    await chmod(this.tmpRoot, 0o700);
  }

  private async unlinkIfExists(file: string): Promise<void> {
    try {
      await unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async assertDiskAdmission(expectedBytes: number): Promise<void> {
    const disk = await statfs(this.spoolRoot);
    const blockSize = BigInt(disk.bsize);
    const free = BigInt(disk.bavail) * blockSize;
    const total = BigInt(disk.blocks) * blockSize;
    const percentageReserve = total * BigInt(this.diskReservePercent) / 100n;
    const reserve = percentageReserve > BigInt(this.diskReserveBytes)
      ? percentageReserve
      : BigInt(this.diskReserveBytes);
    if (free <= reserve + BigInt(expectedBytes)) {
      throw new HttpException('Transfer staging disk reserve would be violated', 507);
    }
  }

  private async requireArtifact(session: StagedTransferSession): Promise<string> {
    if (session.expiresAt.getTime() <= Date.now()) throw new GoneException('Transfer lease expired');
    const artifact = await this.prisma.transferArtifact.findUnique({ where: { id: session.artifactId } });
    if (!artifact) throw new NotFoundException('Transfer artifact not found');
    this.assertArtifactMatchesSession(artifact, session);
    const file = this.artifactPath(artifact.relativePath);
    const fileState = await lstat(file).catch(() => null);
    if (!fileState || !fileState.isFile() || fileState.isSymbolicLink() || BigInt(fileState.size) !== session.contentLength) {
      await this.prisma.transferArtifact.updateMany({
        where: { id: artifact.id, state: 'READY' },
        data: { state: 'FAILED' },
      });
      throw new GoneException('Transfer artifact file is unavailable');
    }
    return file;
  }

  private assertArtifactMatchesSession(artifact: TransferArtifact, session: StagedTransferSession): void {
    if (
      artifact.state !== 'READY' || artifact.deletedAt ||
      artifact.targetInstallationId !== session.targetInstallationId ||
      artifact.sourceKind !== session.sourceKind || artifact.resourceId !== session.resourceId ||
      artifact.contentType !== session.contentType || artifact.filename !== session.filename ||
      artifact.sizeBytes !== session.contentLength || artifact.sha256 !== session.sha256
    ) throw new ConflictException('Transfer artifact metadata mismatch');
  }

  private artifactPath(relativePath: string): string {
    if (!ARTIFACT_FILE.test(relativePath)) throw new Error('Unsafe transfer artifact path');
    const resolved = path.resolve(this.artifactsRoot, relativePath);
    if (path.dirname(resolved) !== this.artifactsRoot) throw new Error('Unsafe transfer artifact path');
    return resolved;
  }

  private setHeaders(session: StagedTransferSession, response: Response): void {
    setTransferCorsHeaders(response);
    response.setHeader('Content-Type', session.contentType);
    response.setHeader('Content-Disposition', attachmentDisposition(session.filename));
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('ETag', this.etag(session.sha256));
  }

  private etag(checksum: string): string {
    return `"sha256-${checksum}"`;
  }
}

export const __transferArtifactTest = { parseSingleRange };
