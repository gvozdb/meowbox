'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  assessSystemMigrationHistory,
} = require('../dist/system-history');

const systemDir = path.resolve(__dirname, '..', 'dist', 'system');

function currentArtifacts() {
  return readdirSync(systemDir)
    .filter((file) => file.endsWith('.js') && !file.startsWith('_'))
    .map((file) => ({
      id: file.replace(/\.js$/, ''),
      checksum: createHash('sha256')
        .update(readFileSync(path.join(systemDir, file)))
        .digest('hex'),
    }));
}

const KNOWN_XRAY_FAILURE_LOG =
  'Downloading Xray (64) from https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip...\n' +
  'OK: xray установлен — Xray 26.3.27 (Xray, Penetrates Everything.) d2758a0 (go1.26.1 linux/amd64)\n' +
  'Creating user meowbox-vpn...\n' +
  '\n' +
  'ERROR: Error: spawn useradd ENOENT\n' +
  '    at ChildProcess._handle.onexit (node:internal/child_process:285:19)\n' +
  '    at onErrorNT (node:internal/child_process:483:16)\n' +
  '    at process.processTicksAndRejections (node:internal/process/task_queues:90:21)\n';

function productionLegacyRows() {
  return [
    {
      id: '2026-04-29-001-nginx-layered-rebuild',
      ok: true,
      checksum:
        '7177c0bc9ea47adf246db7585a8cc8ad260f447b0e76c325e89647a6647f4b44',
      errorLog: null,
    },
    {
      id: '2026-04-30-005-install-php-versions',
      ok: true,
      checksum:
        '375374bc308157f6d72b7a2c9ac53b861c972ea6b19ca135c0b211a652a05de7',
      errorLog: null,
    },
    {
      id: '2026-05-01-007-legacy-php-repo-bootstrap',
      ok: true,
      checksum:
        'b9d3de93c8d80a4e4962205f87c4b6991886f55ed7320b30b8ae7590887d3d04',
      errorLog: null,
    },
    {
      id: '2026-05-01-009-install-modx-php-extensions',
      ok: true,
      checksum:
        '89b5075001fc0c14883041601566936a3218e4469c6525fa78e66d4818d73f98',
      errorLog: null,
    },
    {
      id: '2026-05-02-001-mariadb-tune-import',
      ok: true,
      checksum: 'manual-ad-hoc',
      errorLog: null,
    },
    {
      id: '2026-05-09-002-install-xray',
      ok: false,
      checksum:
        '28ed606643c5944ceaf59a3011bbe5eca6b152c005f47a94dc4846a1d8d8a653',
      errorLog: KNOWN_XRAY_FAILURE_LOG,
    },
    {
      id: '2026-05-09-002-vpn-fix-paths-and-runtime-user',
      ok: true,
      checksum:
        '82d88b12a2b9d1de3072054946dee472be905a605962d048824d202bf63b15af',
      errorLog: null,
    },
    {
      id: '2026-05-09-003-install-amneziawg',
      ok: true,
      checksum:
        '45b3484a5f77776b84be797144eb297e43276205c086f9e97e13e8364e3368f4',
      errorLog: null,
    },
    {
      id: '2026-05-10-002-rekey-secrets',
      ok: true,
      checksum:
        '27d636b8740abaf92a5fb7191886dd928535349c2a0e02b17d620fb7ed36072d',
      errorLog: null,
    },
  ];
}

test('accepts only the exact reviewed legacy history contract', () => {
  const result = assessSystemMigrationHistory(
    currentArtifacts(),
    productionLegacyRows(),
  );
  assert.equal(result.acceptedLegacy.length, 8);
  assert.deepEqual(
    result.acceptedLegacy
      .filter((entry) => entry.kind === 'superseded-failure')
      .map((entry) => entry.id),
    ['2026-05-09-002-install-xray'],
  );
});

test('rejects stale current artifact, wrong stored checksum, and unknown orphan', () => {
  const current = currentArtifacts();
  const staleCurrent = current.map((record) =>
    record.id === '2026-04-29-001-nginx-layered-rebuild'
      ? { ...record, checksum: '0'.repeat(64) }
      : record,
  );
  assert.throws(
    () => assessSystemMigrationHistory(staleCurrent, []),
    /compatibility is stale/,
  );

  const wrongStored = productionLegacyRows();
  wrongStored[0] = { ...wrongStored[0], checksum: '1'.repeat(64) };
  assert.throws(
    () => assessSystemMigrationHistory(current, wrongStored),
    /checksum drift/,
  );

  assert.throws(
    () =>
      assessSystemMigrationHistory(current, [
        {
          id: '2026-01-01-001-unknown',
          ok: true,
          checksum: '2'.repeat(64),
          errorLog: null,
        },
      ]),
    /Unknown or drifted applied system migration artifact/,
  );
});

test('failed legacy artifact requires exact error and exact successful superseder', () => {
  const current = currentArtifacts();
  const wrongFailure = productionLegacyRows();
  const failedIndex = wrongFailure.findIndex(
    (row) => row.id === '2026-05-09-002-install-xray',
  );
  wrongFailure[failedIndex] = {
    ...wrongFailure[failedIndex],
    errorLog: `${wrongFailure[failedIndex].errorLog}changed`,
  };
  assert.throws(
    () => assessSystemMigrationHistory(current, wrongFailure),
    /not proven superseded/,
  );

  const missingSuperseder = productionLegacyRows().filter(
    (row) => row.id !== '2026-05-09-002-vpn-fix-paths-and-runtime-user',
  );
  assert.throws(
    () => assessSystemMigrationHistory(current, missingSuperseder),
    /not proven superseded/,
  );
});

test('an uncontracted failed current migration still blocks the release', () => {
  const current = currentArtifacts();
  const target = current.find(
    (row) => row.id === '2026-05-09-001-vpn-secret-bootstrap',
  );
  assert.ok(target);
  assert.throws(
    () =>
      assessSystemMigrationHistory(current, [
        {
          ...target,
          ok: false,
          errorLog: 'unexpected failure',
        },
      ]),
    /Interrupted\/failed system migration state blocks release update/,
  );
});
