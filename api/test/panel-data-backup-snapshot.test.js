'use strict';

require('reflect-metadata');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PanelDataBackupService } = require('../src/backups/panel-data-backup.service');

function fixture(t, corrupt = false, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-backup-run-'));
  const previous = process.env.MEOWBOX_STATE_DIR;
  process.env.MEOWBOX_STATE_DIR = root;
  fs.mkdirSync(path.join(root, 'data'));
  const db = path.join(root, 'data', 'meowbox.db');
  if (corrupt) fs.writeFileSync(db, 'invalid database');
  else execFileSync('sqlite3', [db, 'CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES (\'ok\');']);
  const config = {
    id: 'config', name: 'Panel', enabled: true, engine: 'RESTIC',
    storageLocationIds: JSON.stringify(['a', 'b']),
  };
  const locations = ['a', 'b'].map((id) => ({
    id, name: id, type: 'LOCAL', config: '{}', resticPassword: 'fixture-only', resticEnabled: true,
  }));
  const rows = new Map();
  let nextId = 1;
  const matches = (row, where) => {
    if (where.OR && !where.OR.some((branch) => matches(row, branch))) return false;
    if (where.id?.in && !where.id.in.includes(row.id)) return false;
    if (typeof where.id === 'string' && row.id !== where.id) return false;
    if (where.configId && row.configId !== where.configId) return false;
    if (where.filePath && row.filePath !== where.filePath) return false;
    if (where.status?.in && !where.status.in.includes(row.status)) return false;
    if (typeof where.status === 'string' && row.status !== where.status) return false;
    if (where.errorMessage?.startsWith && !row.errorMessage?.startsWith(where.errorMessage.startsWith)) return false;
    return true;
  };
  const prisma = {
    panelDataBackupConfig: { findUnique: async () => config },
    storageLocation: { findMany: async () => locations },
    panelDataBackup: {
      findFirst: async ({ where }) => [...rows.values()].find((row) => matches(row, where)) || null,
      findUnique: async ({ where }) => {
        const row = rows.get(where.id);
        return row && { ...row, config: { id: config.id, name: config.name, notificationMode: 'INSTANT' } };
      },
      create: async ({ data }) => {
        const row = { id: `backup-${nextId++}`, filePath: '', ...data };
        rows.set(row.id, row);
        return row;
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of rows.values()) {
          if (matches(row, where)) { Object.assign(row, data); count++; }
        }
        return { count };
      },
      count: async ({ where }) => [...rows.values()].filter((row) => matches(row, where)).length,
    },
  };
  const events = [];
  const service = new PanelDataBackupService(
    prisma,
    {
      isAgentConnected: () => true,
      emitToAgent: async (event) => {
        assert.equal(event, 'backup:activity');
        return { success: true, data: { ids: [] } };
      },
      enqueueBackup: async (event, data) => {
        events.push({ event, data });
        const failure = typeof options.admissionFailure === 'function'
          ? options.admissionFailure(data) : options.admissionFailure;
        if (failure) throw failure;
      },
    },
    {},
    { handleCompletion: async () => {} },
    { applyForPanelBackup: async () => {} },
  );
  t.after(() => {
    if (previous === undefined) delete process.env.MEOWBOX_STATE_DIR;
    else process.env.MEOWBOX_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, rows, events, service };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for dispatch result');
}

test('one panel snapshot remains until all destination rows finish', async (t) => {
  const { root, rows, events, service } = fixture(t);
  const result = await service.triggerBackup('config');
  const snapshot = result.snapshotPath;
  assert.equal(rows.size, 2);
  assert.ok(fs.existsSync(snapshot));
  assert.equal(events.length, 2);
  assert.ok(events.every(({ event, data }) =>
    event === 'restic:backup-paths' && data.scope === 'PANEL_DATA' && data.paths.includes(snapshot)));
  assert.ok([...rows.values()].every((row) => row.filePath === snapshot));
  await service.completeBackup(result.backups[0].id, true, 'repository-a', 100);
  assert.ok(fs.existsSync(snapshot));
  await service.completeBackup(result.backups[1].id, true, 'repository-b', 100);
  assert.equal(fs.existsSync(snapshot), false);
  assert.deepEqual(fs.readdirSync(path.join(root, 'data', 'snapshots')), []);
});

