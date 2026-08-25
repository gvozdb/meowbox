'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const {
  cp,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');
const test = require('node:test');
const { PrismaClient } = require('../../api/node_modules/@prisma/client');

const execFileP = promisify(execFile);
const projectRoot = path.resolve(__dirname, '..', '..');
const apiDir = path.join(projectRoot, 'api');
const prismaBin = path.join(apiDir, 'node_modules', '.bin', 'prisma');
const currentPrismaDir = path.join(apiDir, 'prisma');
const rolloutMigration = '20260825151801_federation_rollout_policy';

function assertTemporaryPath(candidate) {
  assert.ok(
    path.resolve(candidate).startsWith(`${path.resolve(os.tmpdir())}/meowbox-rollout-migration-`),
    `refusing cleanup outside rollout fixture: ${candidate}`,
  );
}

async function migrate(schemaPath, databaseUrl) {
  return execFileP(prismaBin, ['migrate', 'deploy', '--schema', schemaPath], {
    cwd: apiDir,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function prepareOldSchema(root) {
  const oldPrismaDir = path.join(root, 'old-prisma');
  const oldMigrationsDir = path.join(oldPrismaDir, 'migrations');
  await mkdir(oldMigrationsDir, { recursive: true });
  await writeFile(
    path.join(oldPrismaDir, 'schema.prisma'),
    await readFile(path.join(currentPrismaDir, 'schema.prisma'), 'utf8'),
    'utf8',
  );
  await cp(
    path.join(currentPrismaDir, 'migrations', 'migration_lock.toml'),
    path.join(oldMigrationsDir, 'migration_lock.toml'),
  );
  for (const entry of await readdir(path.join(currentPrismaDir, 'migrations'), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === rolloutMigration) continue;
    await cp(
      path.join(currentPrismaDir, 'migrations', entry.name),
      path.join(oldMigrationsDir, entry.name),
      { recursive: true },
    );
  }
  return path.join(oldPrismaDir, 'schema.prisma');
}

test(
  'T-REL-001 rollout migration expands a representative registry and is repeatable',
  { timeout: 120_000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'meowbox-rollout-migration-'));
    const databasePath = path.join(root, 'panel.db');
    const databaseUrl = pathToFileURL(databasePath).href;
    const currentSchema = path.join(currentPrismaDir, 'schema.prisma');
    let prisma;
    try {
      const oldSchema = await prepareOldSchema(root);
      await migrate(oldSchema, databaseUrl);
      prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      await prisma.$executeRawUnsafe(`
        WITH RECURSIVE seq(value) AS (
          SELECT 1
          UNION ALL
          SELECT value + 1 FROM seq WHERE value < 10000
        )
        INSERT INTO remote_servers (id, display_name, updated_at)
        SELECT
          printf('rollout-fixture-%05d', value),
          printf('Rollout fixture %05d', value),
          CURRENT_TIMESTAMP
        FROM seq
      `);
      await prisma.$disconnect();
      prisma = undefined;

      const startedAt = Date.now();
      await migrate(currentSchema, databaseUrl);
      const elapsedMs = Date.now() - startedAt;
      assert.ok(elapsedMs < 120_000, `rollout migration took ${elapsedMs}ms`);

      prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      const [count] = await prisma.$queryRawUnsafe(`
        SELECT COUNT(*) AS count
        FROM remote_servers
        WHERE rollout_stage = 'DISABLED'
          AND rollout_stage_started_at IS NULL
          AND rollout_evidence_json IS NULL
          AND rollout_approved_at IS NULL
      `);
      assert.equal(Number(count.count), 10_000);
      const indexes = await prisma.$queryRawUnsafe(`PRAGMA index_list('remote_servers')`);
      assert.ok(indexes.some(({ name }) => name === 'remote_servers_rollout_stage_updated_at_idx'));
      assert.deepEqual(await prisma.$queryRawUnsafe('PRAGMA foreign_key_check'), []);
      await prisma.$disconnect();
      prisma = undefined;

      const repeated = await migrate(currentSchema, databaseUrl);
      assert.match(`${repeated.stdout}\n${repeated.stderr}`, /No pending migrations to apply/i);
    } finally {
      if (prisma) await prisma.$disconnect();
      assertTemporaryPath(root);
      await rm(root, { recursive: true, force: true });
    }
  },
);
