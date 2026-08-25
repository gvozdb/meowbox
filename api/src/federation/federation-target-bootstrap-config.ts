import { ConfigService } from '@nestjs/config';
import {
  chmod,
  lstat,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { parseFederationOrigin } from './endpoint-normalizer';
import { validateFederationSocketPath } from './federation-local-endpoint.service';
import { LegacyRegistryFileService } from './legacy-registry-file.service';
import { parseLegacyRegistry } from './legacy-registry';

export interface FederationTargetEndpointConfig {
  apiOrigin: string;
  wsOrigin: string;
  wsPath: string;
  browserPublicOrigin: string;
  directTransferOrigin: string;
}

const MAX_ENV_BYTES = 1024 * 1024;

function managedValues(endpoints: FederationTargetEndpointConfig): Readonly<Record<string, string>> {
  const api = parseFederationOrigin(endpoints.apiOrigin);
  const ws = parseFederationOrigin(endpoints.wsOrigin);
  const browser = parseFederationOrigin(endpoints.browserPublicOrigin);
  const transfer = parseFederationOrigin(endpoints.directTransferOrigin);
  if (
    api.origin !== ws.origin ||
    api.origin !== browser.origin ||
    api.origin !== transfer.origin
  ) throw new Error('Protocol 1 requires one canonical public target origin');
  return {
    MEOWBOX_INSTALLATION_ROLE: 'TARGET',
    FEDERATION_API_ORIGIN: api.origin,
    FEDERATION_WS_ORIGIN: ws.origin,
    FEDERATION_WS_PATH: validateFederationSocketPath(endpoints.wsPath),
    FEDERATION_BROWSER_PUBLIC_ORIGIN: browser.origin,
    FEDERATION_DIRECT_TRANSFER_ORIGIN: transfer.origin,
  };
}

export function patchFederationTargetEnv(
  content: string,
  endpoints: FederationTargetEndpointConfig,
): string {
  if (Buffer.byteLength(content, 'utf8') > MAX_ENV_BYTES || content.includes('\0')) {
    throw new Error('Target env is invalid');
  }
  const values = managedValues(endpoints);
  const lines = content.split('\n');
  const seen = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    for (const [key, value] of Object.entries(values)) {
      if (!new RegExp(`^[ \\t]*${key}[ \\t]*=`).test(lines[index])) continue;
      if (seen.has(key)) throw new Error(`Target env contains duplicate ${key}`);
      seen.add(key);
      lines[index] = `${key}=${value}`;
    }
  }
  const missing = Object.entries(values).filter(([key]) => !seen.has(key));
  let next = lines.join('\n').replace(/\s*$/, '');
  if (missing.length > 0) {
    next = [
      next,
      '',
      '# Federation target configuration (managed by enrollment)',
      ...missing.map(([key, value]) => `${key}=${value}`),
    ].filter((line, index) => index > 0 || line.length > 0).join('\n');
  }
  return `${next}\n`;
}

function targetPaths(config: ConfigService): Readonly<{ envFile: string; panelRoot: string }> {
  const stateDir = String(config.get('MEOWBOX_STATE_DIR', '')).trim();
  const dataDir = String(config.get('MEOWBOX_DATA_DIR', '')).trim();
  const envFile = stateDir
    ? path.resolve(stateDir, '.env')
    : dataDir
      ? path.resolve(dataDir, '..', '.env')
      : '';
  const panelRoot = stateDir
    ? path.dirname(path.resolve(stateDir))
    : dataDir
      ? path.dirname(path.resolve(dataDir))
      : '';
  if (!envFile || !panelRoot || envFile === path.parse(envFile).root || panelRoot === path.parse(panelRoot).root) {
    throw new Error('Target env path is unavailable');
  }
  return { envFile, panelRoot };
}

async function writeAtomicEnv(envFile: string, content: string): Promise<void> {
  const current = await lstat(envFile);
  if (!current.isFile() || current.isSymbolicLink() || current.size > MAX_ENV_BYTES) {
    throw new Error('Target env must be a bounded regular file');
  }
  const temporary = path.join(path.dirname(envFile), `.${path.basename(envFile)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.chown(current.uid, current.gid);
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, envFile);
    await chmod(envFile, 0o600);
    const directory = await open(path.dirname(envFile), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function legacyRegistryCount(config: ConfigService): Promise<number> {
  const registry = new LegacyRegistryFileService(config);
  try {
    return parseLegacyRegistry(await registry.read()).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

export async function prepareFederationTargetConfiguration(
  prisma: PrismaService,
  config: ConfigService,
  endpoints: FederationTargetEndpointConfig,
): Promise<Readonly<{ changed: boolean; envFile: string }>> {
  const { envFile, panelRoot } = targetPaths(config);
  const devMode = await lstat(path.join(panelRoot, '.dev-mode')).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (devMode) throw new Error('Target conversion is disabled in dev mode');
  const original = await readFile(envFile, 'utf8');
  const next = patchFederationTargetEnv(original, endpoints);
  const [identity, remoteServers, controlEnrollments, legacyServers] = await Promise.all([
    prisma.panelIdentity.findUnique({ where: { id: '_' } }),
    prisma.remoteServer.count(),
    prisma.federationEnrollment.count({
      where: { enrollmentRole: 'CONTROL_PLANE', state: { not: 'CANCELLED' } },
    }),
    legacyRegistryCount(config),
  ]);
  if (
    (identity && identity.installationRole !== 'MASTER' && identity.installationRole !== 'TARGET') ||
    remoteServers > 0 ||
    controlEnrollments > 0 ||
    legacyServers > 0
  ) throw new Error('Target conversion is blocked by control-plane state');

  const envChanged = next !== original;
  if (envChanged) await writeAtomicEnv(envFile, next);
  let roleChanged = false;
  try {
    if (identity?.installationRole === 'MASTER') {
      const updated = await prisma.panelIdentity.updateMany({
        where: { id: '_', installationRole: 'MASTER' },
        data: { installationRole: 'TARGET' },
      });
      if (updated.count !== 1) throw new Error('Target role changed concurrently');
      roleChanged = true;
    }
  } catch (error) {
    if (envChanged) await writeAtomicEnv(envFile, original).catch(() => undefined);
    throw error;
  }

  const values = managedValues(endpoints);
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  return { changed: envChanged || roleChanged, envFile };
}
