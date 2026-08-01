'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const { runSqliteScript } = require('../dist/release');
const { createPreDomainPrismaFixture } = require('./fixtures/domain-applications');

const execFileP = promisify(execFile);
const projectRoot = path.resolve(__dirname, '..', '..');
const bridgeScripts = path.join(projectRoot, 'api', 'scripts');
const markerSource = path.join(
  projectRoot,
  'migrations',
  'release',
  'legacy-panel-update-bridge.json',
);

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

test('v0.6.63 Prisma db push hands off without touching the legacy database', { timeout: 120_000 }, async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'meowbox-legacy-panel-bridge-test-'));
  const panel = path.join(tempRoot, 'panel');
  const stateData = path.join(panel, 'state', 'data');
  const currentRelease = path.join(panel, 'releases', 'v0.6.63');
  const release = path.join(panel, 'releases', 'v9.9.9');
  const api = path.join(release, 'api');
  const capture = path.join(tempRoot, 'bridge-capture.txt');
  const database = path.join(stateData, 'meowbox.db');

  try {
    await mkdir(path.join(api, 'node_modules', '.bin'), { recursive: true });
    await mkdir(path.join(api, 'node_modules', 'prisma', 'build'), { recursive: true });
    await mkdir(path.join(release, 'migrations', 'release'), { recursive: true });
    await mkdir(path.join(release, 'tools'), { recursive: true });
    await mkdir(currentRelease, { recursive: true });
    await mkdir(stateData, { recursive: true });

    await cp(path.join(projectRoot, 'api', 'prisma'), path.join(api, 'prisma'), { recursive: true });
    await cp(bridgeScripts, path.join(api, 'scripts'), { recursive: true });
    await cp(path.join(projectRoot, 'migrations', 'dist'), path.join(release, 'migrations', 'dist'), { recursive: true });
    await writeFile(
      path.join(release, 'migrations', 'dist', 'release-cli.js'),
      '#!/usr/bin/env node\nprocess.exit(79);\n',
      { mode: 0o755 },
    );
    await copyFile(
      path.join(projectRoot, 'migrations', 'release', 'supported-baselines.json'),
      path.join(release, 'migrations', 'release', 'supported-baselines.json'),
    );
    await copyFile(markerSource, path.join(api, 'prisma', 'legacy-panel-update-bridge.json'));
    await writeFile(path.join(release, 'VERSION'), 'v9.9.9\n', { mode: 0o644 });
    await writeFile(path.join(currentRelease, 'VERSION'), 'v0.6.63\n', { mode: 0o644 });
    await writeFile(path.join(currentRelease, 'Makefile'), 'update:\n\t@true\n', { mode: 0o644 });
    await symlink('releases/v0.6.63', path.join(panel, 'current'));

    const realCli = path.join(api, 'node_modules', 'prisma', 'build', 'index.js');
    const prismaBin = path.join(api, 'node_modules', '.bin', 'prisma');
    await writeFile(realCli, '#!/usr/bin/env node\nprocess.exit(73);\n', { mode: 0o755 });
    await symlink('../prisma/build/index.js', prismaBin);

    const updateStub = `#!/usr/bin/env bash
set -euo pipefail
{
  printf '%s\\n' "$1"
  printf '%s\\n' "$MEOWBOX_PANEL_DIR"
  printf '%s\\n' "$MEOWBOX_STATE_DIR"
  printf '%s\\n' "$MEOWBOX_DATABASE_FILE"
  printf '%s\\n' "$MEOWBOX_UPDATE_CANDIDATE_DIR"
  printf '%s\\n' "$MEOWBOX_LEGACY_BRIDGE_SOURCE_DIR"
  printf '%s\\n' "$MEOWBOX_LEGACY_PANEL_BRIDGE"
} > "$BRIDGE_CAPTURE"
if [[ "\${BRIDGE_FAIL:-0}" == "1" ]]; then
  exit 79
fi
`;
    await writeFile(path.join(release, 'tools', 'update.sh'), updateStub, { mode: 0o755 });
    await chmod(path.join(release, 'tools', 'update.sh'), 0o755);

    await createPreDomainPrismaFixture(database, projectRoot, runSqliteScript);
    const before = digest(await readFile(database));

    await execFileP(process.execPath, [path.join(api, 'scripts', 'install-prisma-legacy-bridge.cjs')]);
    assert.equal((await lstat(prismaBin)).isSymbolicLink(), false);

    await assert.rejects(
      execFileP(
        process.execPath,
        [prismaBin, 'db', 'push', '--skip-generate', '--accept-data-loss'],
        {
          cwd: api,
          env: {
            ...process.env,
            DATABASE_URL: `file:${database}`,
            BRIDGE_CAPTURE: capture,
            BRIDGE_FAIL: '1',
          },
          maxBuffer: 8 * 1024 * 1024,
        },
      ),
      (error) => {
        assert.match(error.stdout, /rollback release protected/);
        assert.match(error.stderr, /Transactional migration failed/);
        return true;
      },
    );

    const protectedCurrent = await realpath(path.join(panel, 'current'));
    assert.equal(path.dirname(protectedCurrent), path.join(panel, 'releases'));
    assert.match(path.basename(protectedCurrent), /^\.legacy-rollback-v0\.6\.63$/);
    assert.equal(await readFile(path.join(protectedCurrent, 'VERSION'), 'utf8'), 'v0.6.63\n');
    assert.equal(
      (await stat(path.join(protectedCurrent, 'VERSION'))).ino,
      (await stat(path.join(currentRelease, 'VERSION'))).ino,
    );
    assert.equal(digest(await readFile(database)), before);

    // Exact legacy cleanup can now delete the visible old directory without
    // invalidating current or the rollback target recorded by the child.
    await rm(currentRelease, { recursive: true, force: true });
    assert.equal(await readFile(path.join(panel, 'current', 'VERSION'), 'utf8'), 'v0.6.63\n');

    const result = await execFileP(
      process.execPath,
      [prismaBin, 'db', 'push', '--skip-generate', '--accept-data-loss'],
      {
        cwd: api,
        env: {
          ...process.env,
          DATABASE_URL: `file:${database}`,
          BRIDGE_CAPTURE: capture,
        },
        maxBuffer: 8 * 1024 * 1024,
      },
    );

    assert.match(result.stdout, /old Prisma db push intercepted before any database write/);
    assert.match(result.stdout, /v0\.6\.63 handing off/);
    assert.match(result.stdout, /transactional migration committed/);
    assert.equal(digest(await readFile(database)), before);
    assert.deepEqual((await readFile(capture, 'utf8')).trim().split('\n'), [
      'v9.9.9',
      panel,
      path.join(panel, 'state'),
      database,
      release,
      release,
      '1',
    ]);

    await writeFile(path.join(panel, 'current', 'VERSION'), 'v0.6.49\n', { mode: 0o644 });
    await assert.rejects(
      execFileP(
        process.execPath,
        [prismaBin, 'db', 'push', '--skip-generate', '--accept-data-loss'],
        {
          cwd: api,
          env: {
            ...process.env,
            DATABASE_URL: `file:${database}`,
            BRIDGE_CAPTURE: capture,
          },
          maxBuffer: 8 * 1024 * 1024,
        },
      ),
      (error) => {
        assert.match(error.stderr, /Current panel version v0\.6\.49 is not supported/);
        return true;
      },
    );
    assert.equal(digest(await readFile(database)), before);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
