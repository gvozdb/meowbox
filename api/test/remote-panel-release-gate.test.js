'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const gateScript = path.join(root, 'tools/remote-panel-release-gate.mjs');

function run(mode) {
  const result = spawnSync(process.execPath, [gateScript, '--root', root, '--mode', mode, '--json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { ...result, data: JSON.parse(result.stdout) };
}

test('T-REL-001 implementation release gate is machine-readable and passes source-only checks', () => {
  const result = run('implementation');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.data.implementationReady, true);
  assert.equal(result.data.activationReady, false);
  assert.equal(result.data.activationEvidence.pass, false);
  assert.ok(result.data.checks.every(({ pass }) => pass));
  assert.ok(Object.values(result.data.activationStatuses).every((status) => status === 'UNRUN'));
});

test('T-CAN-001 activation stays fail-closed without signed external evidence', () => {
  const result = run('activation');
  assert.equal(result.status, 1);
  assert.equal(result.data.activationReady, false);
  assert.equal(result.data.devMode, fs.existsSync(path.join(root, '.dev-mode')));
  assert.equal(result.data.activationEvidence.pass, false);
  assert.equal(result.data.activationStatuses['T-CAN-24H'], 'UNRUN');
});

test('T-REL-002 release package includes federation runbooks and activation contract', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  assert.match(workflow, /cp -r docs "\$STAGE\/"/);
  assert.match(workflow, /cp -r specs\/remote-panel-parity "\$STAGE\/specs\/"/);
  assert.match(workflow, /test -f "\$STAGE\/docs\/runbook\/remote-panel-rollout\.md"/);
  assert.match(workflow, /test -f "\$STAGE\/specs\/remote-panel-parity\/activation-gates\.spec\.ctx"/);
  assert.match(workflow, /node tools\/remote-panel-release-gate\.mjs --mode implementation/);
  assert.match(workflow, /echo "\$\{GITHUB_SHA\}" > "\$STAGE\/RELEASE_COMMIT"/);
});
