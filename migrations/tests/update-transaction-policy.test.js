'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const policy = path.join(root, 'tools', 'release-transaction-policy.sh');
const updater = path.join(root, 'tools', 'update.sh');
const bootstrapUpdater = path.join(root, 'tools', 'bootstrap-release-update.sh');
const releaseRecovery = path.join(root, 'tools', 'recover-missing-release.sh');
const releaseWorkflow = path.join(root, '.github', 'workflows', 'release.yml');
const apiPackage = path.join(root, 'api', 'package.json');
const prismaBridge = path.join(root, 'api', 'scripts', 'prisma-legacy-bridge.cjs');

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

test('release workflow packs migration compatibility required by the updater', () => {
  const updaterSource = fs.readFileSync(updater, 'utf8');
  const workflowSource = fs.readFileSync(releaseWorkflow, 'utf8');
  const contract = 'migrations/release/supported-baselines.json';

  assert.match(updaterSource, new RegExp(contract.replaceAll('/', '\\/')));
  assert.match(
    workflowSource,
    /cp migrations\/release\/supported-baselines\.json "\$STAGE\/migrations\/release\/"/,
  );
  assert.match(
    workflowSource,
    /test -f "\$STAGE\/migrations\/dist\/system-plan-compat\.js"/,
  );
});

test('legacy bootstrap verifies the artifact and bypasses prisma db push', () => {
  const source = fs.readFileSync(bootstrapUpdater, 'utf8');
  execFileSync('bash', ['-n', bootstrapUpdater]);

  assert.match(source, /sha256sum "\$TARBALL"/);
  assert.match(source, /MEOWBOX_UPDATE_CANDIDATE_DIR="\$CANDIDATE"/);
  assert.match(source, /bash "\$CANDIDATE\/tools\/update\.sh" "\$TARGET"/);
  assert.doesNotMatch(source, /npx\s+prisma\s+db\s+push/);
  assert.match(source, /panel current release target is missing/);
});

test('detached transactional tools share an explicit production panel root', () => {
  for (const relative of [
    'tools/update.sh',
    'tools/rollback.sh',
    'tools/snapshot.sh',
    'tools/healthcheck.sh',
  ]) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.match(source, /PANEL_DIR="\$\{MEOWBOX_PANEL_DIR:-/);
  }
});

test('release publishes the standalone legacy bootstrap with a separate checksum', () => {
  const source = fs.readFileSync(releaseWorkflow, 'utf8');
  assert.match(source, /meowbox-bootstrap-\$\{\{ steps\.ver\.outputs\.version \}\}\.sh/);
  assert.match(source, /meowbox-bootstrap-\$\{\{ steps\.ver\.outputs\.version \}\}\.sh\.sha256/);
  assert.match(source, /meowbox-recover-\$\{\{ steps\.ver\.outputs\.version \}\}\.sh/);
  assert.match(source, /meowbox-recover-\$\{\{ steps\.ver\.outputs\.version \}\}\.sh\.sha256/);
});

test('standalone recovery only rehydrates a dangling exact release', () => {
  const source = fs.readFileSync(releaseRecovery, 'utf8');
  execFileSync('bash', ['-n', releaseRecovery]);

  assert.match(source, /if \[\[ -d "\$CURRENT_LINK" \]\]/);
  assert.match(source, /release checksum verification failed/);
  assert.match(source, /mv -- "\$STAGE_DIR" "\$MISSING_RELEASE"/);
  assert.match(source, /persistent database, configuration, Nginx and PM2 were not changed/);
  assert.doesNotMatch(source, /prisma\s+(?:db\s+push|migrate\s+deploy)/);
  assert.doesNotMatch(source, /pm2\s+(?:start|restart|reload|delete)/);
  assert.doesNotMatch(source, /systemctl/);
});

test('release artifact installs the guarded legacy panel bridge', () => {
  const workflowSource = fs.readFileSync(releaseWorkflow, 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(apiPackage, 'utf8'));
  const bridgeSource = fs.readFileSync(prismaBridge, 'utf8');

  assert.equal(packageJson.scripts.postinstall, 'node scripts/install-prisma-legacy-bridge.cjs');
  assert.equal(packageJson.dependencies.prisma, '^5.19.0');
  assert.match(workflowSource, /legacy-panel-update-bridge\.json/);
  assert.match(workflowSource, /cp -r api\/scripts "\$STAGE\/api\/"/);
  assert.match(bridgeSource, /args\[0\] === 'db' && args\[1\] === 'push'/);
  assert.match(bridgeSource, /compareVersions\(parsedCurrentVersion, minimumLegacyVersion\)/);
  assert.match(bridgeSource, /snapshot-backed transactional migration/);
  assert.match(bridgeSource, /\.legacy-rollback-/);
  assert.match(bridgeSource, /atomicSwitchCurrent\(protectedRelease\)/);
  assert.match(bridgeSource, /spawnSync\('\/bin\/cp', \['-a', '-l'/);
  assert.doesNotMatch(bridgeSource, /releaseCli,\s*'baseline'/);
  assert.match(bridgeSource, /MEOWBOX_LEGACY_BRIDGE_SOURCE_DIR: releaseDir/);
  assert.doesNotMatch(bridgeSource, /--force-reset/);
});

test('transactional updater never prunes release directories from an EXIT trap', () => {
  const source = fs.readFileSync(updater, 'utf8');
  assert.doesNotMatch(source, /trap\s+['"][^'"\n]*cleanup_old_releases/);
  assert.doesNotMatch(source, /rm\s+-rf\s+--?\s+"\$RELEASES_DIR\//);
});

test('transactional updater only replaces an explicitly verified legacy candidate', () => {
  const source = fs.readFileSync(updater, 'utf8');
  assert.match(source, /MEOWBOX_LEGACY_PANEL_BRIDGE/);
  assert.match(source, /legacy bridge source must be the verified releases\/\$TARGET candidate/);
  assert.match(source, /LEGACY_BRIDGE_RETIRED_SOURCE="\$TX_DIR\/legacy-bridge-source"/);
  assert.match(source, /retired legacy updater candidate removed after committed health checks/);
});

test('pre-commit rollback resumes the gate from the retained candidate', () => {
  const source = fs.readFileSync(updater, 'utf8');
  assert.match(source, /failed-candidate-\$TARGET/);
  assert.match(
    source,
    /resume --transaction "\$TRANSACTION_ID" \\\n+\s+--candidate "\$resume_candidate" --database "\$DB_FILE"/,
  );
});

test('preflight records unreachable HTTP probes instead of blocking the transaction', () => {
  const source = fs.readFileSync(updater, 'utf8');
  assert.match(source, /status = 0/);
  assert.doesNotMatch(source, /HTTP probe baseline is unreachable/);
});
