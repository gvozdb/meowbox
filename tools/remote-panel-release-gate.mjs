#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED_FILES = [
  'specs/remote-panel-parity/plan.md',
  'specs/remote-panel-parity/hunk-ownership.yaml',
  'specs/remote-panel-parity/action-matrix.yaml',
  'specs/remote-panel-parity/traceability.spec.ctx',
  'specs/remote-panel-parity/activation-gates.spec.ctx',
  'tools/remote-panel-activation-evidence.mjs',
  'e2e/remote-panel-parity/test/activation-evidence.test.mjs',
  'api/src/federation/federation-legacy-retirement.ts',
  'api/src/federation/federation-trust-target.service.ts',
  'api/src/proxy/federation-trust-lifecycle.service.ts',
  'api/test/federation-key-lifecycle.test.js',
  'api/test/federation-legacy-retirement.test.js',
  'api/prisma/migrations/20260824155437_federation_registry_trust/migration.sql',
  'api/prisma/migrations/20260824160206_federation_principals/migration.sql',
  'api/prisma/migrations/20260824162419_panel_identity_master_default/migration.sql',
  'api/prisma/migrations/20260824162532_federation_legacy_registry_projection/migration.sql',
  'api/prisma/migrations/20260824164912_federation_idempotency_receipts/migration.sql',
  'api/prisma/migrations/zzz20260824170613_federation_correlated_audit/migration.sql',
  'api/prisma/migrations/20260824172236_federation_manifest_status/migration.sql',
  'api/prisma/migrations/20260824172358_federation_manifest_snapshot_contract/migration.sql',
  'api/prisma/migrations/20260824175024_federation_master_enrollment_state/migration.sql',
  'api/prisma/migrations/20260824175955_federation_enrollment_lease/migration.sql',
  'api/prisma/migrations/zzz20260824182528_operation_v2_worker_leases/migration.sql',
  'api/prisma/migrations/zzzz20260824184219_agent_job_protocol/migration.sql',
  'api/prisma/migrations/20260824205213_adminer_handoff/migration.sql',
  'api/prisma/migrations/20260825065346_transfer_sessions/migration.sql',
  'api/prisma/migrations/20260825073308_staged_backup_exports/migration.sql',
  'api/prisma/migrations/20260825080001_federated_vpn_subscriptions/migration.sql',
  'api/prisma/migrations/20260825083243_webhook_delivery/migration.sql',
  'api/prisma/migrations/20260825142042_add_transfer_resource_payload/migration.sql',
  'api/prisma/migrations/20260825151801_federation_rollout_policy/migration.sql',
  'migrations/system/2026-08-24-001-federation-identity-defaults.ts',
  'migrations/system/2026-08-24-002-federation-endpoint-defaults.ts',
  'migrations/system/2026-08-24-003-adminer-handoff-v2-runtime.ts',
  'migrations/system/2026-08-25-001-transfer-runtime.ts',
  'migrations/system/2026-08-25-002-webhook-runtime.ts',
  'migrations/system/2026-08-25-003-modx-login-handoff-runtime.ts',
  'migrations/system/2026-08-25-004-panel-access-federation-cutover-runtime.ts',
  'docs/runbook/remote-panel-common.md',
  'docs/runbook/remote-enrollment.md',
  'docs/runbook/federation-key-rotation.md',
  'docs/runbook/remote-panel-rollout.md',
  'docs/runbook/remote-panel-incident.md',
  'docs/runbook/panel-access-cutover-recovery.md',
  'docs/runbook/webhook-dlq.md',
  'docs/runbook/vpn-subscription-recovery.md',
  'docs/runbook/transfer-recovery.md',
  'docs/remote-panel-topology.md',
  'docs/remote-panel-compatibility.md',
  'tools/test-remote-panel-parity.sh',
];

