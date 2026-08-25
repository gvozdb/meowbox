import assert from 'node:assert/strict';
import {
  createHash,
  generateKeyPairSync,
} from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ACTIVATION_GATE_CHECKS,
  ACTIVATION_GATE_IDS,
  canonicalJson,
  createActivationEvidenceTemplate,
  signActivationEvidenceReport,
  verifyActivationEvidenceBundle,
} from '../../../tools/remote-panel-activation-evidence.mjs';

const RELEASE_VERSION = 'v0.7.36';
const REPOSITORY_COMMIT = 'a'.repeat(40);

function metricsFor(gateId, checkId) {
  if (gateId === 'T-PUBLIC-LOAD' && checkId === 'logical-50gib') {
    return { 'logical-bytes': 50 * 1024 ** 3 };
  }
  if (gateId === 'T-PUBLIC-LOAD' && checkId === 'range-checksum-abort') {
    return { 'checksum-mismatches': 0 };
  }
  if (gateId === 'T-PUBLIC-LOAD' && checkId === 'rss-budget') {
    return { 'rss-increase-mib': 127.5 };
  }
  if (gateId === 'T-PUBLIC-LOAD' && checkId === 'disk-reserve') {
    return { 'reserve-breaches': 0 };
  }
  if (gateId === 'T-CAN-24H' && checkId === 'canary-5pct-24h') {
    return { 'eligible-volume-percent': 5 };
  }
  if (gateId === 'T-CAN-24H' && checkId === 'canary-25pct-24h') {
    return { 'eligible-volume-percent': 25 };
  }
  if (gateId === 'T-CAN-24H' && checkId === 'security-stops-zero') {
    return { 'stop-count': 0 };
  }
  if (gateId === 'T-CAN-24H' && checkId === 'rolling-thresholds-green') {
    return { 'breach-count': 0 };
  }
  return {};
}

async function createEvidenceBundle(root) {
  const evidenceRoot = join(root, 'evidence');
  const artifactRoot = join(evidenceRoot, 'artifacts');
  await mkdir(artifactRoot, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyFile = join(root, 'operator-private.pem');
  const publicKeyFile = join(root, 'operator-public.pem');
  await writeFile(privateKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await writeFile(publicKeyFile, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });

  const completed = Date.now() - 5_000;
  for (const gateId of ACTIVATION_GATE_IDS) {
    const artifactRelative = `artifacts/${gateId}.txt`;
    const artifact = Buffer.from(`${gateId} redacted isolated fixture evidence\n`);
    await writeFile(join(evidenceRoot, artifactRelative), artifact, { mode: 0o600 });
    const report = createActivationEvidenceTemplate(gateId);
    report.artifacts = [{
      kind: 'report',
      path: artifactRelative,
      sha256: createHash('sha256').update(artifact).digest('hex'),
      sizeBytes: artifact.length,
    }];
    report.checks = ACTIVATION_GATE_CHECKS[gateId].map((id) => ({
      durationSeconds: gateId === 'T-CAN-24H' && id.startsWith('canary-') ? 86_400 : 60,
      id,
      metrics: metricsFor(gateId, id),
      result: 'PASS',
      sampleSize: 250,
    }));
    report.completedAt = new Date(completed).toISOString();
    report.fixture.id = 'rpp-activation-fixture-001';
    report.operatorApproved = true;
    report.redactionConfirmed = true;
    report.releaseVersion = RELEASE_VERSION;
    report.repositoryCommit = REPOSITORY_COMMIT;
    report.result = 'PASS';
    report.startedAt = new Date(completed - (gateId === 'T-CAN-24H' ? 49 * 60 * 60 * 1000 : 60 * 60 * 1000)).toISOString();
    const unsignedFile = join(root, `${gateId}.unsigned.json`);
    await writeFile(unsignedFile, canonicalJson(report, true), { mode: 0o600 });
    signActivationEvidenceReport(
      unsignedFile,
      join(evidenceRoot, `${gateId}.json`),
      privateKeyFile,
    );
  }
  return { evidenceRoot, privateKeyFile, publicKeyFile };
}

test('T-CAN-001 verifies a complete content-addressed Ed25519 evidence bundle', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'meowbox-rpp-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = await createEvidenceBundle(root);
  const result = verifyActivationEvidenceBundle(bundle.evidenceRoot, bundle.publicKeyFile);
  assert.equal(result.activationReady, true);
  assert.equal(result.releaseVersion, RELEASE_VERSION);
  assert.equal(result.repositoryCommit, REPOSITORY_COMMIT);
  assert.deepEqual(Object.keys(result.statuses), ACTIVATION_GATE_IDS);
  assert.ok(Object.values(result.statuses).every((status) => status === 'PASS'));
});

test('activation evidence fails closed after report or artifact tampering', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'meowbox-rpp-evidence-tamper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = await createEvidenceBundle(root);
  const reportFile = join(bundle.evidenceRoot, 'T-SIG-REAL.json');
  const report = JSON.parse(await readFile(reportFile, 'utf8'));
  report.checks[0].sampleSize += 1;
  await writeFile(reportFile, canonicalJson(report, true));
  assert.throws(
    () => verifyActivationEvidenceBundle(bundle.evidenceRoot, bundle.publicKeyFile, 'T-SIG-REAL'),
    /SIGNATURE_INVALID/,
  );

  const fresh = await createEvidenceBundle(await mkdtemp(join(root, 'fresh-')));
  await writeFile(join(fresh.evidenceRoot, 'artifacts', 'T-DIAL-REAL.txt'), 'tampered\n');
  assert.throws(
    () => verifyActivationEvidenceBundle(fresh.evidenceRoot, fresh.publicKeyFile, 'T-DIAL-REAL'),
    /ARTIFACT_SIZE|ARTIFACT_DIGEST/,
  );
});

test('templates cannot be signed as PASS evidence without measured checks and approval', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'meowbox-rpp-evidence-template-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { privateKey } = generateKeyPairSync('ed25519');
  const privateKeyFile = join(root, 'private.pem');
  const inputFile = join(root, 'template.json');
  await writeFile(privateKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await writeFile(inputFile, canonicalJson(createActivationEvidenceTemplate('T-REL-CLEAN'), true));
  assert.throws(
    () => signActivationEvidenceReport(inputFile, join(root, 'signed.json'), privateKeyFile),
    /GATE_FAILED|INVALID_BOOLEAN/,
  );
});
