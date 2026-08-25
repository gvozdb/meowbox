import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

function registryPath(config: ConfigService): string {
  const stateDir = String(config.get('MEOWBOX_STATE_DIR', '')).trim();
  if (stateDir) return resolve(stateDir, 'data', 'servers.json');
  const dataDir = String(config.get('MEOWBOX_DATA_DIR', '')).trim();
  if (dataDir) return resolve(dataDir, 'servers.json');
  return resolve(join(process.cwd(), '..', 'data', 'servers.json'));
}

@Injectable()
export class LegacyRegistryFileService {
  readonly path: string;

  constructor(config: ConfigService) {
    this.path = registryPath(config);
  }

  async read(): Promise<string> {
    return readFile(this.path, 'utf8');
  }

  async writeMode600(content: string): Promise<void> {
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    try {
      const current = await lstat(this.path);
      if (current.isSymbolicLink() || !current.isFile()) {
        throw new Error('Legacy registry target is not a regular file');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.chmod(0o600);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await handle.close();
    try {
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
      const directory = await open(parent, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

