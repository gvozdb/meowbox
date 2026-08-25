'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PrismaClient } = require('@prisma/client');

test('T-PROV-001 SSH bootstrap CLI consumes mode-0600 request and persists hash only', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-enrollment-cli-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(stateDir, 'data'), { recursive: true });
  const databasePath = path.join(root, 'fixture.db');
  const databaseUrl = `file:${databasePath}`;
  execFileSync(path.resolve(__dirname, '../node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'ignore',
  });
  const envFile = path.join(stateDir, '.env');
  fs.writeFileSync(envFile, [
    `DATABASE_URL="${databaseUrl}"`,
    `MEOWBOX_MASTER_KEY="${Buffer.alloc(32, 81).toString('base64')}"`,
    'MEOWBOX_INSTALLATION_ROLE="MASTER"',
    'UNRELATED_FIXTURE_VALUE="preserved"',
    'PRISMA_LOG_QUERIES=false',
    '',
  ].join('\n'), { mode: 0o600 });
  const seedPrisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await seedPrisma.panelIdentity.create({
    data: {
      id: '_',
      installationId: randomUUID(),
      installationRole: 'MASTER',
    },
  });
  await seedPrisma.$disconnect();
  const enrollmentId = randomUUID();
  const proof = randomBytes(32);
  const requestPath = `/tmp/meowbox-federation-enrollment-${enrollmentId}.json`;
  fs.writeFileSync(requestPath, JSON.stringify({
    schemaVersion: 1,
    enrollmentId,
    requestedDisplayName: 'CLI target',
    sshHost: '8.8.4.4',
    sshPort: 2222,
    sshFingerprint: `SHA256:${Buffer.alloc(32, 82).toString('base64').replace(/=+$/, '')}`,
    proof: proof.toString('base64url'),
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    apiOrigin: 'https://8.8.8.8',
    wsOrigin: 'https://8.8.8.8',
    wsPath: '/socket.io',
    browserPublicOrigin: 'https://8.8.8.8',
    directTransferOrigin: 'https://8.8.8.8',
  }), { mode: 0o600 });
  fs.chmodSync(requestPath, 0o600);
  t.after(() => {
    if (fs.existsSync(requestPath)) fs.rmSync(requestPath);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const output = execFileSync(process.execPath, [
    `--env-file=${envFile}`,
    '-r',
    'ts-node/register',
    '-r',
    '../tools/register-shared-source.js',
    'src/federation/federation-enrollment-bootstrap.cli.ts',
    `--request-file=${requestPath}`,
  ], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      MEOWBOX_STATE_DIR: stateDir,
      MEOWBOX_INSTALLATION_ROLE: 'MASTER',
      TS_NODE_TRANSPILE_ONLY: '1',
    },
    encoding: 'utf8',
  });
  const response = JSON.parse(output);
  assert.equal(response.schemaVersion, 1);
  assert.equal(response.enrollment.id, enrollmentId);
  assert.equal(response.target.installationRole, 'TARGET');
  assert.equal(response.target.configurationChanged, true);
  assert.equal(fs.existsSync(requestPath), false);
  const patchedEnv = fs.readFileSync(envFile, 'utf8');
  assert.match(patchedEnv, /^MEOWBOX_INSTALLATION_ROLE=TARGET$/m);
  assert.match(patchedEnv, /^FEDERATION_API_ORIGIN=https:\/\/8\.8\.8\.8$/m);
  assert.match(patchedEnv, /^FEDERATION_WS_PATH=\/socket\.io$/m);
  assert.match(patchedEnv, /^UNRELATED_FIXTURE_VALUE="preserved"$/m);
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const row = await prisma.federationEnrollment.findUniqueOrThrow({ where: { id: enrollmentId } });
    const identity = await prisma.panelIdentity.findUniqueOrThrow({ where: { id: '_' } });
    assert.equal(identity.installationRole, 'TARGET');
    assert.match(row.bootstrapHash, /^[0-9a-f]{64}$/);
    assert.equal(row.bootstrapSecretEnc, null);
    assert.equal(JSON.stringify(row).includes(proof.toString('base64url')), false);
  } finally {
    await prisma.$disconnect();
  }
});
