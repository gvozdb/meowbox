#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
} from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ACTIVATION_EVIDENCE_SCHEMA = 'meowbox.remote-panel-activation-evidence/v1';

export const ACTIVATION_GATE_CHECKS = Object.freeze({
  'T-SIG-REAL': Object.freeze([
    'exact-request-target',
    'body-digest',
    'header-canonicalization',
    'replay-rejection',
  ]),
  'T-DIAL-REAL': Object.freeze([
    'all-address-validation',
    'selected-address-pinning',
    'tls-ca-hostname-spki',
    'redirect-refusal',
    'http-ws-parity',
  ]),
  'T-ADM-REAL': Object.freeze([
    'node-php-aes-gcm',
    'atomic-consume',
    'expiry-replay',
    'cookie-flags-bounds',
    'browser-reachability',
  ]),
  'T-OPS-REAL': Object.freeze([
    'sqlite-wal-claims',
    'lease-recovery',
    'process-group-ownership',
    'cancel-escalation',
    'unsafe-loss-needs-attention',
  ]),
  'T-PUBLIC-LOAD': Object.freeze([
    'logical-50gib',
    'range-checksum-abort',
    'rss-budget',
    'disk-reserve',
    'vpn-parser-bounds',
    'webhook-spool-retry-dlq',
  ]),
  'T-PROV-PA-REAL': Object.freeze([
    'fresh-no-admin',
    'existing-env-custom-port',
    'manifest-before-commit',
    'projection-recovery',
    'panel-access-cutover-rollback',
    'ssh-recovery',
  ]),
  'T-REL-CLEAN': Object.freeze([
    'clean-install',
    'aggregate-suites',
    'migration-expand-repeat',
    'package-contract',
    'artifact-checksum',
    'rollback-floor',
  ]),
  'T-CAN-24H': Object.freeze([
    'isolated-target',
    'canary-5pct-24h',
    'canary-25pct-24h',
    'security-stops-zero',
    'rolling-thresholds-green',
  ]),
});

export const ACTIVATION_GATE_IDS = Object.freeze(Object.keys(ACTIVATION_GATE_CHECKS));

const REPORT_KEYS = Object.freeze([
  'artifacts',
  'checks',
  'completedAt',
  'fixture',
  'gateId',
  'operatorApproved',
  'redactionConfirmed',
  'releaseVersion',
  'repositoryCommit',
  'result',
  'schemaVersion',
  'signature',
  'signerKeySha256',
  'startedAt',
]);
const UNSIGNED_REPORT_KEYS = REPORT_KEYS.filter((key) => key !== 'signature');
const FIXTURE_KEYS = Object.freeze([
  'devMode',
  'id',
  'kind',
  'networkScope',
  'production',
  'productionStateTouched',
  'topology',
]);
const CHECK_KEYS = Object.freeze(['durationSeconds', 'id', 'metrics', 'result', 'sampleSize']);
const ARTIFACT_KEYS = Object.freeze(['kind', 'path', 'sha256', 'sizeBytes']);
const SIGNATURE_KEYS = Object.freeze(['algorithm', 'value']);
const SAFE_ARTIFACT_KINDS = new Set([
  'report',
  'metrics',
  'checksum',
  'log-redacted',
  'config-redacted',
]);
const MAX_REPORT_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACTS = 32;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const SENSITIVE_TEXT_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/iu,
  /\b(?:authorization|proxy-authorization|cookie|set-cookie|x-proxy-token)\s*:/iu,
  /\b(?:access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret|password)\s*[=:]/iu,
  /\bhttps?:\/\//iu,
  /\b(?:raw[_-]?body|request[_-]?body)\s*[=:]/iu,
]);

