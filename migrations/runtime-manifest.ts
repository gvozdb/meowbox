/**
 * Release-runtime manifest contract.
 *
 * The updater and the domain-runtime system migration intentionally exchange a
 * small JSON document instead of inferring ownership from arbitrary /etc
 * paths.  The agent-side renderer (owned by the runtime workstream) must
 * produce this document in a staging directory.  This module is deliberately
 * renderer-agnostic: it validates the hand-off, fingerprints it
 * deterministically and applies only allowlisted text configuration files.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { MigrationContext, MigrationPlan } from './system/_types';

export type RuntimeArtifactAction = 'create' | 'replace' | 'delete';

export interface RuntimeArtifact {
  action: RuntimeArtifactAction;
  /** Absolute, allowlisted destination of a generated Meowbox artifact. */
  target: string;
  /** Absolute file under the staging root for create/replace. */
  stagedPath?: string;
  /** SHA-256 of the staged UTF-8 config file. */
  sha256?: string;
  mode?: number;
  uid?: number;
  gid?: number;
  /** Never delete an obsolete pool/config until final release health passes. */
  postCommitOnly?: boolean;
}

export interface RuntimeManifest {
  version: 1;
  /** The renderer sets this after it has inspected the migrated clone. */
  requiresRuntimeCutover: boolean;
  artifacts: RuntimeArtifact[];
  phpServices?: string[];
  socketPaths?: string[];
  httpProbes?: RuntimeHttpProbe[];
  validations?: string[];
}

export interface RuntimeHttpProbe {
  url: string;
  expectedStatus?: number[];
}

export interface ValidatedRuntimeManifest {
  manifest: RuntimeManifest;
  fingerprint: string;
  stageRoot: string;
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const SERVICE_RE = /^php\d+\.\d+-fpm$/;
const SOCKET_RE = /^\/var\/run\/php\/php\d+\.\d+-fpm-[a-z][a-z0-9._-]{0,63}\.sock$/;
// A release owns only generated Site config files, never arbitrary host
// defaults such as /etc/nginx/sites-available/default.  The same grammar is
// used by the shell snapshot/restore boundary.
const NGINX_SITE_CONFIG_RE = /^\/etc\/nginx\/sites-(?:available|enabled)\/[a-z][a-z0-9_-]{0,63}\.conf$/;

/** The only runtime files a release migration may change. */
export function isManagedRuntimePath(value: string): boolean {
  const normalized = path.posix.normalize(value);
  if (normalized !== value || !path.posix.isAbsolute(normalized) || value.includes('\0')) return false;
  return (
    normalized.startsWith('/etc/nginx/meowbox/') ||
    NGINX_SITE_CONFIG_RE.test(normalized) ||
    normalized === '/etc/nginx/conf.d/meowbox-zones.conf' ||
    /^\/etc\/php\/\d+\.\d+\/fpm\/pool\.d\/[a-zA-Z0-9._-]+\.conf$/.test(normalized) ||
    /^\/etc\/logrotate\.d\/meowbox[a-zA-Z0-9._-]*$/.test(normalized)
  );
}

function canonicalManifest(manifest: RuntimeManifest): string {
  const normalized = {
    version: manifest.version,
    requiresRuntimeCutover: manifest.requiresRuntimeCutover,
    artifacts: [...manifest.artifacts]
      .map((artifact) => ({
        action: artifact.action,
        target: artifact.target,
        // A release retry uses a new temporary staging directory.  The path
        // is only a transport location; target + digest bind the actual
        // artifact and keep a durable checkpoint resumable after rollback.
        sha256: artifact.sha256 ?? null,
        mode: artifact.mode ?? null,
        uid: artifact.uid ?? null,
        gid: artifact.gid ?? null,
        postCommitOnly: artifact.postCommitOnly === true,
      }))
      .sort((a, b) => a.target.localeCompare(b.target)),
    phpServices: [...(manifest.phpServices ?? [])].sort(),
    socketPaths: [...(manifest.socketPaths ?? [])].sort(),
    httpProbes: [...(manifest.httpProbes ?? [])]
      .map((probe) => ({ url: probe.url, expectedStatus: [...(probe.expectedStatus ?? [])].sort((a, b) => a - b) }))
      .sort((a, b) => a.url.localeCompare(b.url)),
    validations: [...(manifest.validations ?? [])].sort(),
  };
  return JSON.stringify(normalized);
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function asOptionalNumber(value: unknown, label: string): number | undefined {
  if (value == null) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}

function parseHttpProbes(value: unknown): RuntimeHttpProbe[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('runtime manifest httpProbes must be an array');
  const seen = new Set<string>();
  const probes: RuntimeHttpProbe[] = [];
  for (const [index, rawProbe] of value.entries()) {
    const probe = asObject(rawProbe, `httpProbes[${index}]`);
    const url = asString(probe.url, `httpProbes[${index}].url`);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`httpProbes[${index}].url is invalid`);
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname || parsed.username || parsed.password || /[\u0000-\u001f\u007f]/.test(url)) {
      throw new Error(`httpProbes[${index}].url is unsafe`);
    }
    const rawStatuses = probe.expectedStatus ?? [200, 301, 302];
    if (!Array.isArray(rawStatuses) || rawStatuses.length === 0
      || rawStatuses.some((status) => !Number.isInteger(status) || status < 100 || status > 599)) {
      throw new Error(`httpProbes[${index}].expectedStatus is invalid`);
    }
    const expectedStatus = [...new Set(rawStatuses as number[])].sort((left, right) => left - right);
    const key = `${url}\u0000${expectedStatus.join(',')}`;
    if (seen.has(key)) throw new Error(`duplicate runtime HTTP probe: ${url}`);
    seen.add(key);
    probes.push({ url, expectedStatus });
  }
  return probes.sort((left, right) => left.url.localeCompare(right.url));
}