function parseArguments(argv) {
  let root = scriptRoot;
  let mode = 'implementation';
  let json = false;
  let evidenceRoot;
  let publicKeyFile;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') root = path.resolve(argv[++index] ?? '');
    else if (argument === '--mode') mode = argv[++index] ?? '';
    else if (argument === '--evidence') evidenceRoot = path.resolve(argv[++index] ?? '');
    else if (argument === '--public-key') publicKeyFile = path.resolve(argv[++index] ?? '');
    else if (argument === '--json') json = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!['implementation', 'activation'].includes(mode)) {
    throw new Error('--mode must be implementation or activation');
  }
  return { root, mode, json, evidenceRoot, publicKeyFile };
}

function walkFiles(root, relativeRoots) {
  const files = [];
  const visit = (candidate) => {
    if (!existsSync(candidate)) return;
    const stat = statSync(candidate);
    if (stat.isFile()) {
      files.push(candidate);
      return;
    }
    for (const entry of readdirSync(candidate, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.output') continue;
      visit(path.join(candidate, entry.name));
    }
  };
  for (const relative of relativeRoots) visit(path.join(root, relative));
  return files.filter((file) => /\.(?:ts|js|mjs|cjs|vue)$/.test(file));
}

function scanForbidden(root) {
  const findings = [];
  const federationFiles = walkFiles(root, [
    'api/src/federation',
    'api/src/proxy/federated-fleet-update.service.ts',
    'api/src/gateway/federated-socket-bridge.service.ts',
  ]);
  for (const file of federationFiles) {
    const source = readFileSync(file, 'utf8');
    for (const [code, pattern] of [
      ['INSECURE_TLS', /rejectUnauthorized\s*:\s*false/],
      ['STATIC_BEARER', /\b(?:PROXY_TOKEN|X-Proxy-Token)\b/],
      ['FORWARDED_BROWSER_AUTH', /headers\s*\[[^\]]*authorization[^\]]*\]\s*=|cookie\s*:/i],
    ]) {
      if (pattern.test(source)) findings.push(`${code}:${path.relative(root, file)}`);
    }
  }
  for (const file of walkFiles(root, ['web/pages', 'web/components', 'web/composables', 'web/utils'])) {
    if (/document\.write\s*\(/.test(readFileSync(file, 'utf8'))) {
      findings.push(`MASTER_ORIGIN_DOCUMENT_WRITE:${path.relative(root, file)}`);
    }
  }
  const executableConfig = [
    '.github/workflows/release.yml',
    'Makefile',
    'api/package.json',
    'migrations/package.json',
  ].filter((relative) => existsSync(path.join(root, relative)));
  for (const relative of executableConfig) {
    if (/\bprisma\s+(?:db\s+)?push\b/.test(readFileSync(path.join(root, relative), 'utf8'))) {
      findings.push(`PRISMA_PUSH:${relative}`);
    }
  }
  return findings;
}

function activationStatuses(root) {
  const source = readFileSync(
    path.join(root, 'specs/remote-panel-parity/activation-gates.spec.ctx'),
    'utf8',
  );
  const statuses = {};
  for (const match of source.matchAll(/^\s*gate ([A-Z0-9-]+) \{ status: ([A-Z_]+);/gm)) {
    statuses[match[1]] = match[2];
  }
  return statuses;
}

function releaseIdentity(root) {
  const versionFile = path.join(root, 'VERSION');
  const version = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : undefined;
  const packagedCommitFile = path.join(root, 'RELEASE_COMMIT');
  if (existsSync(packagedCommitFile)) {
    return { version, commit: readFileSync(packagedCommitFile, 'utf8').trim() };
  }
  const git = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5_000,
  });
  return { version, commit: git.status === 0 ? git.stdout.trim() : undefined };
}

