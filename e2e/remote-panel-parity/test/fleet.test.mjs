import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FIXTURE_MARKER,
  createDisposableFleet,
  createLogicalStreamDescriptor,
  logicalByteStream,
  readLogicalChunk,
  removeDisposableFixtureRoot,
} from '../index.mjs';

test('disposable fleet materializes only a marked temporary fixture tree', async () => {
  const fleet = await createDisposableFleet({
    profileNames: ['current', 'custom-port', 'disabled-private'],
  });
  try {
    assert.equal(fleet.marker, FIXTURE_MARKER);
    assert.equal(fleet.networked, false);
    assert.equal(fleet.started, false);
    assert.equal(fleet.master.role, 'master');
    assert.deepEqual(fleet.targets.map(({ name }) => name), ['current', 'custom-port', 'disabled-private']);
    assert.ok(fleet.root.startsWith(`${tmpdir()}/`));
    for (const target of fleet.targets) {
      assert.ok(target.root.startsWith(`${fleet.root}/targets/`));
      assert.equal(target.listening, false);
      assert.equal(target.networked, false);
    }

    const marker = JSON.parse(await readFile(join(fleet.root, '.rpp-020-fixture.json'), 'utf8'));
    assert.equal(marker.marker, FIXTURE_MARKER);
    const restarted = fleet.restartService('current', 'api');
    assert.equal(restarted.state, 'restarted-plan-only');
    assert.equal(restarted.restartCount, 1);
    assert.equal(fleet.getServiceState('current', 'api').bootId, restarted.bootId);
    assert.throws(() => fleet.restartService('current', 'nginx'), /not restartable/);
  } finally {
    assert.equal(await fleet.cleanup(), true);
  }
  await assert.rejects(() => access(fleet.root));
});

test('caller-provided disposable roots cannot overwrite unrelated temp data', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'meowbox-rpp-owned-'));
  await writeFile(join(root, 'unrelated.txt'), 'keep');
  t.after(async () => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    () => createDisposableFleet({ root, profileNames: ['current'] }),
    /empty or an existing RPP-020 fixture root/,
  );
  await access(join(root, 'unrelated.txt'));
});

test('logical 50 GiB fixture is bounded and non-materialized', async () => {
  const descriptor = createLogicalStreamDescriptor();
  assert.equal(descriptor.sizeBytes, String(50n * 1024n * 1024n * 1024n));
  assert.equal(descriptor.materialized, false);
  assert.equal(descriptor.networked, false);

  const first = readLogicalChunk(descriptor, 0n, 64n);
  const later = readLogicalChunk(descriptor, 50n * 1024n * 1024n * 1024n - 64n, 64n);
  assert.equal(first.length, 64);
  assert.equal(later.length, 64);
  assert.notDeepEqual(first, later);

  const chunks = [];
  for await (const chunk of logicalByteStream(descriptor, { startBytes: 0n, endBytes: 17n * 1024n })) {
    chunks.push(chunk);
  }
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.length, 0), 17 * 1024);
  assert.ok(chunks.every((chunk) => chunk.length <= 8 * 1024 * 1024));
});

test('marked fixture cleanup remains fail-closed', async () => {
  const fleet = await createDisposableFleet({ profileNames: ['current'] });
  await fleet.cleanup();
  await assert.rejects(() => removeDisposableFixtureRoot(fleet.root), /ENOENT|fixture marker/);
});