function parseValidations(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 160)) {
    throw new Error('runtime manifest validations must contain bounded non-empty labels');
  }
  return [...new Set(value as string[])].sort();
}

function parseManifest(raw: unknown): RuntimeManifest {
  const object = asObject(raw, 'runtime manifest');
  if (object.version !== 1) throw new Error('runtime manifest version must equal 1');
  if (typeof object.requiresRuntimeCutover !== 'boolean') {
    throw new Error('runtime manifest requiresRuntimeCutover must be boolean');
  }
  if (!Array.isArray(object.artifacts)) throw new Error('runtime manifest artifacts must be an array');
  const seenTargets = new Set<string>();
  const artifacts = object.artifacts.map((rawArtifact, index): RuntimeArtifact => {
    const artifact = asObject(rawArtifact, `artifacts[${index}]`);
    const action = asString(artifact.action, `artifacts[${index}].action`);
    if (action !== 'create' && action !== 'replace' && action !== 'delete') {
      throw new Error(`artifacts[${index}].action is invalid`);
    }
    const target = asString(artifact.target, `artifacts[${index}].target`);
    if (!isManagedRuntimePath(target)) throw new Error(`artifacts[${index}].target is outside managed runtime paths`);
    if (seenTargets.has(target)) throw new Error(`duplicate runtime artifact target: ${target}`);
    seenTargets.add(target);

    const stagedPath = artifact.stagedPath == null ? undefined : asString(artifact.stagedPath, `artifacts[${index}].stagedPath`);
    const sha256 = artifact.sha256 == null ? undefined : asString(artifact.sha256, `artifacts[${index}].sha256`);
    if (action === 'delete') {
      if (stagedPath || sha256) throw new Error(`delete artifact ${target} cannot have stagedPath/sha256`);
    } else if (!stagedPath || !sha256 || !SHA256_RE.test(sha256)) {
      throw new Error(`write artifact ${target} requires stagedPath and lowercase sha256`);
    }
    const mode = asOptionalNumber(artifact.mode, `artifacts[${index}].mode`);
    if (mode != null && mode > 0o7777) throw new Error(`artifacts[${index}].mode is invalid`);
    const uid = asOptionalNumber(artifact.uid, `artifacts[${index}].uid`);
    const gid = asOptionalNumber(artifact.gid, `artifacts[${index}].gid`);
    if ((uid === undefined) !== (gid === undefined)) {
      throw new Error(`artifacts[${index}] must declare uid and gid together`);
    }
    if (action === 'delete' && (mode !== undefined || uid !== undefined || gid !== undefined)) {
      throw new Error(`delete artifact ${target} cannot declare file metadata`);
    }
    if (action === 'create' && (mode === undefined || uid === undefined || gid === undefined)) {
      throw new Error(`create artifact ${target} requires explicit mode, uid and gid`);
    }
    if (artifact.postCommitOnly != null && typeof artifact.postCommitOnly !== 'boolean') {
      throw new Error(`artifacts[${index}].postCommitOnly must be boolean`);
    }
    if (artifact.postCommitOnly === true && action !== 'delete') {
      throw new Error(`artifacts[${index}].postCommitOnly is allowed only for delete artifacts`);
    }
    return {
      action,
      target,
      stagedPath,
      sha256,
      mode,
      uid,
      gid,
      postCommitOnly: artifact.postCommitOnly === true,
    };
  });
  if (artifacts.length > 0 && object.requiresRuntimeCutover !== true) {
    throw new Error('runtime manifest with artifacts must require a runtime cutover');
  }

  const phpServices = object.phpServices == null ? [] : (() => {
    if (!Array.isArray(object.phpServices) || !object.phpServices.every((value) => typeof value === 'string' && SERVICE_RE.test(value))) {
      throw new Error('runtime manifest phpServices must contain phpX.Y-fpm units only');
    }
    return [...new Set(object.phpServices as string[])].sort();
  })();
  const socketPaths = object.socketPaths == null ? [] : (() => {
    if (!Array.isArray(object.socketPaths) || !object.socketPaths.every((value) => typeof value === 'string' && SOCKET_RE.test(value))) {
      throw new Error('runtime manifest socketPaths contains an unsafe socket path');
    }
    return [...new Set(object.socketPaths as string[])].sort();
  })();

  return {
    version: 1,
    requiresRuntimeCutover: object.requiresRuntimeCutover as boolean,
    artifacts,
    phpServices,
    socketPaths,
    httpProbes: parseHttpProbes(object.httpProbes),
    validations: parseValidations(object.validations),
  };
}