function verifyActivationEvidence(root, evidenceRoot, publicKeyFile) {
  if (!evidenceRoot && !publicKeyFile) {
    return { pass: false, detail: ['activation evidence and Ed25519 public key are required'] };
  }
  if (!evidenceRoot || !publicKeyFile) {
    return { pass: false, detail: ['--evidence and --public-key must be supplied together'] };
  }
  const verification = spawnSync(
    process.execPath,
    [
      'tools/remote-panel-activation-evidence.mjs',
      'verify',
      '--evidence', evidenceRoot,
      '--public-key', publicKeyFile,
      '--json',
    ],
    { cwd: root, encoding: 'utf8', timeout: 30_000 },
  );
  if (verification.status !== 0) {
    return {
      pass: false,
      detail: [(verification.stderr || verification.stdout).trim().slice(0, 500)],
    };
  }
  let data;
  try {
    data = JSON.parse(verification.stdout);
  } catch {
    return { pass: false, detail: ['activation evidence verifier returned invalid JSON'] };
  }
  const identity = releaseIdentity(root);
  const identityErrors = [];
  if (!identity.version || data.releaseVersion !== identity.version) {
    identityErrors.push('evidence release version does not match VERSION');
  }
  if (!identity.commit || data.repositoryCommit !== identity.commit) {
    identityErrors.push('evidence repository commit does not match release commit');
  }
  return {
    pass: data.activationReady === true && identityErrors.length === 0,
    detail: identityErrors,
    data,
  };
}

export function evaluateRemotePanelReleaseGate(root = scriptRoot, options = {}) {
  const checks = [];
  const missing = REQUIRED_FILES.filter((relative) => !existsSync(path.join(root, relative)));
  checks.push({ name: 'required-files', pass: missing.length === 0, detail: missing });

  const generated = spawnSync(
    process.execPath,
    ['api/scripts/generate-federation-action-matrix.cjs', '--check'],
    { cwd: root, encoding: 'utf8', timeout: 30_000 },
  );
  checks.push({
    name: 'generated-contracts',
    pass: generated.status === 0,
    detail: generated.status === 0 ? [] : [(generated.stderr || generated.stdout).trim().slice(0, 500)],
  });

  const forbidden = scanForbidden(root);
  checks.push({ name: 'security-static', pass: forbidden.length === 0, detail: forbidden });

  const traceability = existsSync(path.join(root, 'specs/remote-panel-parity/traceability.spec.ctx'))
    ? readFileSync(path.join(root, 'specs/remote-panel-parity/traceability.spec.ctx'), 'utf8')
    : '';
  checks.push({
    name: 'traceability-contract',
    pass: traceability.startsWith('spec\n') && /\nopen_questions: \[\]\s*$/.test(traceability),
    detail: [],
  });

  const declaredStatuses = missing.includes('specs/remote-panel-parity/activation-gates.spec.ctx')
    ? {}
    : activationStatuses(root);
  const activationEvidence = verifyActivationEvidence(
    root,
    options.evidenceRoot,
    options.publicKeyFile,
  );
  const statuses = activationEvidence.pass
    ? activationEvidence.data.statuses
    : declaredStatuses;
  const devMode = existsSync(path.join(root, '.dev-mode'));
  const implementationReady = checks.every(({ pass }) => pass);
  const activationReady = implementationReady &&
    !devMode &&
    activationEvidence.pass &&
    Object.keys(statuses).length > 0 &&
    Object.values(statuses).every((status) => status === 'PASS');
  return {
    schemaVersion: 'meowbox.remote-panel-release-gate/v1',
    implementationReady,
    activationReady,
    devMode,
    activationStatuses: statuses,
    activationEvidence: {
      pass: activationEvidence.pass,
      detail: activationEvidence.detail,
    },
    checks,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = evaluateRemotePanelReleaseGate(options.root, options);
    const pass = options.mode === 'activation' ? result.activationReady : result.implementationReady;
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else process.stdout.write(
      `${options.mode}: ${pass ? 'PASS' : 'BLOCKED'}; activation: ${result.activationReady ? 'PASS' : 'BLOCKED'}\n`,
    );
    if (!pass) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
