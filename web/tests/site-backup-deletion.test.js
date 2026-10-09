'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const webRoot = path.resolve(__dirname, '..');

function loadTypeScript(file) {
  const source = fs.readFileSync(file, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: file,
  }).outputText;
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = module.paths;
  loaded._compile(output, file);
  return loaded.exports;
}

const { deleteBackupAndWaitForSuccess } = loadTypeScript(
  path.join(webRoot, 'utils/site-backup-deletion.ts'),
);

test('site backup deletion sends an idempotency key and removes the row only after success', async () => {
  const events = [];
  const controller = new AbortController();
  let finishOperation;
  const operationDone = new Promise((resolve) => { finishOperation = resolve; });
  let removed = false;

  const deletion = deleteBackupAndWaitForSuccess({
    backupId: 'backup-123',
    idempotencyKey: 'backup-delete-test-key',
    signal: controller.signal,
    requestDelete: async (backupId, options) => {
      events.push('delete');
      assert.equal(backupId, 'backup-123');
      assert.equal(options.headers['Idempotency-Key'], 'backup-delete-test-key');
      assert.equal(options.signal, controller.signal);
      return { operationId: 'operation-123' };
    },
    waitForOperation: async (operationId, options) => {
      events.push('wait');
      assert.equal(operationId, 'operation-123');
      assert.equal(options.timeoutMs, 2 * 60 * 60_000);
      assert.equal(options.signal, controller.signal);
      await operationDone;
    },
    assertContextCurrent: () => events.push('context'),
    onDeleted: () => {
      removed = true;
      events.push('removed');
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['delete', 'context', 'wait']);
  assert.equal(removed, false);

  finishOperation({ status: 'SUCCEEDED' });
  await deletion;
  assert.deepEqual(events, ['delete', 'context', 'wait', 'context', 'removed']);
  assert.equal(removed, true);
});

test('site backup deletion propagates NEEDS_ATTENTION and keeps the row', async () => {
  const failure = Object.assign(new Error('Удаление требует ручного внимания'), {
    operation: { status: 'NEEDS_ATTENTION', errorMessage: 'Хранилище недоступно' },
  });
  let removed = false;

  await assert.rejects(
    deleteBackupAndWaitForSuccess({
      backupId: 'backup-123',
      idempotencyKey: 'backup-delete-test-key',
      requestDelete: async () => ({ operationId: 'operation-123' }),
      waitForOperation: async () => { throw failure; },
      assertContextCurrent: () => undefined,
      onDeleted: () => { removed = true; },
    }),
    (error) => error === failure,
  );
  assert.equal(removed, false);
});

test('site backup deletion does not update stale UI after target context changes', async () => {
  let contextChecks = 0;
  let removed = false;

  await assert.rejects(
    deleteBackupAndWaitForSuccess({
      backupId: 'backup-123',
      idempotencyKey: 'backup-delete-test-key',
      requestDelete: async () => ({ operationId: 'operation-123' }),
      waitForOperation: async () => ({ status: 'SUCCEEDED' }),
      assertContextCurrent: () => {
        contextChecks += 1;
        if (contextChecks === 2) throw new Error('target changed');
      },
      onDeleted: () => { removed = true; },
    }),
    /target changed/,
  );
  assert.equal(removed, false);
});

test('site backup deletion exposes pending state and reports operation failures', () => {
  const source = fs.readFileSync(path.join(webRoot, 'pages/sites/[id].vue'), 'utf8');
  assert.match(source, /deletingSiteBackups\.has\(b\.id\)[\s\S]*?:disabled="deletingSiteBackups\.has\(b\.id\)"/);
  assert.match(source, /deleteBackupAndWaitForSuccess\(\{/);
  assert.match(source, /useMbToast\(\)\.error\(message\)/);
  assert.match(source, /failure\.operation\?\.status === 'NEEDS_ATTENTION'/);
  assert.match(source, /архив бэкапа из хранилища и запись о нём из панели/);
});
