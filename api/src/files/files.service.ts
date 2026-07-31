import {
  Injectable,
  ForbiddenException,
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { constants as fsConstants } from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { DomainContextService } from '../sites/domain-context.service';

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

    let handle: fsPromises.FileHandle;
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
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    if (
      !originalName ||
      originalName === '.' ||
      originalName === '..' ||
      originalName.includes('\0') ||
      originalName.includes('/') ||
      originalName.includes('\\')
    ) {
      throw new ForbiddenException('Invalid filename');
    }

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
