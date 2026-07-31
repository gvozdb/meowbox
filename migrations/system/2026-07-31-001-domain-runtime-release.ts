/**
 * Domain-runtime release cutover.
 *
 * This migration is intentionally a thin, checkpointed committer.  The agent
 * runtime workstream renders PHP-FPM/Nginx/logrotate files into a staging tree;
 * tools/update.sh validates that tree against a cloned database, snapshots
 * active managed files, and only then invokes this migration under the common
 * release flock.  It never discovers arbitrary /etc ownership itself.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

import {
  asMigrationPlan,
  runtimePlanForContext,
  type ValidatedRuntimeManifest,
} from '../runtime-manifest';
import type { MigrationContext, MigrationPlan, SystemMigration } from './_types';

const MIGRATION_ID = '2026-07-31-001-domain-runtime-release';
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

type CheckpointPhase = 'prepare' | 'validate' | 'commit' | 'cleanup';

interface RuntimeCheckpoint {
  version: 1;
  migrationId: string;
  planFingerprint: string;
  phase: CheckpointPhase;
  preparedTargets: string[];
  appliedTargets: string[];
  deferredCleanupTargets: string[];
  updatedAt: string;
}

export type RuntimeCutoverFaultPoint =
  | 'after-prepare'
  | 'after-validate'
  | 'after-artifact'
  | 'after-commit'
  | 'after-cleanup';

export type RuntimeCutoverFaultInjector = (
  point: RuntimeCutoverFaultPoint,
  detail?: { target?: string; index?: number },
) => void | Promise<void>;

function checkpointFor(runtime: ValidatedRuntimeManifest, phase: CheckpointPhase): RuntimeCheckpoint {
  return {
    version: 1,
    migrationId: MIGRATION_ID,
    planFingerprint: runtime.fingerprint,
    phase,
    preparedTargets: runtime.manifest.artifacts.map((artifact) => artifact.target).sort(),
    appliedTargets: [],
    deferredCleanupTargets: runtime.manifest.artifacts
      .filter((artifact) => artifact.action === 'delete' || artifact.postCommitOnly === true)
      .map((artifact) => artifact.target)
      .sort(),
    updatedAt: new Date().toISOString(),
  };
}

function assertCheckpoint(value: RuntimeCheckpoint, runtime: ValidatedRuntimeManifest): void {
  if (value.version !== 1 || value.migrationId !== MIGRATION_ID) {
    throw new Error(`Invalid checkpoint format at ${MIGRATION_ID}; restore the release snapshot before retrying.`);
  }
  if (value.planFingerprint !== runtime.fingerprint) {
    throw new Error(
      `Runtime plan changed after checkpoint ${value.phase}; refusing to combine artifact sets. ` +
        'Restore/recreate the release transaction and run dry-run again.',
    );
  }
}

async function stagedText(runtime: ValidatedRuntimeManifest, target: string): Promise<string> {
  const artifact = runtime.manifest.artifacts.find((item) => item.target === target);
  if (!artifact || !artifact.stagedPath) throw new Error(`No staged content for ${target}`);
  const content = await fs.readFile(artifact.stagedPath);
  if (content.byteLength > MAX_CONFIG_BYTES) throw new Error(`Staged config is too large: ${target}`);
  if (createHash('sha256').update(content).digest('hex') !== artifact.sha256) {
    throw new Error(`Staged runtime artifact checksum changed after validation: ${target}`);
  }
  const text = content.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(content) || text.includes('\0')) {
    throw new Error(`Staged runtime artifact is not safe UTF-8 text: ${target}`);
  }
  return text;
}

/**
 * A checkpoint can outlive a pre-commit SQLite/config rollback.  Never assume
 * its `commit` marker still describes the filesystem: compare every durable
 * write target with its staged digest and rewind to `validate` when recovery
 * restored the previous configuration.  This makes a retry safe both after a
 * hard process kill and after tools/rollback.sh restores a snapshot.
 */
