'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');
const test = require('node:test');

const {
  LEGACY_SYSTEM_PLAN_COMPATIBILITY,
  planLegacySystemMigration,
} = require('../dist/system-plan-compat');
const {
  fingerprintDatabaseFiles,
  querySqliteJson,
  runSqliteScript,
} = require('../dist/release');

const execFileP = promisify(execFile);
const migrationsDir = resolve(process.cwd());
const projectRoot = resolve(migrationsDir, '..');
const apiDir = join(projectRoot, 'api');
const prismaBin = join(apiDir, 'node_modules', '.bin', 'prisma');
const prismaSchema = join(apiDir, 'prisma', 'schema.prisma');
const runner = join(migrationsDir, 'dist', 'runner.js');
const systemDir = join(migrationsDir, 'dist', 'system');

const expectedIds = [
  '2026-07-04-001-ssl-trusted-certificate-nginx',
  '2026-07-04-002-ssl-stapling-ocsp-guard',
  '2026-07-04-003-remove-stale-ssl-chunks',
  '2026-07-04-004-ssl-usable-statuses-nginx',
  '2026-07-04-005-ssl-trusted-certificate-alias-redirects',
  '2026-07-04-006-ssl-ocsp-system-ca-fallback',
  '2026-07-26-001-ssl-renewal-reliability',
  '2026-07-26-002-certbot-hook-path',
  '2026-07-26-003-stable-acme-webroot',
];

function assertTemporaryPath(candidate) {
  assert.ok(
    resolve(candidate).startsWith(`${resolve(tmpdir())}/meowbox-system-plan-test-`),
    `refusing test write outside a temporary fixture: ${candidate}`,
  );
}

async function prismaMigrateDeploy(dbPath) {
  return execFileP(prismaBin, ['migrate', 'deploy', '--schema', prismaSchema], {
    cwd: apiDir,
    env: { ...process.env, DATABASE_URL: pathToFileURL(dbPath).href },
    maxBuffer: 2 * 1024 * 1024,
    timeout: 120_000,
  });
}

async function runRunner(dbPath, args, currentDir) {
  return execFileP(process.execPath, [runner, ...args], {
    cwd: migrationsDir,
    env: {
      ...process.env,
      DATABASE_URL: pathToFileURL(dbPath).href,
      MEOWBOX_CURRENT_DIR: currentDir,
      MEOWBOX_RELEASE_LOCK_HELD: '1',
    },
    maxBuffer: 2 * 1024 * 1024,
    timeout: 120_000,
  });
}

test('legacy plan compatibility is bound to exact compiled artifacts', async () => {
  assert.deepEqual(
    LEGACY_SYSTEM_PLAN_COMPATIBILITY.map(({ id }) => id),
    expectedIds,
  );
  for (const entry of LEGACY_SYSTEM_PLAN_COMPATIBILITY) {
    const artifact = await readFile(join(systemDir, `${entry.id}.js`));
    assert.equal(
      createHash('sha256').update(artifact).digest('hex'),
      entry.checksum,
      entry.id,
    );
  }
});

test('unknown and drifted legacy artifacts remain fail-closed', async () => {
  const ctx = {
    exists: async () => true,
    prisma: {
      $queryRawUnsafe: async () => [{ count: 0 }],
    },
    config: { currentDir: '/candidate' },
  };
  assert.equal(
    await planLegacySystemMigration(
      { id: '2026-01-01-001-unknown', checksum: '0'.repeat(64) },
      ctx,
    ),
    null,
  );
  await assert.rejects(
    planLegacySystemMigration(
      { id: expectedIds[0], checksum: '0'.repeat(64) },
      ctx,
    ),
    /compatibility is stale/,
  );
});

test(
  'runner plans the reported legacy SSL and ACME pending set without writes',
  { timeout: 120_000 },
  async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'meowbox-system-plan-test-'));
    const dbPath = join(tempRoot, 'panel.db');
    const candidateDir = join(tempRoot, 'candidate');
    try {
      await mkdir(join(candidateDir, 'agent', 'dist', 'nginx'), {
        recursive: true,
      });
      await writeFile(
        join(candidateDir, 'agent', 'dist', 'nginx', 'templates.js'),
        'module.exports = {};\n',
      );
      await writeFile(
        join(candidateDir, 'agent', 'dist', 'nginx', 'nginx.manager.js'),
        'module.exports = {};\n',
      );

      await prismaMigrateDeploy(dbPath);
      await runRunner(
        dbPath,
        ['baseline-fresh-install', '--fresh-install'],
        candidateDir,
      );
      await runSqliteScript(
        dbPath,
        `DELETE FROM "system_migrations"
         WHERE "id" IN (${expectedIds.map((id) => `'${id}'`).join(', ')});`,
      );

      const databaseBefore = await fingerprintDatabaseFiles(dbPath);
      const result = await runRunner(
        dbPath,
        ['up', '--dry-run'],
        candidateDir,
      );
      const databaseAfter = await fingerprintDatabaseFiles(dbPath);

      assert.deepEqual(databaseAfter, databaseBefore);
      assert.match(result.stdout, /Pending: 9/);
      assert.match(
        result.stdout,
        /--dry-run: all pending migrations planned with zero writes/,
      );
      for (const id of expectedIds) {
        assert.match(result.stdout, new RegExp(`plan ${id}:`), id);
      }
      const rows = await querySqliteJson(
        dbPath,
        `SELECT COUNT(*) AS count FROM "system_migrations"
         WHERE "id" IN (${expectedIds.map((id) => `'${id}'`).join(', ')});`,
      );
      assert.equal(rows[0].count, 0);
    } finally {
      assertTemporaryPath(tempRoot);
      await rm(tempRoot, { recursive: true, force: true });
    }
  },
);
