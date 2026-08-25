import {
  Injectable,
  ForbiddenException,
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { constants as fsConstants, createWriteStream } from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { DomainContextService } from '../sites/domain-context.service';
import { validateUploadFilename } from './file-transfer-validation';

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface InstallUploadedFileInput {
  siteId: string;
  domainId: string;
  userId: string;
  role: string;
  targetDir: string;
  filename: string;
  sourcePath: string;
  expectedSize: number;
  expectedSha256: string;
  operationId: string;
}

export interface UploadedFileState {
  targetPath: string;
  matches: boolean;
  temporaryExists: boolean;
}

export interface FileItem {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  modifiedAt: string;
  permissions: string;
}

@Injectable()
export class FilesService {
  constructor(
    private readonly domainContext: DomainContextService,
    private readonly agentRelay: AgentRelayService,
  ) {}

  async listFiles(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
    dirPath: string,
  ) {
    const { applicationRoot } = await this.domainContext.requireOwnedSiteDomain(
      siteId,
      domainId,
      userId,
      role,
    );

    const result = await this.agentRelay.emitToAgent<FileItem[]>('file:list', {
      rootPath: applicationRoot,
      path: dirPath || '/',
    });

    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Failed to list files');
    }

    return result.data;
  }

  async readFile(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
    filePath: string,
  ) {
    const { applicationRoot } = await this.domainContext.requireOwnedSiteDomain(
      siteId,
      domainId,
      userId,
      role,
    );

    const result = await this.agentRelay.emitToAgent<string>('file:read', {
      rootPath: applicationRoot,
      path: filePath,
    });

    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Failed to read file');
    }

    return result.data;
  }

  async writeFile(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
    filePath: string,
    content: string,
  ) {
    const { applicationRoot } = await this.domainContext.requireOwnedSiteDomain(
      siteId,
      domainId,
      userId,
      role,
    );

    const result = await this.agentRelay.emitToAgent('file:write', {
      rootPath: applicationRoot,
      path: filePath,
      content,
    });

    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Failed to write file');
    }
  }

  async createItem(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
    itemPath: string,
    type: 'file' | 'directory',
  ) {
    const { applicationRoot } = await this.domainContext.requireOwnedSiteDomain(
      siteId,
      domainId,
      userId,
      role,
    );

    const result = await this.agentRelay.emitToAgent('file:create', {
      rootPath: applicationRoot,
      path: itemPath,
      type,
    });

    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Failed to create item');
    }
  }

  async deleteItem(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
    itemPath: string,
  ) {
    const { applicationRoot } = await this.domainContext.requireOwnedSiteDomain(
      siteId,
      domainId,
      userId,
      role,
    );

    const result = await this.agentRelay.emitToAgent('file:delete', {
      rootPath: applicationRoot,
      path: itemPath,
    });

    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Failed to delete item');
    }
  }

  async renameItem(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
    oldPath: string,
    newPath: string,
  ) {
    const { applicationRoot } = await this.domainContext.requireOwnedSiteDomain(
      siteId,
      domainId,
      userId,
      role,
    );

    const result = await this.agentRelay.emitToAgent('file:rename', {
      rootPath: applicationRoot,
      oldPath,
      newPath,
    });

    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Failed to rename item');
    }
  }

  /**
   * Resolve a file path safely within the site's rootPath.
   * Prevents directory traversal attacks.
   */
  async resolveFilePath(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
    relativePath: string,
  ): Promise<string> {
    const { applicationRoot } = await this.domainContext.requireOwnedSiteDomain(
      siteId,
      domainId,
      userId,
      role,
    );

    if (!relativePath) {
      throw new BadRequestException('Path is required');
    }

    const root = path.resolve(applicationRoot);
    const resolved = path.resolve(root, relativePath.replace(/^\/+/, ''));
    this.assertContained(root, resolved, 'Invalid path');

    return this.resolveExistingContainedPath(root, resolved);
  }

  async openDownloadFile(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
    relativePath: string,
  ) {
    const resolved = await this.resolveFilePath(
      siteId,
      domainId,
      userId,
      role,
      relativePath,
    );

    let handle: fsPromises.FileHandle | null = null;
    try {
      handle = await fsPromises.open(
        resolved,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
    } catch (error) {
      this.throwPathError(error);
    }

    let stat;
    try {
      stat = await handle!.stat();
    } catch (error) {
      await handle!.close().catch(() => undefined);
      this.throwPathError(error);
    }
    if (!stat.isFile()) {
      await handle!.close();
      throw new BadRequestException('Невозможно скачать этот тип файла');
    }

    return {
      filename: path.basename(resolved),
      size: stat.size,
      stream: handle!.createReadStream({ autoClose: true }),
    };
  }

  async inspectDownloadFile(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
    relativePath: string,
  ): Promise<{ filename: string; size: number }> {
    const resolved = await this.resolveFilePath(
      siteId,
      domainId,
      userId,
      role,
      relativePath,
    );
    let handle: fsPromises.FileHandle | null = null;
    try {
      handle = await fsPromises.open(
        resolved,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      const state = await handle.stat();
      if (!state.isFile() || !Number.isSafeInteger(state.size)) {
        throw new BadRequestException('Невозможно скачать этот тип файла');
      }
      return { filename: path.basename(resolved), size: state.size };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      return this.throwPathError(error);
    } finally {
      if (handle) await handle.close().catch(() => undefined);
    }
  }

  /**
   * Upload a file to the site's directory.
   * Writes the file directly to disk and fixes ownership via agent.
   */
  async uploadFile(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
    targetDir: string,
    file: Express.Multer.File,
  ) {
    const { site, applicationRoot } =
      await this.domainContext.requireOwnedSiteDomain(
        siteId,
        domainId,
        userId,
        role,
      );

    const root = path.resolve(applicationRoot);
    const dir = path.resolve(root, targetDir.replace(/^\/+/, ''));
    this.assertContained(root, dir, 'Invalid path');

    // Multer parses Content-Disposition filename as latin1; decode back to UTF-8
    const originalName = validateUploadFilename(
      Buffer.from(file.originalname, 'latin1').toString('utf8'),
    );

    const { realRoot, realDirectory } = await this.ensureUploadDirectory(
      root,
      dir,
    );
    const targetPath = path.join(realDirectory, originalName);
    this.assertContained(realRoot, targetPath, 'Invalid filename');
    const temporaryPath = path.join(realDirectory, `.${randomUUID()}.upload`);

    try {
      await fsPromises.writeFile(temporaryPath, file.buffer, {
        flag: 'wx',
        mode: 0o600,
      });
      await fsPromises.rename(temporaryPath, targetPath);
    } catch (err) {
      await fsPromises.unlink(temporaryPath).catch(() => undefined);
      throw new InternalServerErrorException(`Failed to write file: ${(err as Error).message}`);
    }

    // Fix ownership via agent
    if (this.agentRelay.isAgentConnected() && site.systemUser) {
      try {
        await this.agentRelay.emitToAgent('user:set-ownership', {
          username: site.systemUser,
          rootPath: targetPath,
        });
      } catch {
        // Best-effort ownership fix
      }
    }
  }

  async assertUploadTarget(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
    targetDir: string,
    filename: string,
  ): Promise<{ filename: string; targetPath: string }> {
    const resolved = await this.resolveUploadTarget(
      siteId,
      domainId,
      userId,
      role,
      targetDir,
      filename,
    );
    return { filename: resolved.filename, targetPath: resolved.targetPath };
  }

  async inspectUploadedFile(input: InstallUploadedFileInput): Promise<UploadedFileState> {
    this.assertInstallInput(input);
    const resolved = await this.resolveUploadTarget(
      input.siteId,
      input.domainId,
      input.userId,
      input.role,
      input.targetDir,
      input.filename,
    );
    const temporaryPath = this.uploadTemporaryPath(resolved.realDirectory, input.operationId);
    const [target, temporary] = await Promise.all([
      this.hashRegularFile(resolved.targetPath, true),
      fsPromises.lstat(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }),
    ]);
    if (temporary?.isSymbolicLink()) {
      throw new ForbiddenException('Unsafe upload temporary file');
    }
    return {
      targetPath: resolved.targetPath,
      matches: target?.size === input.expectedSize && target.sha256 === input.expectedSha256,
      temporaryExists: temporary !== null,
    };
  }

  async installUploadedFile(input: InstallUploadedFileInput): Promise<string> {
    this.assertInstallInput(input);
    const resolved = await this.resolveUploadTarget(
      input.siteId,
      input.domainId,
      input.userId,
      input.role,
      input.targetDir,
      input.filename,
    );
    const current = await this.hashRegularFile(resolved.targetPath, true);
    if (current?.size === input.expectedSize && current.sha256 === input.expectedSha256) {
      return resolved.targetPath;
    }

    const source = await this.hashRegularFile(input.sourcePath, false);
    if (source.size !== input.expectedSize || source.sha256 !== input.expectedSha256) {
      throw new ConflictException('Uploaded artifact checksum mismatch');
    }

    const existingTarget = await fsPromises.lstat(resolved.targetPath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      },
    );
    if (existingTarget && (!existingTarget.isFile() || existingTarget.isSymbolicLink())) {
      throw new BadRequestException('Upload target is not a regular file');
    }

    const temporaryPath = this.uploadTemporaryPath(resolved.realDirectory, input.operationId);
    const temporary = await fsPromises.lstat(temporaryPath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      },
    );
    if (temporary) {
      throw new ConflictException('Upload temporary file already exists');
    }

    let sourceHandle: fsPromises.FileHandle | null = null;
    let syncHandle: fsPromises.FileHandle | null = null;
    try {
      sourceHandle = await fsPromises.open(
        input.sourcePath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      const digest = createHash('sha256');
      let size = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > input.expectedSize) {
            callback(new Error('Uploaded artifact exceeded expected size'));
            return;
          }
          digest.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        sourceHandle.createReadStream({ autoClose: false }),
        meter,
        createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }),
      );
      if (size !== input.expectedSize || digest.digest('hex') !== input.expectedSha256) {
        throw new ConflictException('Uploaded artifact changed during install');
      }
      syncHandle = await fsPromises.open(temporaryPath, 'r+');
      await syncHandle.sync();
      await syncHandle.close();
      syncHandle = null;
      await fsPromises.rename(temporaryPath, resolved.targetPath);
      const directory = await fsPromises.open(resolved.realDirectory, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return resolved.targetPath;
    } catch (error) {
      await fsPromises.unlink(temporaryPath).catch(() => undefined);
      throw error;
    } finally {
      if (syncHandle) await syncHandle.close().catch(() => undefined);
      if (sourceHandle) await sourceHandle.close().catch(() => undefined);
    }
  }

  async removeUploadTemporaryFile(input: InstallUploadedFileInput): Promise<void> {
    this.assertInstallInput(input);
    const resolved = await this.resolveUploadTarget(
      input.siteId,
      input.domainId,
      input.userId,
      input.role,
      input.targetDir,
      input.filename,
    );
    const temporaryPath = this.uploadTemporaryPath(resolved.realDirectory, input.operationId);
    const state = await fsPromises.lstat(temporaryPath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      },
    );
    if (!state) return;
    if (!state.isFile() || state.isSymbolicLink()) {
      throw new ForbiddenException('Unsafe upload temporary file');
    }
    await fsPromises.unlink(temporaryPath);
  }

  async ensureUploadedFileOwnership(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
    targetPath: string,
  ): Promise<void> {
    const { site, applicationRoot } = await this.domainContext.requireOwnedSiteDomain(
      siteId,
      domainId,
      userId,
      role,
    );
    const root = await fsPromises.realpath(path.resolve(applicationRoot));
    const target = path.resolve(targetPath);
    this.assertContained(root, target, 'Invalid upload target');
    if (!site.systemUser) return;
    const result = await this.agentRelay.emitToAgent('user:set-ownership', {
      username: site.systemUser,
      rootPath: target,
    });
    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Failed to set upload ownership');
    }
  }

  private async resolveExistingContainedPath(
    root: string,
    candidate: string,
  ): Promise<string> {
    try {
      const [realRoot, realCandidate] = await Promise.all([
        fsPromises.realpath(root),
        fsPromises.realpath(candidate),
      ]);
      this.assertContained(realRoot, realCandidate, 'Invalid path');
      return realCandidate;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      this.throwPathError(error);
    }
  }

  private async ensureUploadDirectory(
    root: string,
    candidate: string,
  ): Promise<{ realRoot: string; realDirectory: string }> {
    let realRoot: string;
    try {
      realRoot = await fsPromises.realpath(root);
    } catch (error) {
      this.throwPathError(error);
    }

    const relative = path.relative(root, candidate);
    let current = realRoot!;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      const next = path.join(current, segment);
      try {
        await fsPromises.mkdir(next);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          this.throwPathError(error);
        }
      }

      let realNext: string;
      try {
        realNext = await fsPromises.realpath(next);
        const stat = await fsPromises.stat(realNext);
        if (!stat.isDirectory()) {
          throw new BadRequestException('Upload path is not a directory');
        }
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        this.throwPathError(error);
      }

      this.assertContained(realRoot!, realNext!, 'Invalid path');
      current = realNext!;
    }

    return { realRoot: realRoot!, realDirectory: current };
  }

  private async resolveUploadTarget(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
    targetDir: string,
    filename: string,
  ): Promise<{
    filename: string;
    realRoot: string;
    realDirectory: string;
    targetPath: string;
  }> {
    const { applicationRoot } = await this.domainContext.requireOwnedSiteDomain(
      siteId,
      domainId,
      userId,
      role,
    );
    const safeFilename = validateUploadFilename(filename);
    const root = path.resolve(applicationRoot);
    const directory = path.resolve(root, String(targetDir || '/').replace(/^\/+/, ''));
    this.assertContained(root, directory, 'Invalid path');
    let realRoot: string;
    let realDirectory: string;
    try {
      [realRoot, realDirectory] = await Promise.all([
        fsPromises.realpath(root),
        fsPromises.realpath(directory),
      ]);
      const state = await fsPromises.stat(realDirectory);
      if (!state.isDirectory()) throw new BadRequestException('Upload path is not a directory');
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.throwPathError(error);
    }
    this.assertContained(realRoot!, realDirectory!, 'Invalid path');
    const targetPath = path.join(realDirectory!, safeFilename);
    this.assertContained(realRoot!, targetPath, 'Invalid filename');
    return {
      filename: safeFilename,
      realRoot: realRoot!,
      realDirectory: realDirectory!,
      targetPath,
    };
  }

  private assertInstallInput(input: InstallUploadedFileInput): void {
    if (
      !UUID.test(input.operationId) ||
      !Number.isSafeInteger(input.expectedSize) ||
      input.expectedSize < 0 ||
      !SHA256.test(input.expectedSha256) ||
      typeof input.sourcePath !== 'string' ||
      !path.isAbsolute(input.sourcePath)
    ) {
      throw new BadRequestException('Uploaded file install metadata is invalid');
    }
  }

  private uploadTemporaryPath(directory: string, operationId: string): string {
    if (!UUID.test(operationId)) throw new BadRequestException('Operation ID is invalid');
    return path.join(directory, `.meowbox-upload-${operationId}.partial`);
  }

  private async hashRegularFile(
    file: string,
    allowMissing: true,
  ): Promise<{ size: number; sha256: string } | null>;
  private async hashRegularFile(
    file: string,
    allowMissing: false,
  ): Promise<{ size: number; sha256: string }>;
  private async hashRegularFile(
    file: string,
    allowMissing: boolean,
  ): Promise<{ size: number; sha256: string } | null> {
    let handle: fsPromises.FileHandle;
    try {
      handle = await fsPromises.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      this.throwPathError(error);
    }
    try {
      const state = await handle!.stat();
      if (!state.isFile() || !Number.isSafeInteger(state.size)) {
        throw new BadRequestException('Upload path is not a regular file');
      }
      const digest = createHash('sha256');
      const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
      let position = 0;
      while (position < state.size) {
        const { bytesRead } = await handle!.read(
          buffer,
          0,
          Math.min(buffer.length, state.size - position),
          position,
        );
        if (bytesRead <= 0) throw new ConflictException('File changed while hashing');
        digest.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const finalState = await handle!.stat();
      if (finalState.size !== state.size) throw new ConflictException('File changed while hashing');
      return { size: state.size, sha256: digest.digest('hex') };
    } finally {
      await handle!.close().catch(() => undefined);
    }
  }

  private assertContained(
    root: string,
    candidate: string,
    message: string,
  ): void {
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
      throw new ForbiddenException(message);
    }
  }

  private throwPathError(error: unknown): never {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new NotFoundException('Файл или директория не найдены');
    }
    if (code === 'ELOOP' || code === 'EACCES' || code === 'EPERM') {
      throw new ForbiddenException('Invalid path');
    }
    throw new InternalServerErrorException('Failed to resolve file path');
  }

}