async function committedArtifactsStillMatch(runtime: ValidatedRuntimeManifest): Promise<boolean> {
  for (const artifact of runtime.manifest.artifacts) {
    if (artifact.action === 'delete' || artifact.postCommitOnly === true) continue;
    try {
      const content = await fs.readFile(artifact.target);
      const digest = createHash('sha256').update(content).digest('hex');
      if (digest !== artifact.sha256) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function getRuntime(ctx: MigrationContext): Promise<ValidatedRuntimeManifest | null> {
  const runtime = await runtimePlanForContext(ctx);
  if (runtime?.manifest.requiresRuntimeCutover && process.env.MEOWBOX_RUNTIME_VALIDATED !== '1') {
    throw new Error(
      'Refusing domain runtime commit without MEOWBOX_RUNTIME_VALIDATED=1. ' +
        'Run the candidate staged PHP-FPM/Nginx validation through tools/update.sh first.',
    );
  }
  return runtime;
}

/**
 * Exported for clone-only interruption tests. Production calls it without a
 * fault injector, so no environment flag can accidentally break a release.
 */
export async function executeRuntimeCutover(
  ctx: MigrationContext,
  runtime: ValidatedRuntimeManifest,
  injectFault: RuntimeCutoverFaultInjector = () => {},
): Promise<void> {
  let checkpoint = await ctx.checkpoints.read<RuntimeCheckpoint>(MIGRATION_ID);
  if (checkpoint) assertCheckpoint(checkpoint, runtime);
  if (checkpoint && (checkpoint.phase === 'commit' || checkpoint.phase === 'cleanup')
    && !(await committedArtifactsStillMatch(runtime))) {
    checkpoint = {
      ...checkpoint,
      phase: 'validate',
      appliedTargets: [],
      updatedAt: new Date().toISOString(),
    };
    await ctx.checkpoints.write(MIGRATION_ID, checkpoint);
    ctx.log('checkpoint filesystem digest mismatch: rewound to validate after rollback/interruption');
  }
  if (!checkpoint) {
    checkpoint = checkpointFor(runtime, 'prepare');
    await ctx.checkpoints.write(MIGRATION_ID, checkpoint);
    ctx.log(`checkpoint prepare: ${checkpoint.preparedTargets.length} managed artifacts`);
    await injectFault('after-prepare');
  }

  if (checkpoint.phase === 'prepare') {
    checkpoint = { ...checkpoint, phase: 'validate', updatedAt: new Date().toISOString() };
    await ctx.checkpoints.write(MIGRATION_ID, checkpoint);
    ctx.log('checkpoint validate: staged manifest checksum/containment verified');
    await injectFault('after-validate');
  }

  if (checkpoint.phase === 'validate') {
    const appliedTargets: string[] = [];
    for (const [index, artifact] of runtime.manifest.artifacts.entries()) {
      // Deleting an obsolete Site-level pool before final HTTP health would
      // destroy the rollback path. tools/update.sh performs deferred,
      // idempotent cleanup only after the commit boundary.
      if (artifact.action === 'delete' || artifact.postCommitOnly === true) continue;
      const text = await stagedText(runtime, artifact.target);
      await ctx.writeFile(
        artifact.target,
        text,
        artifact.mode,
        artifact.uid == null || artifact.gid == null ? undefined : { uid: artifact.uid, gid: artifact.gid },
      );
      appliedTargets.push(artifact.target);
      ctx.log(`committed staged artifact ${artifact.target}`);
      await injectFault('after-artifact', { target: artifact.target, index });
    }
    checkpoint = {
      ...checkpoint,
      phase: 'commit',
      appliedTargets: appliedTargets.sort(),
      updatedAt: new Date().toISOString(),
    };
    await ctx.checkpoints.write(MIGRATION_ID, checkpoint);
    await injectFault('after-commit');
  }

  if (checkpoint.phase === 'commit') {
    checkpoint = { ...checkpoint, phase: 'cleanup', updatedAt: new Date().toISOString() };
    await ctx.checkpoints.write(MIGRATION_ID, checkpoint);
    if (checkpoint.deferredCleanupTargets.length > 0) {
      ctx.log(`deferred cleanup until post-commit health: ${checkpoint.deferredCleanupTargets.join(', ')}`);
    } else {
      ctx.log('checkpoint cleanup: no obsolete managed artifacts');
    }
    await injectFault('after-cleanup');
  }

  ctx.log(`runtime cutover checkpoint complete (${ctx.checkpoints.pathFor(MIGRATION_ID)})`);
}

const migration: SystemMigration = {
  id: MIGRATION_ID,
  description: 'Checkpointed staged per-domain PHP-FPM/Nginx/logrotate runtime cutover',

  async preflight(ctx) {
    try {
      const runtime = await getRuntime(ctx);
      if (!runtime) return { ok: true };
      if (runtime.manifest.requiresRuntimeCutover && runtime.manifest.artifacts.length === 0) {
        return { ok: false, reason: 'runtime cutover was required but renderer emitted no managed artifacts' };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
  },

  async plan(ctx): Promise<MigrationPlan> {
    return asMigrationPlan(await runtimePlanForContext(ctx));
  },

  async up(ctx) {
    const runtime = await getRuntime(ctx);
    if (!runtime) {
      ctx.log('legacy schema: no domain-runtime artifacts required');
      return;
    }

    await executeRuntimeCutover(ctx, runtime);
  },
};

export default migration;
