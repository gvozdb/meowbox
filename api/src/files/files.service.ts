import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';

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
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
  ) {}

  async listFiles(siteId: string, userId: string, role: string, dirPath: string) {
    const site = await this.getSiteOrFail(siteId, userId, role);

    const result = await this.agentRelay.emitToAgent<FileItem[]>('file:list', {
      rootPath: site.rootPath,
      path: dirPath || '/',
    });

    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Failed to list files');
    }

    return result.data;
  }

  async readFile(siteId: string, userId: string, role: string, filePath: string) {
    const site = await this.getSiteOrFail(siteId, userId, role);

    const result = await this.agentRelay.emitToAgent<string>('file:read', {
      rootPath: site.rootPath,
      path: filePath,
    });

    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Failed to read file');
    }

    return result.data;
  }

  async writeFile(siteId: string, userId: string, role: string, filePath: string, content: string) {
    const site = await this.getSiteOrFail(siteId, userId, role);

    const result = await this.agentRelay.emitToAgent('file:write', {
      rootPath: site.rootPath,
      path: filePath,
      content,
    });

    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Failed to write file');
    }
  }

  async createItem(siteId: string, userId: string, role: string, itemPath: string, type: 'file' | 'directory') {
    const site = await this.getSiteOrFail(siteId, userId, role);

    const result = await this.agentRelay.emitToAgent('file:create', {
      rootPath: site.rootPath,
      path: itemPath,
      type,
    });

    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Failed to create item');
    }
  }

  async deleteItem(siteId: string, userId: string, role: string, itemPath: string) {
    const site = await this.getSiteOrFail(siteId, userId, role);

    const result = await this.agentRelay.emitToAgent('file:delete', {
      rootPath: site.rootPath,
      path: itemPath,
    });

    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Failed to delete item');
    }
  }

  async renameItem(siteId: string, userId: string, role: string, oldPath: string, newPath: string) {
    const site = await this.getSiteOrFail(siteId, userId, role);

    const result = await this.agentRelay.emitToAgent('file:rename', {
      rootPath: site.rootPath,
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
  async resolveFilePath(siteId: string, userId: string, role: string, relativePath: string): Promise<string> {
    const site = await this.getSiteOrFail(siteId, userId, role);

    if (!relativePath) {
      throw new BadRequestException('Path is required');
    }

    const root = path.resolve(site.rootPath);
    const resolved = path.resolve(root, relativePath.replace(/^\/+/, ''));

    // Prevent directory traversal
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new ForbiddenException('Invalid path');
    }

    return resolved;
  }

  /**
   * Upload a file to the site's directory.
   * Writes the file directly to disk and fixes ownership via agent.
   */
  async uploadFile(
    siteId: string,
    userId: string,
    role: string,
    targetDir: string,
    file: Express.Multer.File,
  ) {
    const site = await this.getSiteOrFail(siteId, userId, role);

    const root = path.resolve(site.rootPath);
    const dir = path.resolve(root, targetDir.replace(/^\/+/, ''));

    // Prevent directory traversal
    if (!dir.startsWith(root + path.sep) && dir !== root) {
      throw new ForbiddenException('Invalid path');
    }

    // Multer parses Content-Disposition filename as latin1; decode back to UTF-8
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const targetPath = path.join(dir, originalName);

    // Ensure target stays within root
    if (!targetPath.startsWith(root + path.sep)) {
      throw new ForbiddenException('Invalid filename');
    }

    try {
      // Ensure directory exists
      await fsPromises.mkdir(dir, { recursive: true });
      // Write file
      await fsPromises.writeFile(targetPath, file.buffer);
    } catch (err) {
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

  private async getSiteOrFail(siteId: string, userId: string, role: string) {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { id: true, rootPath: true, userId: true, systemUser: true },
    });

    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    return site;
  }
}
