'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const { commitRuntimeArtifacts } = require('../dist/runtime-apply');
const runtimeApplySource = require('node:fs').readFileSync(
  join(__dirname, '..', 'runtime-apply.ts'),
  'utf8',
);

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function runtime(stageRoot, target, stagedPath, content) {
  return {
    stageRoot,
    fingerprint: sha256(content),
    manifest: {
      version: 1,
      requiresRuntimeCutover: true,
      artifacts: [{
        action: 'replace',
        target,
        stagedPath,
        sha256: sha256(content),
        mode: 0o640,
        uid: process.getuid(),
        gid: process.getgid(),
      }],
    },
  };
}

test('runtime switch commits staged bytes before checksum and service reload', () => {
  const start = runtimeApplySource.indexOf('async function switchRuntime');
  const end = runtimeApplySource.indexOf('\nasync function cleanupRuntime', start);
  const source = runtimeApplySource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(source.indexOf('commitRuntimeArtifacts') < source.indexOf('assertCommittedArtifacts'));
  assert.ok(source.indexOf('assertCommittedArtifacts') < source.indexOf('reloadServices'));
});

test('runtime apply commits changed artifacts on every release transaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'meowbox-runtime-apply-repeatable-'));
  try {
    const stageRoot = join(root, 'stage');
    const stagedPath = join(stageRoot, 'test.conf');
    const target = join(root, 'target', 'test.conf');
    await mkdir(stageRoot, { recursive: true });
    await mkdir(join(root, 'target'), { recursive: true });
    await writeFile(target, 'old\n');

    await writeFile(stagedPath, 'release-one\n');
    assert.equal(await commitRuntimeArtifacts(runtime(stageRoot, target, stagedPath, 'release-one\n')), 1);
    assert.equal(await readFile(target, 'utf8'), 'release-one\n');
    assert.equal((await lstat(target)).mode & 0o7777, 0o640);
    assert.equal(await commitRuntimeArtifacts(runtime(stageRoot, target, stagedPath, 'release-one\n')), 0);

    await writeFile(stagedPath, 'release-two\n');
    assert.equal(await commitRuntimeArtifacts(runtime(stageRoot, target, stagedPath, 'release-two\n')), 1);
    assert.equal(await readFile(target, 'utf8'), 'release-two\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime apply refuses symlink targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'meowbox-runtime-apply-symlink-'));
  try {
    const stageRoot = join(root, 'stage');
    const stagedPath = join(stageRoot, 'test.conf');
    const realTarget = join(root, 'real.conf');
    const target = join(root, 'target.conf');
    await mkdir(stageRoot, { recursive: true });
    await writeFile(stagedPath, 'managed\n');
    await writeFile(realTarget, 'unmanaged\n');
    await symlink(realTarget, target);

    await assert.rejects(
      commitRuntimeArtifacts(runtime(stageRoot, target, stagedPath, 'managed\n')),
      /missing or unsafe/,
    );
    assert.equal(await readFile(realTarget, 'utf8'), 'unmanaged\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