async function resolvedStagedPath(stageRoot: string, stagedPath: string): Promise<string> {
  const root = await fs.realpath(stageRoot);
  const resolved = await fs.realpath(stagedPath);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`staged runtime artifact escapes stage root: ${stagedPath}`);
  }
  const metadata = await fs.stat(resolved);
  if (!metadata.isFile()) throw new Error(`staged runtime artifact is not a regular file: ${stagedPath}`);
  return resolved;
}

export async function loadRuntimeManifest(manifestPath: string, stageRoot: string): Promise<ValidatedRuntimeManifest> {
  const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as unknown;
  const manifest = parseManifest(raw);
  const artifacts: RuntimeArtifact[] = [];
  for (const artifact of manifest.artifacts) {
    if (artifact.action === 'delete') {
      artifacts.push(artifact);
      continue;
    }
    const stagedPath = await resolvedStagedPath(stageRoot, artifact.stagedPath!);
    const content = await fs.readFile(stagedPath);
    const actual = createHash('sha256').update(content).digest('hex');
    if (actual !== artifact.sha256) {
      throw new Error(`staged runtime artifact checksum mismatch: ${artifact.target}`);
    }
    if (content.includes(0)) throw new Error(`runtime config contains NUL: ${artifact.target}`);
    // Keep the resolved regular-file path so the commit phase cannot follow a
    // staging symlink that is later retargeted after validation.
    artifacts.push({ ...artifact, stagedPath });
  }
  const validatedManifest: RuntimeManifest = { ...manifest, artifacts };
  return {
    manifest: validatedManifest,
    stageRoot: path.resolve(stageRoot),
    fingerprint: createHash('sha256').update(canonicalManifest(validatedManifest)).digest('hex'),
  };
}

async function domainRuntimeSchemaPresent(ctx: MigrationContext): Promise<boolean> {
  const rows = await ctx.prisma.$queryRawUnsafe<Array<{ name: string }>>("PRAGMA table_info('site_domains')");
  const columns = new Set(rows.map((row) => row.name));
  return columns.has('preset') && columns.has('runtime_key') && columns.has('app_status');
}

/**
 * Read a manifest supplied by tools/update.sh.  Before the domain-centric
 * Prisma release this migration is an intentional no-op; once final domain
 * fields exist, a missing renderer hand-off is a hard blocker.
 */
export async function runtimePlanForContext(ctx: MigrationContext): Promise<ValidatedRuntimeManifest | null> {
  const manifestPath = process.env.MEOWBOX_RUNTIME_MANIFEST;
  const stageRoot = process.env.MEOWBOX_RUNTIME_STAGE;
  if (!manifestPath || !stageRoot) {
    if (await domainRuntimeSchemaPresent(ctx)) {
      throw new Error(
        'Domain runtime schema is present but MEOWBOX_RUNTIME_MANIFEST/MEOWBOX_RUNTIME_STAGE are absent. ' +
          'Install the staged agent runtime renderer integration before applying this release.',
      );
    }
    return null;
  }
  return loadRuntimeManifest(manifestPath, stageRoot);
}

export function asMigrationPlan(runtime: ValidatedRuntimeManifest | null): MigrationPlan {
  if (!runtime) {
    return {
      summary: 'legacy schema detected; domain-runtime cutover is not required',
      fingerprint: createHash('sha256').update('legacy-no-domain-runtime').digest('hex'),
      details: { artifacts: 0, requiresRuntimeCutover: false },
    };
  }
  return {
    summary: runtime.manifest.requiresRuntimeCutover
      ? `stage ${runtime.manifest.artifacts.length} managed runtime artifacts`
      : 'runtime renderer reported no required cutover',
    fingerprint: runtime.fingerprint,
    details: {
      artifacts: runtime.manifest.artifacts.length,
      phpServices: runtime.manifest.phpServices ?? [],
      socketPaths: runtime.manifest.socketPaths ?? [],
      requiresRuntimeCutover: runtime.manifest.requiresRuntimeCutover,
    },
  };
}
