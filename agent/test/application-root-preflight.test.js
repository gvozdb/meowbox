'use strict';

const assert = require('node:assert/strict');
const {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const fixtureBase = mkdtempSync(
  path.join(tmpdir(), 'meowbox-root-preflight-'),
);
process.env.ALLOWED_SITE_ROOT_PREFIXES = fixtureBase;

const {
  ApplicationSnapshotManager,
} = require('../src/runtime/application-snapshot.manager');
const { AgentService } = require('../src/agent.service');

test('non-empty roots require an explicit shared-root allowance', async (t) => {
  t.after(() => rmSync(fixtureBase, { recursive: true, force: true }));
  const siteRoot = path.join(fixtureBase, 'site');
  const applicationRoot = path.join(siteRoot, 'apps', 'monorepo');
  mkdirSync(applicationRoot, { recursive: true });
  writeFileSync(path.join(applicationRoot, 'package.json'), '{}', 'utf8');

  const manager = new ApplicationSnapshotManager();
  const blocked = await manager.preflightCreateRoot({
    rootPath: siteRoot,
    filesRelPath: 'apps/monorepo',
  });
  assert.equal(blocked.success, false);
  assert.match(blocked.error, /already exists and is not empty/);

  const shared = await manager.preflightCreateRoot({
    rootPath: siteRoot,
    filesRelPath: 'apps/monorepo',
    allowExistingRoot: true,
  });
  assert.equal(shared.success, true);
  assert.equal(shared.exists, true);
  assert.equal(shared.isNonEmpty, true);
  assert.equal(shared.applicationRoot, applicationRoot);
});

test('site install reuses a non-empty shared root without invoking an installer', async () => {
  const handlers = new Map();
  const preflightCalls = [];
  const service = Object.create(AgentService.prototype);
  service.socket = { connected: true };
  service.applicationSnapshots = {
    preflightCreateRoot: async (params) => {
      preflightCalls.push(params);
      return { success: true, exists: true, isNonEmpty: true };
    },
  };
  service.installer = {
    scaffoldCustomSite: async () => {
      throw new Error('shared application root must not be scaffolded');
    },
  };
  service.safeOn = (_socket, event, handler) => {
    if (event === 'site:install') handlers.set(event, handler);
  };
  service.registerHandlers();

  const replies = [];
  await handlers.get('site:install')(
    {
      siteId: '10000000-0000-4000-8000-000000000001',
      siteDomainId: '20000000-0000-4000-8000-000000000001',
      preset: 'CUSTOM',
      rootPath: '/var/www/site',
      filesRelPath: 'apps/monorepo',
      reuseExistingRoot: true,
      domain: 'admin.example.test',
      runtimeKey: 'd1234567890abcdef1234',
    },
    (reply) => replies.push(reply),
  );

  assert.deepEqual(preflightCalls, [
    {
      rootPath: '/var/www/site',
      filesRelPath: 'apps/monorepo',
      allowExistingRoot: true,
    },
  ]);
  assert.deepEqual(replies, [
    {
      success: true,
      data: { mutationStarted: false },
      siteDomainId: '20000000-0000-4000-8000-000000000001',
      operationId: undefined,
    },
  ]);
});