function fail(code, message) {
  throw new Error(`${code}: ${message}`);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expected, label) {
  if (!isPlainObject(value)) fail('INVALID_OBJECT', `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail('UNKNOWN_FIELD', `${label} fields must be exactly: ${wanted.join(', ')}`);
  }
}

function assertSafeText(value, label, { max = 256, pattern } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    fail('INVALID_TEXT', `${label} must be 1-${max} characters`);
  }
  if (CONTROL_PATTERN.test(value)) fail('CONTROL_CHARACTER', `${label} contains a control character`);
  if (pattern && !pattern.test(value)) fail('INVALID_TEXT', `${label} has an invalid format`);
  return value;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
  );
}

export function canonicalJson(value, pretty = false) {
  return `${JSON.stringify(canonicalValue(value), null, pretty ? 2 : undefined)}${pretty ? '\n' : ''}`;
}

function parseCanonicalJson(file, maxBytes = MAX_REPORT_BYTES) {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail('UNSAFE_FILE', `${file} must be a regular non-symlink file`);
  }
  if (metadata.size <= 0 || metadata.size > maxBytes) {
    fail('FILE_SIZE', `${file} exceeds the evidence size budget`);
  }
  const source = readFileSync(file, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail('INVALID_JSON', `${file} is not valid JSON`);
  }
  if (source !== canonicalJson(parsed, true)) {
    fail('NON_CANONICAL_JSON', `${file} must use canonical sorted JSON with one trailing newline`);
  }
  return parsed;
}

function parseDate(value, label) {
  assertSafeText(value, label, { max: 32 });
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    fail('INVALID_TIMESTAMP', `${label} must be an ISO-8601 UTC timestamp`);
  }
  return timestamp;
}

function assertBoolean(value, expected, label) {
  if (value !== expected) fail('INVALID_BOOLEAN', `${label} must be ${String(expected)}`);
}

function assertInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('INVALID_INTEGER', `${label} must be an integer from ${min} to ${max}`);
  }
}

function validateMetrics(metrics, label) {
  if (!isPlainObject(metrics) || Object.keys(metrics).length > 64) {
    fail('INVALID_METRICS', `${label} must be a bounded object`);
  }
  for (const [key, value] of Object.entries(metrics)) {
    if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(key)) {
      fail('INVALID_METRIC_NAME', `${label}.${key} is invalid`);
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('INVALID_METRIC_VALUE', `${label}.${key} must be finite`);
    } else if (typeof value !== 'boolean') {
      fail('INVALID_METRIC_VALUE', `${label}.${key} must be numeric or boolean`);
    }
  }
}

function metric(checks, checkId, name) {
  const check = checks.get(checkId);
  if (!Object.hasOwn(check.metrics, name)) {
    fail('MISSING_METRIC', `${checkId} requires metric ${name}`);
  }
  return check.metrics[name];
}

function validateGateMetrics(gateId, checks) {
  if (gateId === 'T-PUBLIC-LOAD') {
    if (metric(checks, 'logical-50gib', 'logical-bytes') < 50 * 1024 ** 3) {
      fail('LOAD_BUDGET', 'logical-50gib did not cover 50 GiB');
    }
    if (metric(checks, 'range-checksum-abort', 'checksum-mismatches') !== 0) {
      fail('CHECKSUM_MISMATCH', 'transfer evidence contains a checksum mismatch');
    }
    if (metric(checks, 'rss-budget', 'rss-increase-mib') >= 128) {
      fail('RSS_BUDGET', 'transfer RSS increase reached the stop threshold');
    }
    if (metric(checks, 'disk-reserve', 'reserve-breaches') !== 0) {
      fail('DISK_RESERVE', 'staging disk reserve was breached');
    }
  }
  if (gateId === 'T-CAN-24H') {
    const five = checks.get('canary-5pct-24h');
    const twentyFive = checks.get('canary-25pct-24h');
    if (five.durationSeconds < 86_400 || twentyFive.durationSeconds < 86_400) {
      fail('CANARY_DURATION', 'both canary stages require at least 24 hours');
    }
    const fivePercent = metric(checks, 'canary-5pct-24h', 'eligible-volume-percent');
    const twentyFivePercent = metric(checks, 'canary-25pct-24h', 'eligible-volume-percent');
    if (!(fivePercent > 0 && fivePercent <= 5)) {
      fail('CANARY_VOLUME', 'first canary must be within (0, 5] percent');
    }
    if (!(twentyFivePercent > 5 && twentyFivePercent <= 25)) {
      fail('CANARY_VOLUME', 'second canary must be within (5, 25] percent');
    }
    if (metric(checks, 'security-stops-zero', 'stop-count') !== 0) {
      fail('SECURITY_STOP', 'security stop evidence is non-zero');
    }
    if (metric(checks, 'rolling-thresholds-green', 'breach-count') !== 0) {
      fail('ROLLING_STOP', 'rolling stop evidence is non-zero');
    }
  }
}

function validateFixture(fixture) {
  assertExactKeys(fixture, FIXTURE_KEYS, 'fixture');
  assertSafeText(fixture.id, 'fixture.id', { max: 128, pattern: /^[a-z0-9][a-z0-9._-]*$/u });
  if (fixture.kind !== 'isolated-fixture') fail('FIXTURE_KIND', 'fixture.kind must be isolated-fixture');
  if (!['loopback-only', 'isolated-namespace'].includes(fixture.networkScope)) {
    fail('FIXTURE_NETWORK', 'fixture.networkScope must be loopback-only or isolated-namespace');
  }
  if (fixture.topology !== 'PUBLIC') fail('TOPOLOGY', 'activation evidence must cover PUBLIC topology');
  assertBoolean(fixture.production, false, 'fixture.production');
  assertBoolean(fixture.productionStateTouched, false, 'fixture.productionStateTouched');
  assertBoolean(fixture.devMode, false, 'fixture.devMode');
}

function validateChecks(gateId, checks) {
  if (!Array.isArray(checks)) fail('INVALID_CHECKS', 'checks must be an array');
  const required = ACTIVATION_GATE_CHECKS[gateId];
  if (checks.length !== required.length) {
    fail('CHECK_COUNT', `${gateId} requires exactly ${required.length} checks`);
  }
  const byId = new Map();
  for (const [index, check] of checks.entries()) {
    assertExactKeys(check, CHECK_KEYS, `checks[${index}]`);
    assertSafeText(check.id, `checks[${index}].id`, { max: 96, pattern: /^[a-z][a-z0-9-]*$/u });
    if (byId.has(check.id) || !required.includes(check.id)) {
      fail('UNKNOWN_CHECK', `${gateId} contains duplicate or unknown check ${check.id}`);
    }
    if (check.result !== 'PASS') fail('CHECK_FAILED', `${gateId}/${check.id} is not PASS`);
    assertInteger(check.durationSeconds, `${gateId}/${check.id}.durationSeconds`, { max: 31_536_000 });
    assertInteger(check.sampleSize, `${gateId}/${check.id}.sampleSize`, { min: 1, max: 1_000_000_000 });
    validateMetrics(check.metrics, `${gateId}/${check.id}.metrics`);
    byId.set(check.id, check);
  }
  for (const checkId of required) {
    if (!byId.has(checkId)) fail('MISSING_CHECK', `${gateId} is missing ${checkId}`);
  }
  validateGateMetrics(gateId, byId);
  return byId;
}

function artifactPath(evidenceRoot, relativePath) {
  assertSafeText(relativePath, 'artifact.path', { max: 240, pattern: /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u });
  if (path.isAbsolute(relativePath) || relativePath.split('/').includes('..') || relativePath.includes('\\')) {
    fail('ARTIFACT_PATH', 'artifact.path must be a safe relative path');
  }
  const root = realpathSync(evidenceRoot);
  const candidate = path.resolve(root, relativePath);
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail('ARTIFACT_ESCAPE', 'artifact escapes evidence root');
  const metadata = lstatSync(candidate);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail('UNSAFE_ARTIFACT', `${relativePath} must be a regular non-symlink file`);
  }
  if (realpathSync(candidate) !== candidate) fail('ARTIFACT_SYMLINK', `${relativePath} resolves through a symlink`);
  return { candidate, metadata };
}

function scanRedactedArtifact(contents, relativePath) {
  if (contents.includes(0)) fail('BINARY_ARTIFACT', `${relativePath} must be a redacted text artifact`);
  const text = contents.toString('utf8');
  if (Buffer.byteLength(text, 'utf8') !== contents.length || text.includes('\ufffd')) {
    fail('ARTIFACT_ENCODING', `${relativePath} must be valid UTF-8`);
  }
  for (const pattern of SENSITIVE_TEXT_PATTERNS) {
    if (pattern.test(text)) fail('SENSITIVE_ARTIFACT', `${relativePath} contains forbidden sensitive material`);
  }
}

function validateArtifacts(artifacts, evidenceRoot) {
  if (!Array.isArray(artifacts) || artifacts.length === 0 || artifacts.length > MAX_ARTIFACTS) {
    fail('INVALID_ARTIFACTS', `artifacts must contain 1-${MAX_ARTIFACTS} entries`);
  }
  const seen = new Set();
  for (const [index, artifact] of artifacts.entries()) {
    assertExactKeys(artifact, ARTIFACT_KEYS, `artifacts[${index}]`);
    if (!SAFE_ARTIFACT_KINDS.has(artifact.kind)) fail('ARTIFACT_KIND', `${artifact.kind} is not allowed`);
    if (seen.has(artifact.path)) fail('DUPLICATE_ARTIFACT', artifact.path);
    seen.add(artifact.path);
    if (!/^[a-f0-9]{64}$/u.test(artifact.sha256)) fail('ARTIFACT_DIGEST', `${artifact.path} has invalid SHA-256`);
    assertInteger(artifact.sizeBytes, `${artifact.path}.sizeBytes`, { min: 1, max: MAX_ARTIFACT_BYTES });
    const { candidate, metadata } = artifactPath(evidenceRoot, artifact.path);
    if (metadata.size !== artifact.sizeBytes) fail('ARTIFACT_SIZE', `${artifact.path} size changed`);
    const contents = readFileSync(candidate);
    const digest = createHash('sha256').update(contents).digest('hex');
    if (digest !== artifact.sha256) fail('ARTIFACT_DIGEST', `${artifact.path} digest changed`);
    scanRedactedArtifact(contents, artifact.path);
  }
}

function publicKeyFingerprint(publicKey) {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

function loadEd25519PublicKey(file) {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail('PUBLIC_KEY_FILE', 'public key must be a regular file');
  const key = createPublicKey(readFileSync(file));
  if (key.asymmetricKeyType !== 'ed25519') fail('PUBLIC_KEY_TYPE', 'public key must be Ed25519');
  return key;
}

function validateReportShape(report, { signed }) {
  assertExactKeys(report, signed ? REPORT_KEYS : UNSIGNED_REPORT_KEYS, 'report');
  if (report.schemaVersion !== ACTIVATION_EVIDENCE_SCHEMA) fail('SCHEMA_VERSION', 'unsupported evidence schema');
  if (!ACTIVATION_GATE_IDS.includes(report.gateId)) fail('UNKNOWN_GATE', String(report.gateId));
  if (report.result !== 'PASS') fail('GATE_FAILED', `${report.gateId} is not PASS`);
  assertBoolean(report.operatorApproved, true, 'operatorApproved');
  assertBoolean(report.redactionConfirmed, true, 'redactionConfirmed');
  assertSafeText(report.releaseVersion, 'releaseVersion', {
    max: 64,
    pattern: /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u,
  });
  assertSafeText(report.repositoryCommit, 'repositoryCommit', { max: 40, pattern: /^[a-f0-9]{40}$/u });
  assertSafeText(report.signerKeySha256, 'signerKeySha256', { max: 64, pattern: /^[a-f0-9]{64}$/u });
  const startedAt = parseDate(report.startedAt, 'startedAt');
  const completedAt = parseDate(report.completedAt, 'completedAt');
  if (completedAt < startedAt) fail('TIMESTAMP_ORDER', 'completedAt precedes startedAt');
  if (completedAt > Date.now() + MAX_FUTURE_SKEW_MS) fail('FUTURE_EVIDENCE', 'completedAt is in the future');
  validateFixture(report.fixture);
  const checks = validateChecks(report.gateId, report.checks);
  const elapsedSeconds = Math.floor((completedAt - startedAt) / 1000);
  const longestCheck = Math.max(...report.checks.map(({ durationSeconds }) => durationSeconds));
  if (longestCheck > elapsedSeconds) {
    fail('DURATION_MISMATCH', 'check duration exceeds the signed report interval');
  }
  if (report.gateId === 'T-CAN-24H') {
    const canaryDuration = checks.get('canary-5pct-24h').durationSeconds +
      checks.get('canary-25pct-24h').durationSeconds;
    if (canaryDuration > elapsedSeconds) {
      fail('CANARY_INTERVAL', 'the two canary stages do not fit the signed report interval');
    }
    if (checks.get('canary-5pct-24h').sampleSize < 200 ||
        checks.get('canary-25pct-24h').sampleSize < 200) {
      fail('CANARY_SAMPLE', 'each canary stage requires at least 200 requests');
    }
  }
  if (signed) {
    assertExactKeys(report.signature, SIGNATURE_KEYS, 'signature');
    if (report.signature.algorithm !== 'Ed25519') fail('SIGNATURE_ALGORITHM', 'signature must use Ed25519');
    assertSafeText(report.signature.value, 'signature.value', {
      max: 128,
      pattern: /^[A-Za-z0-9+/]+={0,2}$/u,
    });
  }
}

export function verifyActivationEvidenceReport(reportFile, evidenceRoot, publicKeyFile) {
  const report = parseCanonicalJson(reportFile);
  validateReportShape(report, { signed: true });
  if (path.basename(reportFile) !== `${report.gateId}.json`) {
    fail('REPORT_FILENAME', `report filename must be ${report.gateId}.json`);
  }
  const publicKey = loadEd25519PublicKey(publicKeyFile);
  const fingerprint = publicKeyFingerprint(publicKey);
  if (report.signerKeySha256 !== fingerprint) fail('SIGNER_MISMATCH', 'signer key fingerprint differs');
  const unsigned = { ...report };
  delete unsigned.signature;
  const signature = Buffer.from(report.signature.value, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== report.signature.value) {
    fail('SIGNATURE_ENCODING', 'signature is not canonical Ed25519 base64');
  }
  if (!verifyBytes(null, Buffer.from(canonicalJson(unsigned)), publicKey, signature)) {
    fail('SIGNATURE_INVALID', `${report.gateId} signature did not verify`);
  }
  validateArtifacts(report.artifacts, evidenceRoot);
  return report;
}

export function verifyActivationEvidenceBundle(evidenceRoot, publicKeyFile, gateId = undefined) {
  if (!existsSync(evidenceRoot)) fail('EVIDENCE_ROOT', 'evidence directory does not exist');
  const rootMetadata = lstatSync(evidenceRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail('EVIDENCE_ROOT', 'evidence root must be a non-symlink directory');
  }
  const requested = gateId ? [gateId] : ACTIVATION_GATE_IDS;
  for (const id of requested) {
    if (!ACTIVATION_GATE_IDS.includes(id)) fail('UNKNOWN_GATE', String(id));
  }
  const reports = requested.map((id) => verifyActivationEvidenceReport(
    path.join(evidenceRoot, `${id}.json`),
    evidenceRoot,
    publicKeyFile,
  ));
  const releaseVersions = new Set(reports.map(({ releaseVersion }) => releaseVersion));
  const commits = new Set(reports.map(({ repositoryCommit }) => repositoryCommit));
  const signers = new Set(reports.map(({ signerKeySha256 }) => signerKeySha256));
  if (releaseVersions.size !== 1 || commits.size !== 1 || signers.size !== 1) {
    fail('BUNDLE_IDENTITY', 'all gate reports must bind the same release, commit, and signer');
  }
  return {
    schemaVersion: ACTIVATION_EVIDENCE_SCHEMA,
    activationReady: gateId === undefined && reports.length === ACTIVATION_GATE_IDS.length,
    releaseVersion: reports[0].releaseVersion,
    repositoryCommit: reports[0].repositoryCommit,
    signerKeySha256: reports[0].signerKeySha256,
    statuses: Object.fromEntries(reports.map(({ gateId: id }) => [id, 'PASS'])),
  };
}

export function createActivationEvidenceTemplate(gateId) {
  if (!ACTIVATION_GATE_IDS.includes(gateId)) fail('UNKNOWN_GATE', String(gateId));
  return {
    artifacts: [],
    checks: ACTIVATION_GATE_CHECKS[gateId].map((id) => ({
      durationSeconds: 0,
      id,
      metrics: {},
      result: 'FAIL',
      sampleSize: 0,
    })),
    completedAt: '',
    fixture: {
      devMode: false,
      id: '',
      kind: 'isolated-fixture',
      networkScope: 'loopback-only',
      production: false,
      productionStateTouched: false,
      topology: 'PUBLIC',
    },
    gateId,
    operatorApproved: false,
    redactionConfirmed: false,
    releaseVersion: '',
    repositoryCommit: '',
    result: 'FAIL',
    schemaVersion: ACTIVATION_EVIDENCE_SCHEMA,
    signerKeySha256: '',
    startedAt: '',
  };
}

export function signActivationEvidenceReport(inputFile, outputFile, privateKeyFile) {
  const report = parseCanonicalJson(inputFile);
  const privateMetadata = lstatSync(privateKeyFile);
  if (!privateMetadata.isFile() || privateMetadata.isSymbolicLink()) {
    fail('PRIVATE_KEY_FILE', 'private key must be a regular file');
  }
  const privateKey = createPrivateKey(readFileSync(privateKeyFile));
  if (privateKey.asymmetricKeyType !== 'ed25519') fail('PRIVATE_KEY_TYPE', 'private key must be Ed25519');
  const publicKey = createPublicKey(privateKey);
  report.signerKeySha256 = publicKeyFingerprint(publicKey);
  validateReportShape(report, { signed: false });
  if (existsSync(outputFile)) fail('OUTPUT_EXISTS', 'refusing to overwrite an evidence report');
  const signature = signBytes(null, Buffer.from(canonicalJson(report)), privateKey).toString('base64');
  const signed = { ...report, signature: { algorithm: 'Ed25519', value: signature } };
  writeFileSync(outputFile, canonicalJson(signed, true), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return signed;
}

function parseArguments(argv) {
  const command = argv.shift();
  if (!['template', 'sign', 'verify'].includes(command)) {
    fail('COMMAND', 'expected template, sign, or verify');
  }
  const options = { command, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--gate') options.gateId = argv[++index];
    else if (argument === '--evidence') options.evidenceRoot = path.resolve(argv[++index] ?? '');
    else if (argument === '--public-key') options.publicKeyFile = path.resolve(argv[++index] ?? '');
    else if (argument === '--private-key') options.privateKeyFile = path.resolve(argv[++index] ?? '');
    else if (argument === '--input') options.inputFile = path.resolve(argv[++index] ?? '');
    else if (argument === '--output') options.outputFile = path.resolve(argv[++index] ?? '');
    else if (argument === '--json') options.json = true;
    else fail('ARGUMENT', `unknown argument ${argument}`);
  }
  return options;
}

function requireOption(options, name) {
  if (!options[name]) fail('ARGUMENT', `--${name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} is required`);
  return options[name];
}

function runCli() {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === 'template') {
    process.stdout.write(canonicalJson(createActivationEvidenceTemplate(requireOption(options, 'gateId')), true));
    return;
  }
  if (options.command === 'sign') {
    const signed = signActivationEvidenceReport(
      requireOption(options, 'inputFile'),
      requireOption(options, 'outputFile'),
      requireOption(options, 'privateKeyFile'),
    );
    process.stdout.write(`${signed.gateId}: signed\n`);
    return;
  }
  const result = verifyActivationEvidenceBundle(
    requireOption(options, 'evidenceRoot'),
    requireOption(options, 'publicKeyFile'),
    options.gateId,
  );
  if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`${options.gateId ?? 'activation bundle'}: PASS\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
