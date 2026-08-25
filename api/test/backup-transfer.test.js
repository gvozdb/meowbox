'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const test = require('node:test');
const { BackupTransferService } = require('../src/backups/backup-transfer.service');

class StreamResponse extends Writable {
  constructor() {
    super();
    this.headers = new Map();
    this.locals = {};
    this.chunks = [];
  }

  setHeader(name, value) {
    this.headers.set(String(name).toLowerCase(), String(value));
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-backup-transfer-'));
  const backupId = crypto.randomUUID();
  const filePath = path.join(root, 'backup.tar.gz');
  const payload = Buffer.from('backup-file-payload');
  fs.writeFileSync(filePath, payload);
  let source;
  let unregisterCalled = false;
  const issued = [];
  const backups = {
    getBackupForDownload: async (id) => {
      assert.equal(id, backupId);
      return { id: backupId, filePath };
    },
  };
  const transfers = {
    registerGeneratedSource: (kind, value) => {
      assert.equal(kind, 'BACKUP_FILE');
      source = value;
      return () => { unregisterCalled = true; };
    },
    issueGeneratedStream: async (input) => {
      issued.push(input);
      return { kind: 'TransferSession', transferMode: 'GENERATED_STREAM' };
    },
  };
  const config = { get: (_key, fallback) => fallback };
  const service = new BackupTransferService(config, backups, transfers);
  service.onModuleInit();
  t.after(() => {
    service.onModuleDestroy();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    backupId,
    filePath,
    issued,
    payload,
    service,
    source: () => source,
    unregisterCalled: () => unregisterCalled,
  };
}

test('T-XFER-001 backup file uses direct single-start stream contract', async (t) => {
  const state = fixture(t);
  const actor = { userId: crypto.randomUUID(), role: 'ADMIN' };
  const delivery = await state.service.issueDelivery(state.backupId, actor);
  assert.equal(delivery.transferMode, 'GENERATED_STREAM');
  assert.equal(state.issued.length, 1);
  assert.deepEqual(
    {
      sourceKind: state.issued[0].sourceKind,
      resourceId: state.issued[0].resourceId,
      actor: state.issued[0].actor,
      filename: state.issued[0].filename,
      contentType: state.issued[0].contentType,
    },
    {
      sourceKind: 'BACKUP_FILE',
      resourceId: state.backupId,
      actor,
      filename: 'backup.tar.gz',
      contentType: 'application/octet-stream',
    },
  );

  const response = new StreamResponse();
  await state.source().stream(state.backupId, actor, response);
  assert.deepEqual(Buffer.concat(response.chunks), state.payload);
  assert.equal(response.headers.get('content-length'), String(state.payload.length));
  state.service.onModuleDestroy();
  assert.equal(state.unregisterCalled(), true);
});

test('T-XFER-004 backup transfer rejects symlink sources', async (t) => {
  const state = fixture(t);
  const target = path.join(path.dirname(state.filePath), 'target.tar.gz');
  fs.renameSync(state.filePath, target);
  fs.symlinkSync(target, state.filePath);
  await assert.rejects(
    () => state.service.issueDelivery(
      state.backupId,
      { userId: crypto.randomUUID(), role: 'ADMIN' },
    ),
    /Файл бэкапа не найден/,
  );
  assert.equal(state.issued.length, 0);
});
