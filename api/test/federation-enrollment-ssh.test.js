'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  FederationEnrollmentSshService,
  federationBootstrapCommand,
  federationInstallCommand,
  federationRuntimeProbeCommand,
} = require('../src/federation/federation-enrollment-ssh.service');
const {
  generateFederationManifestKey,
} = require('../src/federation/federation-key-material');

const ENROLLMENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const FINGERPRINT = `SHA256:${Buffer.alloc(32, 17).toString('base64').replace(/=+$/, '')}`;

function input() {
  return {
    enrollmentId: ENROLLMENT_ID,
    sshHost: '8.8.4.4',
    sshPort: 2222,
    sshPassword: 'fixture-password',
    sshFingerprint: FINGERPRINT,
  };
}

function mockedService(probeResults) {
  const service = new FederationEnrollmentSshService();
  const calls = { commands: [], writes: [], unlinks: [], ended: 0 };
  const connection = { end: () => { calls.ended += 1; } };
  service.resolveAddress = async () => '8.8.4.4';
  service.connect = async () => connection;
  service.openSftp = async () => ({});
  service.writeFile = async (_sftp, remotePath, content, mode) => {
    calls.writes.push({ remotePath, content, mode });
  };
  service.unlinkIfPresent = async (_sftp, remotePath) => {
    calls.unlinks.push(remotePath);
  };
  service.exec = async (_connection, command, timeoutMs, captureOutput) => {
    calls.commands.push({ command, timeoutMs, captureOutput });
    if (command === federationRuntimeProbeCommand()) return probeResults.shift();
    return '';
  };
  return { calls, service };
}

test('T-PROV-001 missing runtime installs pinned release and re-probes before enrollment', async () => {
  const { calls, service } = mockedService(['missing', 'release']);
  const result = await service.ensureTargetRuntime(input());
  const version = fs.readFileSync(path.resolve(__dirname, '../../VERSION'), 'utf8').trim();
  const remotePath = `/tmp/meowbox-federation-bootstrap-${ENROLLMENT_ID}.sh`;
  assert.deepEqual(result, { installed: true });
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].remotePath, remotePath);
  assert.equal(calls.writes[0].mode, 0o700);
  assert.match(calls.writes[0].content.toString('utf8', 0, 32), /^#!\/usr\/bin\/env bash/);
  assert.deepEqual(calls.unlinks, [remotePath]);
  assert.equal(calls.ended, 1);
  const install = calls.commands.find(({ command }) => command !== federationRuntimeProbeCommand());
  assert.equal(install.command, federationInstallCommand(remotePath, version));
  assert.equal(install.timeoutMs, 15 * 60_000);
  assert.equal(install.captureOutput, false);
  assert.equal(install.command.includes(input().sshPassword), false);
  assert.match(install.command, /--installation-role target$/);
});

test('T-PROV-002 existing runtime is preserved and dev-mode fails closed', async () => {
  const existing = mockedService(['release']);
  assert.deepEqual(await existing.service.ensureTargetRuntime(input()), { installed: false });
  assert.equal(existing.calls.writes.length, 0);
  assert.equal(existing.calls.ended, 1);

  const devMode = mockedService(['dev-mode']);
  await assert.rejects(
    () => devMode.service.ensureTargetRuntime(input()),
    (error) => error?.code === 'SSH_TARGET_DEV_MODE',
  );
  assert.equal(devMode.calls.writes.length, 0);
  assert.equal(devMode.calls.ended, 1);
});

test('T-PROV-003 SSH shell command builders reject injected paths and versions', () => {
  const requestPath = `/tmp/meowbox-federation-enrollment-${ENROLLMENT_ID}.json`;
  assert.match(federationBootstrapCommand(requestPath), /federation-enrollment-bootstrap\.cli\.js/);
  assert.throws(() => federationBootstrapCommand(`${requestPath};id`), /request path is invalid/);
  assert.throws(
    () => federationInstallCommand(`/tmp/meowbox-federation-bootstrap-${ENROLLMENT_ID}.sh`, 'latest;id'),
    /release version is invalid/,
  );
  const bootstrap = fs.readFileSync(path.resolve(__dirname, '../../bootstrap.sh'), 'utf8');
  assert.match(
    bootstrap,
    /current\/install\.sh" --release-mode "\$@"/,
    'same-version bootstrap must preserve installation-role arguments',
  );
});

test('T-PROV-003 bootstrap reloads PM2 even after an earlier config acknowledgement was lost', async () => {
  const service = new FederationEnrollmentSshService();
  const targetId = '11111111-2222-4333-8444-555555555555';
  const manifestKey = generateFederationManifestKey(targetId);
  const expiresAt = new Date(Date.now() + 5 * 60_000);
  const commands = [];
  let ended = 0;
  service.resolveAddress = async () => '8.8.4.4';
  service.connect = async () => ({ end: () => { ended += 1; } });
  service.openSftp = async () => ({});
  service.writeFile = async () => undefined;
  service.unlinkIfPresent = async () => undefined;
  service.exec = async (_connection, command) => {
    commands.push(command);
    if (command === federationRuntimeProbeCommand()) return 'release';
    if (command === 'pm2 reload meowbox-api --update-env') return '';
    return JSON.stringify({
      schemaVersion: 1,
      enrollment: {
        id: ENROLLMENT_ID,
        state: 'SSH_VERIFIED',
        expiresAt: expiresAt.toISOString(),
      },
      target: {
        installationId: targetId,
        installationRole: 'TARGET',
        manifestKid: manifestKey.kid,
        manifestPublicKeySpki: manifestKey.publicKeySpki,
        configurationChanged: false,
      },
    });
  };
  const result = await service.prepareTargetBootstrap({
    ...input(),
    requestedDisplayName: 'Fixture target',
    proof: Buffer.alloc(32, 9),
    expiresAt,
    apiOrigin: 'https://8.8.8.8',
    wsOrigin: 'https://8.8.8.8',
    wsPath: '/socket.io',
    browserPublicOrigin: 'https://8.8.8.8',
    directTransferOrigin: 'https://8.8.8.8',
  });
  assert.equal(result.targetInstallationId, targetId);
  assert.equal(commands.filter((command) => command === 'pm2 reload meowbox-api --update-env').length, 1);
  assert.equal(ended, 1);
});
