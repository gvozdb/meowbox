#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
const apiRoot = path.resolve(__dirname, '..', '..');
const releaseDir = path.dirname(apiRoot);
const releasesDir = path.dirname(releaseDir);
const panelDir = path.dirname(releasesDir);
const markerPath = path.join(apiRoot, 'prisma', 'legacy-panel-update-bridge.json');
const realCli = path.join(apiRoot, 'node_modules', 'prisma', 'build', 'index.js');

function stop(message, detail) {
  console.error(`[legacy-panel-bridge] ✗ ${message}`);
  if (detail) console.error(`[legacy-panel-bridge] ${detail}`);
  process.exit(1);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    env: process.env,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) stop(`Cannot execute ${command}`, result.error.message);
  process.exit(result.status ?? 1);
}

function delegateToPrisma() {
  if (!fs.statSync(realCli, { throwIfNoEntry: false })?.isFile()) {
    stop('Real Prisma CLI is missing from the verified release artifact');
  }
  run(process.execPath, [realCli, ...args]);
}

function parseDatabasePath(databaseUrl) {
  if (typeof databaseUrl !== 'string' || !databaseUrl.startsWith('file:/')) {
    stop('Legacy panel bridge requires an absolute SQLite DATABASE_URL');
  }
  const withoutQuery = databaseUrl.slice('file:'.length).split(/[?#]/, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    stop('DATABASE_URL contains invalid percent encoding');
  }
  if (!path.isAbsolute(decoded)) {
    stop('Legacy panel bridge refuses a relative SQLite path');
  }
  return path.resolve(decoded);
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    stop(`Cannot read ${label}`, error.message);
  }
}

function parseVersion(value) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

const isDbPush = args[0] === 'db' && args[1] === 'push';
if (!isDbPush || !fs.existsSync(markerPath)) delegateToPrisma();

const exactLegacyInvocation = args.includes('--skip-generate') && args.includes('--accept-data-loss');
if (!exactLegacyInvocation) {
  stop('Prisma db push is disabled in release artifacts; use the transactional updater');
}
if (path.basename(releasesDir) !== 'releases') {
  stop('Legacy panel bridge is outside the expected releases/<version>/api layout');
}

const marker = readJson(markerPath, 'legacy bridge marker');
const minimumLegacyVersion = parseVersion(marker.legacyVersionRange?.min);
const maximumLegacyVersion = parseVersion(marker.legacyVersionRange?.max);
if (
  marker.version !== 2
  || marker.interceptedCommand !== 'prisma db push --skip-generate --accept-data-loss'
  || minimumLegacyVersion === null
  || maximumLegacyVersion === null
  || compareVersions(minimumLegacyVersion, maximumLegacyVersion) > 0
) {
  stop('Legacy panel bridge marker has an unsupported contract');
}

const versionFile = path.join(releaseDir, 'VERSION');
const version = fs.readFileSync(versionFile, 'utf8').trim();
if (!/^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) {
  stop('Candidate VERSION is invalid');
}

const database = parseDatabasePath(process.env.DATABASE_URL);
const expectedDatabase = path.join(panelDir, 'state', 'data', 'meowbox.db');
for (const candidate of [database, expectedDatabase]) {
  if (!fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
    stop(`Panel SQLite database is missing: ${candidate}`);
  }
}
if (fs.realpathSync(database) !== fs.realpathSync(expectedDatabase)) {
  stop('DATABASE_URL does not point to the panel persistent database');
}

const currentVersionFile = path.join(panelDir, 'current', 'VERSION');
let currentVersion;
try {
  currentVersion = fs.readFileSync(currentVersionFile, 'utf8').trim();
} catch (error) {
  stop('Cannot read current panel VERSION', error.message);
}
const parsedCurrentVersion = parseVersion(currentVersion);
if (
  parsedCurrentVersion === null
  || compareVersions(parsedCurrentVersion, minimumLegacyVersion) < 0
  || compareVersions(parsedCurrentVersion, maximumLegacyVersion) > 0
) {
  stop(`Current panel version ${currentVersion || 'unknown'} is not supported by this legacy bridge`);
}

const releaseCli = path.join(releaseDir, 'migrations', 'dist', 'release-cli.js');
const baselineContract = path.join(releaseDir, 'migrations', 'release', 'supported-baselines.json');
const updateScript = path.join(releaseDir, 'tools', 'update.sh');
for (const required of [releaseCli, baselineContract, updateScript]) {
  if (!fs.statSync(required, { throwIfNoEntry: false })?.isFile()) {
    stop(`Verified release artifact is missing ${required}`);
  }
}

console.log('[legacy-panel-bridge] old Prisma db push intercepted before any database write');
console.log(`[legacy-panel-bridge] ${currentVersion} handing off to snapshot-backed transactional migration`);

const bridgeEnv = {
  ...process.env,
  MEOWBOX_PANEL_DIR: panelDir,
  MEOWBOX_STATE_DIR: path.join(panelDir, 'state'),
  MEOWBOX_DATABASE_FILE: database,
  MEOWBOX_UPDATE_CANDIDATE_DIR: releaseDir,
  MEOWBOX_UPDATE_CANDIDATE_VERSION: version,
  MEOWBOX_LEGACY_BRIDGE_SOURCE_DIR: releaseDir,
  MEOWBOX_LEGACY_PANEL_BRIDGE: '1',
  MEOWBOX_TRIGGERED_BY: 'legacy-panel-bridge',
};
delete bridgeEnv.MEOWBOX_RELEASE_LOCK_HELD;
delete bridgeEnv.MEOWBOX_RELEASE_LOCK_FILE;

const update = spawnSync(
  '/bin/bash',
  [updateScript, version, '--triggered-by=legacy-panel-bridge'],
  { env: bridgeEnv, stdio: 'inherit' },
);
if (update.error || update.status !== 0) {
  stop(
    'Transactional migration failed; its rollback journal and snapshots were retained',
    update.error?.message,
  );
}

console.log('[legacy-panel-bridge] transactional migration committed');
process.exit(0);
