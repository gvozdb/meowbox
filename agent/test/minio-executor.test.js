'use strict';

const assert = require('node:assert/strict');
const { promises: fs } = require('node:fs');
const test = require('node:test');

const {
  MINIO_CLIENT_BINARY,
  MINIO_ROOT_CREDENTIALS_PATH,
  MINIO_SERVER_BINARY,
} = require('@meowbox/shared');
const {
  MinioExecutor,
  minioTenantForSite,
  renderTenantPolicy,
} = require('../src/services/minio.executor');

const SITE = {
  siteId: '11111111-1111-4111-8111-111111111111',
  siteName: 'project_api',
  systemUser: 'project_api',
  rootPath: '/var/www/project_api',
};

function regularFile() {
  return {
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  };
}

function rootCredentials() {
  return [
    'MINIO_ROOT_USER=mb1234567890abcdef12',
    'MINIO_ROOT_PASSWORD=1234567890abcdef1234567890abcdef12345678',
    'MINIO_BROWSER=off',
    '',
  ].join('\n');
}

async function withFsStubs(stubs, run) {
  const originals = {};
  for (const [key, value] of Object.entries(stubs)) {
    originals[key] = fs[key];
    fs[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(originals)) fs[key] = value;
  }
}

function commandRecorder(calls, behavior = () => ({ exitCode: 0, stdout: '', stderr: '' })) {
  return {
    async execute(command, args, options) {
      calls.push({ command, args, options });
      return behavior(command, args, options);
    },
  };
}

test('tenant naming is deterministic and policy is restricted to one bucket', () => {
  const tenant = minioTenantForSite(SITE.siteId, SITE.siteName);
  const another = minioTenantForSite(
    '22222222-2222-4222-8222-222222222222',
    SITE.siteName,
  );
  const policy = JSON.parse(renderTenantPolicy(tenant.bucket));
  const resources = policy.Statement.flatMap((statement) => statement.Resource);

  assert.equal(tenant.bucket, minioTenantForSite(SITE.siteId, SITE.siteName).bucket);
  assert.notEqual(tenant.bucket, another.bucket);
  assert.match(tenant.bucket, /^mb-project-api-[a-f0-9]{10}$/);
  assert.deepEqual(resources, [
    `arn:aws:s3:::${tenant.bucket}`,
    `arn:aws:s3:::${tenant.bucket}/*`,
  ]);
  assert.equal(resources.some((resource) => resource === 'arn:aws:s3:::*'), false);
});

test('site enable replaces an incomplete deterministic IAM user and writes only site credentials', { concurrency: false }, async () => {
  const commands = [];
  const writes = [];
  await withFsStubs({
    lstat: async () => regularFile(),
    readFile: async (file) => {
      if (file === MINIO_ROOT_CREDENTIALS_PATH) return rootCredentials();
      throw new Error(`unexpected read: ${file}`);
    },
    mkdir: async () => {},
    writeFile: async (file, content) => { writes.push({ file, content }); },
    chmod: async () => {},
    rename: async () => {},
    unlink: async () => {},
  }, async () => {
    const executor = new MinioExecutor(commandRecorder(commands, (command, args) => {
      if (command === MINIO_SERVER_BINARY && args[0] === '--version') {
        return { exitCode: 0, stdout: 'minio version RELEASE.2026-01-01T00-00-00Z\n', stderr: '' };
      }
      if (command === 'systemctl' && args[0] === 'is-active') {
        return { exitCode: 0, stdout: 'active\n', stderr: '' };
      }
      if (command === MINIO_CLIENT_BINARY && args.slice(0, 4).join(' ') === 'admin user rm meowbox') {
        return { exitCode: 1, stdout: 'The specified user does not exist', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }));
    await executor.siteEnable(SITE);
  });

  const userRemove = commands.findIndex(({ command, args }) => command === MINIO_CLIENT_BINARY
    && args.slice(0, 3).join(' ') === 'admin user rm');
  const userAdd = commands.findIndex(({ command, args }) => command === MINIO_CLIENT_BINARY
    && args.slice(0, 3).join(' ') === 'admin user add');
  assert.ok(userRemove >= 0 && userRemove < userAdd);
  const siteEnv = writes.find(({ file }) => file.startsWith('/var/www/project_api/.meowbox/minio/.env.tmp-'));
  assert.ok(siteEnv);
  assert.match(siteEnv.content, /^MEOWBOX_MINIO_ACCESS_KEY=mb[a-f0-9]{18}$/m);
  assert.match(siteEnv.content, /^MEOWBOX_MINIO_SECRET_KEY=[a-f0-9]{40}$/m);
  assert.equal(siteEnv.content.includes('MINIO_ROOT_PASSWORD'), false);
  const policy = writes.find(({ file }) => file.includes('/policies/meowbox-site-') && file.includes('.tmp-'));
  assert.ok(policy);
  assert.match(policy.content, /arn:aws:s3:::mb-project-api-[a-f0-9]{10}/);
});

test('site disable fails closed when IAM cleanup fails and leaves site env for retry', { concurrency: false }, async () => {
  const removals = [];
  await withFsStubs({
    lstat: async () => regularFile(),
    readFile: async (file) => {
      if (file === MINIO_ROOT_CREDENTIALS_PATH) return rootCredentials();
      throw new Error(`unexpected read: ${file}`);
    },
    rm: async (...args) => { removals.push(args); },
    unlink: async () => {},
  }, async () => {
    const executor = new MinioExecutor(commandRecorder([], (command, args) => {
      if (command === MINIO_SERVER_BINARY && args[0] === '--version') {
        return { exitCode: 0, stdout: 'minio version RELEASE.2026-01-01T00-00-00Z\n', stderr: '' };
      }
      if (command === 'systemctl' && args[0] === 'is-active') {
        return { exitCode: 0, stdout: 'active\n', stderr: '' };
      }
      if (command === MINIO_CLIENT_BINARY && args.slice(0, 3).join(' ') === 'admin policy detach') {
        return { exitCode: 1, stdout: '', stderr: 'permission denied' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }));
    await assert.rejects(executor.siteDisable(SITE), /Cannot detach MinIO policy/);
  });

  assert.deepEqual(removals, []);
});
