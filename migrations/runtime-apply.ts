#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import {
  parseHookArguments,
  requiredAbsolutePath,
} from './hooks/cli';
import { safeErrorMessage } from './release/redaction';
import {
  loadRuntimeManifest,
  type RuntimeArtifact,
  type ValidatedRuntimeManifest,
} from './runtime-manifest';

const execFileAsync = promisify(execFile);
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const PHP_TARGET_RE = /^\/etc\/php\/(\d+\.\d+)\/fpm\/pool\.d\/[A-Za-z0-9._-]+\.conf$/;

interface RemovedArtifact {
  readonly target: string;
  readonly content: Buffer;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
}

async function execute(command: string, args: readonly string[], timeout = 30_000): Promise<void> {
  await execFileAsync(command, [...args], {
    timeout,
    maxBuffer: 512 * 1024,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
  });
}

async function assertCommittedArtifacts(runtime: ValidatedRuntimeManifest): Promise<void> {
  for (const artifact of runtime.manifest.artifacts) {
    if (artifact.action === 'delete') continue;
    const metadata = await fs.lstat(artifact.target).catch(() => null);
    if (!metadata?.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`committed runtime artifact is missing or unsafe: ${artifact.target}`);
    }
    const content = await fs.readFile(artifact.target);
    const digest = createHash('sha256').update(content).digest('hex');
    if (digest !== artifact.sha256) {
      throw new Error(`committed runtime artifact checksum mismatch: ${artifact.target}`);
    }
  }
}

function touchedPhpServices(artifacts: readonly RuntimeArtifact[]): string[] {
  const services = new Set<string>();
  for (const artifact of artifacts) {
    const match = artifact.target.match(PHP_TARGET_RE);
    if (match) services.add(`php${match[1]}-fpm`);
  }
  return [...services].sort();
}

function touchesNginx(artifacts: readonly RuntimeArtifact[]): boolean {
  return artifacts.some((artifact) => artifact.target.startsWith('/etc/nginx/'));
}

async function reloadServices(services: readonly string[]): Promise<void> {
  for (const service of services) {
    await execute('systemctl', ['reload-or-restart', service], 60_000);
    await execute('systemctl', ['is-active', '--quiet', service]);
  }
}

async function reloadNginx(): Promise<void> {
  await execute('nginx', ['-t']);
  await execute('systemctl', ['reload', 'nginx'], 60_000);
  await execute('systemctl', ['is-active', '--quiet', 'nginx']);
}

async function waitForSockets(sockets: readonly string[], timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(sockets);
  while (pending.size > 0 && Date.now() < deadline) {
    for (const socket of pending) {
      const metadata = await fs.stat(socket).catch(() => null);
      if (metadata?.isSocket()) pending.delete(socket);
    }
    if (pending.size > 0) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (pending.size > 0) {
    throw new Error(`PHP-FPM sockets did not become ready: ${[...pending].join(', ')}`);
  }
}

async function atomicRestore(removed: RemovedArtifact): Promise<void> {
  await fs.mkdir(path.dirname(removed.target), { recursive: true });
  const temporary = `${removed.target}.meowbox-restore-${process.pid}-${randomUUID()}`;
  try {
    const handle = await fs.open(temporary, 'wx', removed.mode);
    try {
      await handle.writeFile(removed.content);
      await handle.sync();
      await handle.chmod(removed.mode);
      await handle.chown(removed.uid, removed.gid);
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, removed.target);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function removeDeferredArtifacts(runtime: ValidatedRuntimeManifest): Promise<RemovedArtifact[]> {
  const removed: RemovedArtifact[] = [];
  for (const artifact of runtime.manifest.artifacts) {
    if (artifact.action !== 'delete' || artifact.postCommitOnly !== true) continue;
    const metadata = await fs.lstat(artifact.target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!metadata) continue;
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`deferred cleanup target is not a regular managed file: ${artifact.target}`);
    }
    if (metadata.size > MAX_CONFIG_BYTES) {
      throw new Error(`deferred cleanup target is too large: ${artifact.target}`);
    }
    const snapshot: RemovedArtifact = {
      target: artifact.target,
      content: await fs.readFile(artifact.target),
      mode: metadata.mode & 0o7777,
      uid: metadata.uid,
      gid: metadata.gid,
    };
    await fs.unlink(artifact.target);
    removed.push(snapshot);
  }
  return removed;
}

async function restoreRemoved(removed: readonly RemovedArtifact[]): Promise<void> {
  for (const artifact of [...removed].reverse()) {
    await atomicRestore(artifact);
  }
}

async function switchRuntime(runtime: ValidatedRuntimeManifest): Promise<void> {
  await assertCommittedArtifacts(runtime);
  const writes = runtime.manifest.artifacts.filter((artifact) => artifact.action !== 'delete');
  const phpServices = touchedPhpServices(writes);
  if (phpServices.length > 0) await reloadServices(phpServices);
  await waitForSockets(runtime.manifest.socketPaths ?? []);
  if (touchesNginx(writes)) await reloadNginx();
}

async function cleanupRuntime(runtime: ValidatedRuntimeManifest): Promise<void> {
  const deletes = runtime.manifest.artifacts.filter(
    (artifact) => artifact.action === 'delete' && artifact.postCommitOnly === true,
  );
  if (deletes.length === 0) return;
  const phpServices = touchedPhpServices(deletes);
  const nginxChanged = touchesNginx(deletes);
  const removed = await removeDeferredArtifacts(runtime);
  try {
    if (phpServices.length > 0) await reloadServices(phpServices);
    await waitForSockets(runtime.manifest.socketPaths ?? []);
    if (nginxChanged) await reloadNginx();
  } catch (error) {
    await restoreRemoved(removed);
    try {
      if (phpServices.length > 0) await reloadServices(phpServices);
      if (nginxChanged) await reloadNginx();
    } catch {
      // Preserve the original failure; the retained release snapshot remains
      // the operator recovery authority after the commit boundary.
    }
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const arguments_ = parseHookArguments(argv, true);
    requiredAbsolutePath(arguments_, 'db');
    const stageRoot = requiredAbsolutePath(arguments_, 'stage');
    const manifestPath = requiredAbsolutePath(arguments_, 'manifest');
    const runtime = await loadRuntimeManifest(manifestPath, stageRoot);
    if (arguments_.command === 'switch') await switchRuntime(runtime);
    else if (arguments_.command === 'cleanup') await cleanupRuntime(runtime);
    else throw new Error('runtime apply command must be switch or cleanup');
    process.stdout.write(`[runtime-apply] ${arguments_.command} complete\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`[runtime-apply] ${safeErrorMessage(error)}\n`);
    return 1;
  }
}

if (require.main === module) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
