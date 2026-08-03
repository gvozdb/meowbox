import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

async function assertNoSymlinkPathComponents(destination: string): Promise<void> {
  const absolute = path.resolve(destination);
  const parsed = path.parse(absolute);
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const component of components) {
    current = path.join(current, component);
    try {
      const metadata = await fs.lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Refusing managed write through symlink path component: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

/** Durable atomic write for allowlisted managed files. */
export async function atomicWriteManagedFile(
  destination: string,
  content: string | Buffer,
  mode?: number,
  ownership?: { uid: number; gid: number },
): Promise<void> {
  await assertNoSymlinkPathComponents(destination);
  const destinationMetadata = await fs.lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (destinationMetadata?.isSymbolicLink()) {
    throw new Error(`Refusing to write managed file through symlink: ${destination}`);
  }
  if (destinationMetadata && !destinationMetadata.isFile()) {
    throw new Error(`Refusing to replace non-file managed target: ${destination}`);
  }

  const directoryPath = path.dirname(destination);
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await assertNoSymlinkPathComponents(destination);
  const existing = await fs.stat(destination).catch(() => null);
  const finalMode = mode ?? (existing ? existing.mode & 0o7777 : undefined);
  const temporary = path.join(
    directoryPath,
    `.${path.basename(destination)}.meowbox-managed-${process.pid}-${randomUUID()}`,
  );
  try {
    const handle = await fs.open(temporary, 'wx', finalMode);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (ownership) await fs.chown(temporary, ownership.uid, ownership.gid);
    else if (existing) await fs.chown(temporary, existing.uid, existing.gid);
    if (finalMode !== undefined) await fs.chmod(temporary, finalMode);
    await fs.rename(temporary, destination);
    const directory = await fs.open(directoryPath, 'r').catch(() => null);
    if (directory) {
      try {
        await directory.sync().catch(() => undefined);
      } finally {
        await directory.close();
      }
    }
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}
