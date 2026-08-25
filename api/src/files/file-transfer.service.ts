import {
  BadRequestException,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { safeErrorMessage, type TransferSessionDelivery } from '@meowbox/shared';
import { createHash } from 'node:crypto';
import type { Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { OperationAdmissionService } from '../operations/operation-admission.service';
import {
  OperationFailedError,
  OperationNeedsAttentionError,
} from '../operations/operation-errors';
import {
  type OperationExecutionContext,
  OperationsWorkerService,
} from '../operations/operations-worker.service';
import { TransferArtifactService } from '../transfers/transfer-artifact.service';
import { TransferSessionService } from '../transfers/transfer-session.service';
import { FilesService, type InstallUploadedFileInput } from './files.service';

const FILE_DOWNLOAD_SOURCE = 'SITE_FILE';
const FILE_UPLOAD_SOURCE = 'SITE_FILE_UPLOAD';
const FILE_UPLOAD_ACTION = 'file.upload.commit';
const FILE_TRANSFER_TTL_MS = 4 * 60 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

interface FileDownloadPayload {
  siteId: string;
  domainId: string;
  path: string;
}

interface FileUploadRequest {
  siteId: string;
  domainId: string;
  uploadSessionId: string;
  artifactId: string;
  artifactPath: string;
  targetDir: string;
  filename: string;
  expectedSize: number;
  expectedSha256: string;
}

function positiveInt(config: ConfigService, key: string, fallback: number): number {
  const value = Number(config.get(key, fallback));
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

@Injectable()
export class FileTransferService implements OnModuleInit, OnModuleDestroy {
  private readonly idleTimeoutMs: number;
  private unregisterSource: (() => void) | null = null;
  private unregisterHandler: (() => void) | null = null;

  constructor(
    config: ConfigService,
    private readonly files: FilesService,
    private readonly transfers: TransferSessionService,
    private readonly artifacts: TransferArtifactService,
    private readonly admission: OperationAdmissionService,
    private readonly worker: OperationsWorkerService,
  ) {
    this.idleTimeoutMs = positiveInt(config, 'TRANSFER_GENERATED_STREAM_IDLE_MS', 60_000);
  }

  onModuleInit(): void {
    this.unregisterSource = this.transfers.registerGeneratedSource(FILE_DOWNLOAD_SOURCE, {
      stream: (resourceId, actor, response, payload) => this.streamDownload(
        resourceId,
        actor,
        response,
        payload,
      ),
    });
    this.unregisterHandler = this.worker.registerHandler(
      FILE_UPLOAD_ACTION,
      (request, context) => this.executeUpload(request, context),
    );
  }

  onModuleDestroy(): void {
    this.unregisterSource?.();
    this.unregisterSource = null;
    this.unregisterHandler?.();
    this.unregisterHandler = null;
  }

  async issueDownload(
    siteId: string,
    domainId: string,
    relativePath: string,
    actor: { userId: string; role: string },
  ): Promise<TransferSessionDelivery> {
    const file = await this.files.inspectDownloadFile(
      siteId,
      domainId,
      actor.userId,
      actor.role,
      relativePath,
    );
    return this.transfers.issueGeneratedStream({
      sourceKind: FILE_DOWNLOAD_SOURCE,
      resourceId: domainId,
      actor,
      filename: file.filename,
      contentType: 'application/octet-stream',
      resourceExpiresAt: new Date(Date.now() + FILE_TRANSFER_TTL_MS),
      resourcePayload: { siteId, domainId, path: relativePath } satisfies FileDownloadPayload,
    });
  }

  async issueUpload(
    siteId: string,
    domainId: string,
    input: { targetDir: string; filename: string; contentLength: number },
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ): Promise<TransferSessionDelivery> {
    if (!Number.isSafeInteger(input.contentLength) || input.contentLength <= 0) {
      throw new BadRequestException('Upload file must have a positive length');
    }
    const target = await this.files.assertUploadTarget(
      siteId,
      domainId,
      actor.userId,
      actor.role,
      input.targetDir,
      input.filename,
    );
    return this.transfers.issueStagedUpload({
      sourceKind: FILE_UPLOAD_SOURCE,
      resourceId: domainId,
      actor,
      filename: target.filename,
      contentType: 'application/octet-stream',
      contentLength: input.contentLength,
      resourceExpiresAt: new Date(Date.now() + FILE_TRANSFER_TTL_MS),
      idempotencyKey: idempotencyKey ?? '',
    });
  }

  async enqueueUploadCommit(
    siteId: string,
    domainId: string,
    uploadSessionId: string,
    targetDir: string,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    if (!UUID.test(uploadSessionId)) throw new BadRequestException('Upload session is invalid');
    const uploaded = await this.artifacts.requireUploadedArtifact({
      sessionId: uploadSessionId,
      sourceKind: FILE_UPLOAD_SOURCE,
      resourceId: domainId,
      actorUserId: actor.userId,
    });
    const target = await this.files.assertUploadTarget(
      siteId,
      domainId,
      actor.userId,
      actor.role,
      targetDir,
      uploaded.filename,
    );
    const lockHash = createHash('sha256')
      .update(`${siteId}\0${domainId}\0${targetDir}\0${target.filename}`)
      .digest('hex')
      .slice(0, 32);
    return this.admission.admit({
      actionId: FILE_UPLOAD_ACTION,
      type: 'FILE_UPLOAD_COMMIT',
      idempotencyKey,
      actor,
      request: {
        siteId,
        domainId,
        uploadSessionId,
        artifactId: uploaded.artifactId,
        artifactPath: uploaded.path,
        targetDir,
        filename: target.filename,
        expectedSize: uploaded.sizeBytes,
        expectedSha256: uploaded.sha256,
      } satisfies FileUploadRequest,
      deadlineMs: 24 * 60 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      globalLockKey: `file-upload:${lockHash}`,
      siteId,
      siteDomainId: domainId,
      lockSite: false,
    });
  }

  private async streamDownload(
    resourceId: string,
    actor: { userId: string; role: string },
    response: Response,
    rawPayload: unknown,
  ): Promise<void> {
    const payload = this.parseDownloadPayload(rawPayload);
    if (payload.domainId !== resourceId) {
      throw new BadRequestException('File transfer resource binding mismatch');
    }
    const file = await this.files.openDownloadFile(
      payload.siteId,
      payload.domainId,
      actor.userId,
      actor.role,
      payload.path,
    );
    response.setHeader('Content-Length', String(file.size));
    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        response.locals.transferFailureCode = 'IDLE_TIMEOUT';
        file.stream.destroy(new Error('Generated stream idle timeout'));
        if (!response.destroyed) response.destroy(new Error('Generated stream idle timeout'));
      }, this.idleTimeoutMs);
      idleTimer.unref();
    };
    const clearIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    };
    resetIdle();
    file.stream.on('data', resetIdle);
    file.stream.once('close', clearIdle);
    file.stream.once('error', clearIdle);
    response.once('close', clearIdle);
    await pipeline(file.stream, response);
  }

  private async executeUpload(
    rawRequest: unknown,
    context: OperationExecutionContext,
  ): Promise<{ siteId: string; domainId: string; filename: string }> {
    const request = this.parseUploadRequest(rawRequest);
    const install: InstallUploadedFileInput = {
      siteId: request.siteId,
      domainId: request.domainId,
      userId: context.actor.userId,
      role: context.actor.role,
      targetDir: request.targetDir,
      filename: request.filename,
      sourcePath: request.artifactPath,
      expectedSize: request.expectedSize,
      expectedSha256: request.expectedSha256,
      operationId: context.operationId,
    };
    let state;
    try {
      state = await this.files.inspectUploadedFile(install);
    } catch (error) {
      throw new OperationNeedsAttentionError(
        `${safeErrorMessage(error, 'File upload postcondition could not be inspected')}; ` +
        'reconcile the target file before retrying',
      );
    }
    if (state.matches) {
      await this.finishCommittedUpload(request, install, context);
      return { siteId: request.siteId, domainId: request.domainId, filename: request.filename };
    }
    if (context.recovering) {
      if (state.temporaryExists) {
        await this.files.removeUploadTemporaryFile(install);
        throw new OperationFailedError('File upload stopped before atomic commit');
      }
      throw new OperationNeedsAttentionError(
        'File upload outcome is unknown; reconcile the target file before retrying',
      );
    }

    const uploaded = await this.artifacts.requireUploadedArtifact({
      sessionId: request.uploadSessionId,
      sourceKind: FILE_UPLOAD_SOURCE,
      resourceId: request.domainId,
      actorUserId: context.actor.userId,
    });
    if (
      uploaded.artifactId !== request.artifactId ||
      uploaded.path !== request.artifactPath ||
      uploaded.filename !== request.filename ||
      uploaded.sizeBytes !== request.expectedSize ||
      uploaded.sha256 !== request.expectedSha256
    ) {
      throw new OperationNeedsAttentionError('Uploaded artifact binding changed before commit');
    }

    await context.throwIfCancellationRequested();
    await context.heartbeat('install', 20);
    try {
      await this.files.installUploadedFile(install);
    } catch (error) {
      try {
        state = await this.files.inspectUploadedFile(install);
      } catch (inspectionError) {
        throw new OperationNeedsAttentionError(
          `${safeErrorMessage(error, 'File upload commit failed')}; ` +
          `postcondition inspection failed: ${safeErrorMessage(inspectionError)}`,
        );
      }
      if (!state.matches) {
        throw new OperationFailedError(safeErrorMessage(error, 'File upload failed before commit'));
      }
    }
    await context.heartbeat('finalize', 90);
    await this.finishCommittedUpload(request, install, context);
    return { siteId: request.siteId, domainId: request.domainId, filename: request.filename };
  }

  private async finishCommittedUpload(
    request: FileUploadRequest,
    install: InstallUploadedFileInput,
    context: OperationExecutionContext,
  ): Promise<void> {
    try {
      const state = await this.files.inspectUploadedFile(install);
      if (!state.matches) {
        throw new Error('Target file checksum does not match uploaded artifact');
      }
      await this.files.ensureUploadedFileOwnership(
        request.siteId,
        request.domainId,
        context.actor.userId,
        context.actor.role,
        state.targetPath,
      );
      await this.artifacts.revoke({
        artifactId: request.artifactId,
        sourceKind: FILE_UPLOAD_SOURCE,
        resourceId: request.domainId,
        createdByUserId: context.actor.userId,
      });
    } catch (error) {
      throw new OperationNeedsAttentionError(
        `${safeErrorMessage(error, 'File was committed but finalization failed')}; ` +
        'reconcile ownership and staged artifact cleanup',
      );
    }
  }

  private parseDownloadPayload(value: unknown): FileDownloadPayload {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('File transfer payload is invalid');
    }
    const payload = value as Record<string, unknown>;
    if (
      Object.keys(payload).sort().join('\0') !== 'domainId\0path\0siteId' ||
      typeof payload.siteId !== 'string' || !UUID.test(payload.siteId) ||
      typeof payload.domainId !== 'string' || !UUID.test(payload.domainId) ||
      typeof payload.path !== 'string' || !payload.path || payload.path.length > 4096 ||
      payload.path.includes('\0')
    ) throw new BadRequestException('File transfer payload is invalid');
    return payload as unknown as FileDownloadPayload;
  }

  private parseUploadRequest(value: unknown): FileUploadRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new OperationNeedsAttentionError('File upload request is invalid');
    }
    const request = value as Record<string, unknown>;
    if (
      Object.keys(request).sort().join('\0') !==
        'artifactId\0artifactPath\0domainId\0expectedSha256\0expectedSize\0filename\0siteId\0targetDir\0uploadSessionId' ||
      typeof request.siteId !== 'string' || !UUID.test(request.siteId) ||
      typeof request.domainId !== 'string' || !UUID.test(request.domainId) ||
      typeof request.uploadSessionId !== 'string' || !UUID.test(request.uploadSessionId) ||
      typeof request.artifactId !== 'string' || !UUID.test(request.artifactId) ||
      typeof request.artifactPath !== 'string' || !request.artifactPath.startsWith('/') ||
      typeof request.targetDir !== 'string' || !request.targetDir || request.targetDir.length > 4096 ||
      request.targetDir.includes('\0') ||
      typeof request.filename !== 'string' || !request.filename || request.filename.length > 255 ||
      typeof request.expectedSize !== 'number' || !Number.isSafeInteger(request.expectedSize) ||
      request.expectedSize <= 0 ||
      typeof request.expectedSha256 !== 'string' || !SHA256.test(request.expectedSha256)
    ) throw new OperationNeedsAttentionError('File upload request is invalid');
    return request as unknown as FileUploadRequest;
  }
}
