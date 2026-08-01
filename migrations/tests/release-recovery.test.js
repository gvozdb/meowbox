'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const execFileP = promisify(execFile);
const projectRoot = path.resolve(__dirname, '..', '..');
const recoveryScript = path.join(projectRoot, 'tools', 'recover-missing-release.sh');

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'meowbox-release-recovery-test-'));
  const panel = path.join(root, 'panel');
  const assets = path.join(root, 'assets');
  const source = path.join(root, 'source', 'meowbox');
  const fakeBin = path.join(root, 'bin');
  const version = 'v1.2.3';

  await mkdir(path.join(panel, 'releases'), { recursive: true });
  await mkdir(path.join(panel, 'state', 'data'), { recursive: true });
  await mkdir(assets, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  for (const directory of [
    'tools',
    'api/dist',
    'agent/dist',
    'web/.output',
    'shared/dist',
    'migrations/dist',
  ]) {
    await mkdir(path.join(source, directory), { recursive: true });
  }
  await writeFile(path.join(source, 'VERSION'), `${version}\n`);
  await writeFile(path.join(source, 'Makefile'), 'update:\n\t@true\n');
  await writeFile(path.join(source, 'ecosystem.config.js'), 'module.exports = {};\n');
  await writeFile(path.join(source, 'tools', 'update.sh'), '#!/usr/bin/env bash\n');
  await writeFile(path.join(source, 'tools', 'healthcheck.sh'), '#!/usr/bin/env bash\n');
  for (const file of [
    'api/dist/index.js',
    'agent/dist/index.js',
    'web/.output/nitro.json',
    'shared/dist/index.js',
    'migrations/dist/runner.js',
  ]) {
    await writeFile(path.join(source, file), '\n');
  }

  const tarball = path.join(assets, `meowbox-${version}.tar.gz`);
  await execFileP('tar', ['-czf', tarball, '-C', path.dirname(source), 'meowbox']);
  const checksum = digest(await readFile(tarball));
  await writeFile(path.join(assets, 'SHA256SUMS'), `${checksum}  meowbox-${version}.tar.gz\n`);

  const fakeCurl = `#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
cp -- "$RECOVERY_ASSET_DIR/\${url##*/}" "$output"
`;
  await writeFile(path.join(fakeBin, 'curl'), fakeCurl, { mode: 0o755 });
  await chmod(path.join(fakeBin, 'curl'), 0o755);

  const database = path.join(panel, 'state', 'data', 'meowbox.db');
  await writeFile(database, 'persistent-db-bytes');
  await writeFile(path.join(panel, 'state', '.env'), 'DATABASE_URL="persistent"\n');
  await symlink(`releases/${version}`, path.join(panel, 'current'));

  return { root, panel, assets, fakeBin, version, database, checksum };
}

test('recovery atomically rehydrates a dangling current release without touching state', async () => {
  const fixture = await createFixture();
  try {
    const before = digest(await readFile(fixture.database));
    const result = await execFileP('bash', [recoveryScript], {
      env: {
        ...process.env,
        PATH: `${fixture.fakeBin}:${process.env.PATH}`,
        MEOWBOX_PANEL_DIR: fixture.panel,
        MEOWBOX_UPDATE_LOCK: path.join(fixture.root, 'legacy-update.lock'),
        RECOVERY_ASSET_DIR: fixture.assets,
      },
      maxBuffer: 8 * 1024 * 1024,
    });

    assert.match(result.stdout, new RegExp(`OK: restored .*${fixture.version}`));
    assert.match(result.stdout, /persistent database, configuration, Nginx and PM2 were not changed/);
    assert.equal(await realpath(path.join(fixture.panel, 'current')),
      path.join(fixture.panel, 'releases', fixture.version));
    assert.equal(digest(await readFile(fixture.database)), before);
    assert.equal(
      await realpath(path.join(fixture.panel, 'current', 'data')),
      path.join(fixture.panel, 'state', 'data'),
    );
    assert.equal(
      await realpath(path.join(fixture.panel, 'current', '.env')),
      path.join(fixture.panel, 'state', '.env'),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('recovery refuses a checksum mismatch and leaves current dangling', async () => {
  const fixture = await createFixture();
  try {
    await writeFile(
      path.join(fixture.assets, 'SHA256SUMS'),
      `${'0'.repeat(64)}  meowbox-${fixture.version}.tar.gz\n`,
    );
    const before = digest(await readFile(fixture.database));

    await assert.rejects(
      execFileP('bash', [recoveryScript], {
        env: {
          ...process.env,
          PATH: `${fixture.fakeBin}:${process.env.PATH}`,
          MEOWBOX_PANEL_DIR: fixture.panel,
          MEOWBOX_UPDATE_LOCK: path.join(fixture.root, 'legacy-update.lock'),
          RECOVERY_ASSET_DIR: fixture.assets,
        },
        maxBuffer: 8 * 1024 * 1024,
      }),
      (error) => {
        assert.match(error.stderr, /release checksum verification failed/);
        return true;
      },
    );

    assert.equal(digest(await readFile(fixture.database)), before);
    assert.equal((await lstat(path.join(fixture.panel, 'current'))).isSymbolicLink(), true);
    await assert.rejects(realpath(path.join(fixture.panel, 'current')), { code: 'ENOENT' });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
