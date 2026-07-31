'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const policy = path.join(root, 'tools', 'release-transaction-policy.sh');
const updater = path.join(root, 'tools', 'update.sh');

function action(armed, committed, journalState) {
  return execFileSync(
    'bash',
    [
      '-c',
      'source "$1"; mb_update_failure_action "$2" "$3" "$4"',
      'policy-test',
      policy,
      String(armed),
      String(committed),
      journalState,
    ],
    { encoding: 'utf8' },
  ).trim();
}

test('every pre-commit mutating update phase selects matched rollback', () => {
  for (const phase of [
    'U04-quiesce',
    'U05-database',
    'U06-runtime',
    'U07-switch',
    'U08-verify',
  ]) {
    assert.equal(action(true, false, 'uncommitted'), 'rollback', phase);
  }
  assert.equal(action(false, false, 'uncommitted'), 'none', 'U03-snapshot');
});

test('durable commit always selects forward repair, including hard-kill gap', () => {
  for (const phase of [
    'U09-commit-journal',
    'U09-resume',
    'U09-cleanup',
    'U09-final-health',
  ]) {
    assert.equal(action(true, false, 'committed'), 'forward-repair', phase);
    assert.equal(action(true, true, 'committed'), 'forward-repair', phase);
  }
});

test('indeterminate armed journal never triggers automatic DB rollback', () => {
  assert.equal(action(true, false, 'unknown'), 'manual');
  assert.equal(action(true, false, 'corrupt'), 'manual');
});

test('updater wires tested policy across ordered transaction phases', () => {
  const source = fs.readFileSync(updater, 'utf8');
  assert.match(source, /source "\$SCRIPT_DIR\/release-transaction-policy\.sh"/);
  assert.match(source, /failure_action="\$\(/);
  assert.match(source, /failure_action" == "rollback"/);
  assert.match(source, /failure_action" == "forward-repair"/);
  assert.match(source, /failure_action" == "manual"/);

  const markers = [
    'stage U03-snapshot',
    'stage U04-quiesce',
    'apply_database',
    'prepare_apply_runtime',
    'switch_release',
    'verify_release',
    'stage U09-commit',
    'journal_update commit',
    'COMMITTED=true',
  ];
  let offset = 0;
  for (const marker of markers) {
    const next = source.indexOf(marker, offset);
    assert.notEqual(next, -1, `missing ordered marker: ${marker}`);
    offset = next + marker.length;
  }
});
