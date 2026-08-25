'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const tracePath = path.join(root, 'specs/remote-panel-parity/traceability.spec.ctx');
const matrixPath = path.join(root, 'specs/remote-panel-parity/action-matrix.yaml');

function range(prefix, count) {
  return Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);
}

const expected = new Set([
  ...range('CF', 22),
  ...range('A', 20),
  ...range('SP', 8),
  ...range('IM', 6),
  ...range('BN', 3),
]);

function parseTraceability() {
  const source = fs.readFileSync(tracePath, 'utf8');
  assert.equal(source.split(/\r?\n/, 1)[0], 'spec');
  assert.match(source, /\nopen_questions: \[\]\s*$/);
  const records = new Map();
  const pattern = /^\s*req (CF\d+|A\d+|SP\d+|IM\d+|BN\d+) \{ tasks: \[([^\]]+)\]; tests: \[([^\]]+)\]; gate: \[([^\]]+)\] \}$/gm;
  for (const match of source.matchAll(pattern)) {
    const [, id, tasks, tests, gates] = match;
    assert.equal(records.has(id), false, `duplicate traceability record ${id}`);
    records.set(id, {
      tasks: tasks.split(','),
      tests: tests.split(','),
      gates: gates.split(','),
    });
  }
  return records;
}

test('T-TRACE-001 exact CF/A/SP/IM/BN sets map to tasks, executable tests, and gates', () => {
  const records = parseTraceability();
  assert.deepEqual([...records.keys()].sort(), [...expected].sort());
  for (const [id, record] of records) {
    assert.ok(record.tasks.length > 0, `${id} tasks`);
    assert.ok(record.tasks.every((task) => /^RPP-\d{3}$/.test(task)), `${id} task format`);
    assert.ok(record.tests.length > 0, `${id} tests`);
    assert.ok(record.gates.length > 0, `${id} gates`);
    for (const relativePath of record.tests) {
      assert.equal(fs.existsSync(path.join(root, relativePath)), true, `${id}: ${relativePath}`);
    }
  }
});

test('T-TRACE-001 every discovered action retains machine-readable traceability and verification', () => {
  const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
  assert.ok(matrix.actions.length >= 751);
  for (const action of matrix.actions) {
    assert.equal(action.verification?.test, 'T-TRACE-001', action.sourceKey);
    assert.equal(action.verification?.metric?.name, 'unclassified-source-declarations', action.sourceKey);
    const ids = Object.values(action.traceability ?? {}).flat();
    assert.ok(ids.length > 0, action.sourceKey);
    assert.ok(ids.every((id) => expected.has(id)), action.sourceKey);
  }
  assert.ok(
    matrix.legacyUnsafeFindings.every((finding) => finding.remoteActivation === 'DENY'),
  );
});

test('T-TRACE-001 page coverage remains exactly the approved 34-page surface', () => {
  const source = fs.readFileSync(path.join(root, 'web/tests/page-capability-pass.test.js'), 'utf8');
  const block = source.match(/const expectedPages = \[([\s\S]*?)\];/)?.[1] ?? '';
  assert.equal((block.match(/'[^']+\.vue'/g) ?? []).length, 34);
  assert.match(source, /all 34 pages remain inside the capability-gated transport boundary/);
});

