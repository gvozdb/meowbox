import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface Pm2ProcessDescription {
  readonly name: string;
  readonly status: string;
  readonly cwd: string | null;
  readonly executable: string | null;
}

export interface ReleaseHealthPayload {
  readonly databaseReadable: boolean;
  readonly agentConnected: boolean;
  readonly maintenanceActive: boolean;
  readonly counts: {
    readonly sites: number;
    readonly siteDomains: number;
    readonly activeOperations: number;
  };
  readonly representativeDomain: {
    readonly id: string;
    readonly siteId: string;
    readonly preset: string;
    readonly appStatus: string;
    readonly runtimeKey: string;
    readonly filesRelPath: string;
  } | null;
}

interface Pm2JsonItem {
  readonly name?: unknown;
  readonly pm2_env?: {
    readonly status?: unknown;
    readonly pm_cwd?: unknown;
    readonly pm_exec_path?: unknown;
  };
}

export async function readPm2Process(name: string): Promise<Pm2ProcessDescription> {
  const result = await execFileAsync('pm2', ['jlist'], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
  });
  const decoded = JSON.parse(result.stdout) as unknown;
  if (!Array.isArray(decoded)) throw new Error('pm2 jlist returned an invalid process list');
  const item = (decoded as Pm2JsonItem[]).find((candidate) => candidate.name === name);
  if (!item || typeof item.name !== 'string' || typeof item.pm2_env?.status !== 'string') {
    throw new Error(`PM2 process is missing: ${name}`);
  }
  return {
    name: item.name,
    status: item.pm2_env.status,
    cwd: typeof item.pm2_env.pm_cwd === 'string' ? item.pm2_env.pm_cwd : null,
    executable: typeof item.pm2_env.pm_exec_path === 'string' ? item.pm2_env.pm_exec_path : null,
  };
}

async function stateEnvPath(database: string): Promise<string> {
  const canonical = await fs.realpath(database);
  const dataDirectory = path.dirname(canonical);
  const stateDirectory = path.basename(dataDirectory) === 'data'
    ? path.dirname(dataDirectory)
    : dataDirectory;
  return path.join(stateDirectory, '.env');
}

async function apiPort(database: string): Promise<number> {
  const configured = process.env.API_PORT?.trim();
  let value = configured;
  if (!value) {
    const envFile = await stateEnvPath(database);
    const content = await fs.readFile(envFile, 'utf8').catch(() => '');
    value = content
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*API_PORT\s*=\s*["']?(\d+)["']?\s*$/)?.[1])
      .find((candidate): candidate is string => !!candidate);
  }
  const parsed = Number(value || '11860');
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error('API_PORT is invalid');
  }
  return parsed;
}

async function requestReleaseHealth(port: number): Promise<ReleaseHealthPayload> {
  return new Promise<ReleaseHealthPayload>((resolve, reject) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port,
      path: '/api/health/release',
      timeout: 3000,
      headers: { accept: 'application/json' },
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer | string) => {
        const encoded = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += encoded.byteLength;
        if (size > 256 * 1024) {
          request.destroy(new Error('release health response is too large'));
          return;
        }
        chunks.push(encoded);
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`release health endpoint returned HTTP ${response.statusCode ?? 0}`));
          return;
        }
        try {
          const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            success?: unknown;
            data?: unknown;
          };
          if (envelope.success !== true || !envelope.data || typeof envelope.data !== 'object') {
            throw new Error('release health response envelope is invalid');
          }
          resolve(envelope.data as ReleaseHealthPayload);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once('timeout', () => request.destroy(new Error('release health request timed out')));
    request.once('error', reject);
  });
}

function assertReleaseHealth(payload: ReleaseHealthPayload): void {
  if (
    payload.databaseReadable !== true
    || typeof payload.agentConnected !== 'boolean'
    || typeof payload.maintenanceActive !== 'boolean'
    || !payload.counts
    || !Number.isInteger(payload.counts.sites)
    || !Number.isInteger(payload.counts.siteDomains)
    || !Number.isInteger(payload.counts.activeOperations)
    || payload.counts.sites < 0
    || payload.counts.siteDomains < 0
    || payload.counts.activeOperations < 0
  ) {
    throw new Error('release health response data is invalid');
  }
  if (payload.counts.siteDomains > 0) {
    const domain = payload.representativeDomain;
    if (
      !domain
      || !domain.id
      || !domain.siteId
      || !domain.preset
      || !domain.appStatus
      || !domain.runtimeKey
      || !domain.filesRelPath
    ) {
      throw new Error('release health representative SiteDomain is incomplete');
    }
  }
}

export async function fetchReleaseHealth(database: string, timeoutMs = 30_000): Promise<ReleaseHealthPayload> {
  const port = await apiPort(database);
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = new Error('release health endpoint is unavailable');
  while (Date.now() < deadline) {
    try {
      const payload = await requestReleaseHealth(port);
      assertReleaseHealth(payload);
      return payload;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

export async function assertPathInsideRelease(candidate: string | null, releaseDirectory: string, label: string): Promise<void> {
  if (!candidate) throw new Error(`${label} is missing from PM2 metadata`);
  const release = await fs.realpath(releaseDirectory);
  const resolved = await fs.realpath(candidate);
  if (resolved !== release && !resolved.startsWith(`${release}${path.sep}`)) {
    throw new Error(`${label} does not resolve inside the candidate release`);
  }
}
