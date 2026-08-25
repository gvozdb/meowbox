import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TransferSessionDelivery } from '@meowbox/shared';
import { constants as fsConstants } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Response } from 'express';
import { TransferSessionService } from '../transfers/transfer-session.service';
import { BackupsService } from './backups.service';

const BACKUP_FILE_SOURCE = 'BACKUP_FILE';
const BACKUP_TRANSFER_TTL_MS = 4 * 60 * 60_000;

function positiveInt(config: ConfigService, key: string, fallback: number): number {
  const value = Number(config.get(key, fallback));
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

@Injectable()
export class BackupTransferService implements OnModuleInit, OnModuleDestroy {
  private readonly idleTimeoutMs: number;
  private unregisterSource: (() => void) | null = null;

  constructor(
    config: ConfigService,
    private readonly backups: BackupsService,
    private readonly transfers: TransferSessionService,
  ) {
    this.idleTimeoutMs = positiveInt(config, 'TRANSFER_GENERATED_STREAM_IDLE_MS', 60_000);
  }

  onModuleInit(): void {
    this.unregisterSource = this.transfers.registerGeneratedSource(BACKUP_FILE_SOURCE, {
      stream: (backupId, actor, response) => this.streamBackup(
        backupId,
        actor.userId,
        actor.role,
        response,
      ),
    });
  }

  onModuleDestroy(): void {
    this.unregisterSource?.();
    this.unregisterSource = null;
  }

  async issueDelivery(
    backupId: string,
    actor: { userId: string; role: string },
  ): Promise<TransferSessionDelivery> {
    const backup = await this.backups.getBackupForDownload(
      backupId,
      actor.userId,
      actor.role,
    );
    const file = await this.openBackupFile(backup.filePath);
    try {
      return await this.transfers.issueGeneratedStream({
        sourceKind: BACKUP_FILE_SOURCE,
        resourceId: backup.id,
        actor,
        filename: file.filename,
        contentType: 'application/octet-stream',
        resourceExpiresAt: new Date(Date.now() + BACKUP_TRANSFER_TTL_MS),
      });
    } finally {
      await file.handle.close().catch(() => undefined);
    }
  }

  private async streamBackup(
    backupId: string,
    userId: string,
    role: string,
    response: Response,
  ): Promise<void> {
    const backup = await this.backups.getBackupForDownload(backupId, userId, role);
    const file = await this.openBackupFile(backup.filePath);
    response.setHeader('Content-Length', String(file.size));
    const stream = file.handle.createReadStream({ autoClose: true });
    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        response.locals.transferFailureCode = 'IDLE_TIMEOUT';
        stream.destroy(new Error('Generated stream idle timeout'));
        if (!response.destroyed) response.destroy(new Error('Generated stream idle timeout'));
      }, this.idleTimeoutMs);
      idleTimer.unref();
    };
    const clearIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    };
    resetIdle();
    stream.on('data', resetIdle);
    stream.once('close', clearIdle);
    stream.once('error', clearIdle);
    response.once('close', clearIdle);
    await pipeline(stream, response);
  }

  private async openBackupFile(filePath: string): Promise<{
    filename: string;
    size: number;
    handle: fsPromises.FileHandle;
  }> {
    if (!filePath || !path.isAbsolute(filePath) || filePath.includes('\0')) {
      throw new NotFoundException(
        'Файл бэкапа не найден на диске. Возможно, он хранится только в облаке.',
      );
    }
    let handle: fsPromises.FileHandle | null = null;
    try {
      handle = await fsPromises.open(
        filePath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      const state = await handle.stat();
      if (!state.isFile() || !Number.isSafeInteger(state.size)) {
        throw new BadRequestException('Backup path is not a regular file');
      }
      return { filename: path.basename(filePath), size: state.size, handle };
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if (error instanceof BadRequestException) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(String(code))) {
        throw new NotFoundException(
          'Файл бэкапа не найден на диске. Возможно, он хранится только в облаке.',
        );
      }
      throw error;
    }
  }
}
