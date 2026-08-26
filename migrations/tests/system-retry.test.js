const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assertFailedSystemMigrationRetry,
} = require('../dist/system-retry');

const id = '2026-08-24-003-adminer-handoff-v2-runtime';
const checksum = 'a'.repeat(64);

function failed(overrides = {}) {
  return {
    id,
    checksum,
    ok: false,
    errorLog: 'ERROR: nginx was unavailable',
    ...overrides,
  };
}

test('accepts the exact latest failed migration artifact', () => {
  const record = failed();
  assert.equal(
    assertFailedSystemMigrationRetry(id, checksum, [
      failed({ id: '2026-08-24-002-federation-endpoint-defaults', ok: true, errorLog: null }),
      record,
    ]),
    record,
  );
});

test('rejects missing, successful, or unaudited failure records', () => {
  assert.throws(
    () => assertFailedSystemMigrationRetry(id, checksum, []),
    /not recorded/,
  );
  assert.throws(
    () => assertFailedSystemMigrationRetry(id, checksum, [failed({ ok: true, errorLog: null })]),
    /already succeeded/,
  );
  assert.throws(
    () => assertFailedSystemMigrationRetry(id, checksum, [failed({ errorLog: null })]),
    /no recorded error/,
  );
});

test('rejects checksum drift and later migration history', () => {
  assert.throws(
    () => assertFailedSystemMigrationRetry(id, checksum, [failed({ checksum: 'b'.repeat(64) })]),
    /checksum drift/,
  );
  assert.throws(
    () => assertFailedSystemMigrationRetry(id, checksum, [
      failed(),
      failed({ id: '2026-08-25-001-transfer-runtime', ok: true, errorLog: null }),
    ]),
    /later migration history/,
  );
});

test('rejects unsafe IDs and invalid current checksums', () => {
  assert.throws(
    () => assertFailedSystemMigrationRetry('../migration', checksum, [failed()]),
    /Unsafe/,
  );
  assert.throws(
    () => assertFailedSystemMigrationRetry(id, 'not-a-checksum', [failed()]),
    /lowercase SHA-256/,
  );
});
