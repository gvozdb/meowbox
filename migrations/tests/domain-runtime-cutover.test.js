'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const {
  executeRuntimeCutover,
} = require('../dist/system/2026-07-31-001-domain-runtime-release');

const MIGRATION_ID = '2026-07-31-001-domain-runtime-release';
const FAULT_POINTS = [
  'after-prepare',
  'after-validate',
  'after-artifact',
  'after-commit',
  'after-cleanup',
];

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'meowbox-runtime-cutover-test-'));
  const stageRoot = join(root, 'stage');
  const targetRoot = join(root, 'targets');
  await mkdir(stageRoot, { recursive: true });
  await mkdir(targetRoot, { recursive: true });
  const stagedA = join(stageRoot, 'a.conf');
  const stagedB = join(stageRoot, 'b.conf');
  const targetA = join(targetRoot, 'a.conf');
  const targetB = join(targetRoot, 'b.conf');
  const contentA = 'pool=a\n';
  const contentB = 'server=b\n';
  await writeFile(stagedA, contentA);
  await writeFile(stagedB, contentB);

  const checkpoints = new Map();
  let writes = 0;
  const runtime = {
    fingerprint: sha256('runtime-plan'),
    stageRoot,
    manifest: {
      version: 1,
      requiresRuntimeCutover: true,
      artifacts: [
        {
          action: 'replace',
          target: targetA,
          stagedPath: stagedA,
          sha256: sha256(contentA),
          mode: 0o644,
        },
        {
          action: 'create',
          target: targetB,
          stagedPath: stagedB,
          sha256: sha256(contentB),
          mode: 0o644,
        },
        {
          action: 'delete',
          target: join(targetRoot, 'obsolete.conf'),
          postCommitOnly: true,
        },
      ],
    },
  };
  const ctx = {
    prisma: {},
    exec: {
      async run() { return { stdout: '', stderr: '' }; },
      async runShell() { return { stdout: '', stderr: '' }; },
    },
    async exists(path) {
      try {
        await readFile(path);
        return true;
      } catch {
        return false;
      }
    },
    async readFile(path) {
      return readFile(path, 'utf8');
    },
    async writeFile(path, content) {
      writes += 1;
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, content);
    },
    checkpoints: {
      async read(id) {
        return checkpoints.has(id)
          ? structuredClone(checkpoints.get(id))
          : null;
      },
      async write(id, value) {
        checkpoints.set(id, structuredClone(value));
      },
      async remove(id) {
        checkpoints.delete(id);
      },
      pathFor(id) {
        return join(root, `${id}.json`);
      },
    },
    log() {},
    config: {
      panelDir: root,
      currentDir: root,
      stateDir: root,
      migrationStateDir: root,
      releaseLockFile: join(root, 'lock'),
      sitesBasePath: join(root, 'sites'),
      nodeEnv: 'development',
    },
    dryRun: false,
  };

  return {
    root,
    runtime,
    ctx,
    checkpoints,
    targetA,
    targetB,
    contentA,
    contentB,
    writes: () => writes,
  };
}

for (const faultPoint of FAULT_POINTS) {
  test(`runtime cutover resumes safely after ${faultPoint}`, async () => {
    const state = await fixture();
    let injected = false;
    try {
      await assert.rejects(
        executeRuntimeCutover(state.ctx, state.runtime, (point) => {
          if (!injected && point === faultPoint) {
            injected = true;
            throw new Error(`injected ${point}`);
          }
        }),
        new RegExp(`injected ${faultPoint}`),
      );

      await executeRuntimeCutover(state.ctx, state.runtime);
      assert.equal(await readFile(state.targetA, 'utf8'), state.contentA);
      assert.equal(await readFile(state.targetB, 'utf8'), state.contentB);
      assert.equal(state.checkpoints.get(MIGRATION_ID).phase, 'cleanup');

      const writesAfterRecovery = state.writes();
      await executeRuntimeCutover(state.ctx, state.runtime);
      assert.equal(state.writes(), writesAfterRecovery, 'second run must be a no-op');
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });
}

test('runtime cutover rewinds a durable commit marker after config rollback', async () => {
  const state = await fixture();
  try {
    await executeRuntimeCutover(state.ctx, state.runtime);
    await writeFile(state.targetA, 'old-release\n');
    const writesBeforeRepair = state.writes();

    await executeRuntimeCutover(state.ctx, state.runtime);
    assert.equal(await readFile(state.targetA, 'utf8'), state.contentA);
    assert.ok(state.writes() > writesBeforeRepair);
    assert.equal(state.checkpoints.get(MIGRATION_ID).phase, 'cleanup');
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});