test('lost admission ACK leaves rows pending and preserves their SQLite snapshot', async (t) => {
  const timeout = new Error('ACK lost');
  timeout.name = 'AgentTimeoutError';
  const { rows, service } = fixture(t, false, { admissionFailure: timeout });
  const result = await service.triggerBackup('config');
  await waitFor(() => [...rows.values()].every((row) => row.errorMessage?.includes('ACK lost')));
  assert.ok([...rows.values()].every((row) => row.status === 'PENDING' && row.completedAt === null));
  assert.ok(fs.existsSync(result.snapshotPath));
  await assert.rejects(service.triggerBackup('config'), /Active panel-data backup already running/);
  assert.ok(fs.existsSync(result.snapshotPath));
});

test('late success repairs dispatch failure, and later failure cannot regress completion', async (t) => {
  const timeout = new Error('ACK lost');
  timeout.name = 'AgentTimeoutError';
  const { rows, service } = fixture(t, false, {
    admissionFailure: ({ backupId }) => backupId === 'backup-1'
      ? new Error('agent rejected job') : timeout,
  });
  const result = await service.triggerBackup('config');
  await waitFor(() => rows.get('backup-1').status === 'FAILED' &&
    rows.get('backup-2').errorMessage?.includes('ACK lost'));
  assert.equal(rows.get('backup-2').status, 'PENDING');
  assert.ok(fs.existsSync(result.snapshotPath));

  const first = result.backups[0].id;
  const second = result.backups[1].id;
  assert.equal(await service.completeBackup(first, true, 'repository-a', 100, undefined, 'snapshot-a'), true);
  assert.equal(rows.get(first).status, 'COMPLETED');
  assert.equal(rows.get(first).resticSnapshotId, 'snapshot-a');
  assert.ok(fs.existsSync(result.snapshotPath));
  assert.equal(await service.completeBackup(first, false, undefined, undefined, 'late failure'), false);
  assert.equal(rows.get(first).status, 'COMPLETED');
  assert.equal(rows.get(first).resticSnapshotId, 'snapshot-a');

  await service.completeBackup(second, true, 'repository-b', 100);
  assert.equal(fs.existsSync(result.snapshotPath), false);
});

test('snapshot preparation error is saved on each destination row', async (t) => {
  const { rows, service } = fixture(t, true);
  await assert.rejects(service.triggerBackup('config'));
  assert.equal(rows.size, 2);
  assert.ok([...rows.values()].every((row) =>
    row.status === 'FAILED' && row.errorMessage.startsWith('Snapshot preparation failed:') && row.completedAt,
  ));
});

test('uncertain agent restart keeps the source even after other destinations finish', async (t) => {
  const { rows, service } = fixture(t);
  const result = await service.triggerBackup('config');
  await service.completeBackup(result.backups[0].id, false, undefined, undefined,
    'Agent restarted before backup completion; reconciliation required');
  await service.completeBackup(result.backups[1].id, true, 'repository-b', 100);
  assert.equal(rows.get(result.backups[0].id).filePath, result.snapshotPath);
  assert.ok(fs.existsSync(result.snapshotPath));
  fs.utimesSync(result.snapshotPath, new Date(0), new Date(0));
  await service.cleanupOrphanedSnapshots(path.dirname(result.snapshotPath));
  assert.ok(fs.existsSync(result.snapshotPath));
});

test('orphan cleanup touches only owned terminal snapshots', async (t) => {
  const { root, rows, service } = fixture(t);
  const dir = path.join(root, 'data', 'snapshots');
  fs.mkdirSync(dir);
  const owned = path.join(dir, 'panel-run-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.db');
  const active = path.join(dir, 'panel-run-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee.db');
  const unrelated = path.join(dir, 'panel-backup-123.db');
  for (const file of [owned, active, unrelated]) {
    fs.writeFileSync(file, 'temporary fixture');
    fs.utimesSync(file, new Date(0), new Date(0));
  }
  rows.set('active', { id: 'active', configId: 'config', status: 'IN_PROGRESS', filePath: active });
  await service.cleanupOrphanedSnapshots(dir);
  assert.equal(fs.existsSync(owned), false);
  assert.equal(fs.existsSync(active), true);
  assert.equal(fs.existsSync(unrelated), true);
});
