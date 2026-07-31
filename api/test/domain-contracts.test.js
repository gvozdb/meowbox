'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, rmSync, symlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  ConflictException,
  ForbiddenException,
  GoneException,
  InternalServerErrorException,
  NotFoundException,
} = require('@nestjs/common');
const { DomainContextService } = require('../src/sites/domain-context.service');
const { SiteDomainsService } = require('../src/sites/site-domains.service');
const {
  canonicalizeHostname,
  assertRuntimeKey,
  normalizeFilesRelPath,
  resolveApplicationRoot,
  runtimeKeyForDomain,
  validateEnvVars,
} = require('../src/sites/domain-validation');
const { SitesController } = require('../src/sites/sites.controller');
const {
  createHostnameClaims,
  replaceHostnameClaims,
} = require('../src/sites/hostname-registry');

function domainFixture(overrides = {}) {
  return {
    id: '20000000-0000-4000-8000-000000000001',
    siteId: '10000000-0000-4000-8000-000000000001',
    preset: 'CUSTOM',
    phpVersion: null,
    filesRelPath: 'www',
    envVars: '{"NODE_ENV":"production"}',
    site: {
      id: '10000000-0000-4000-8000-000000000001',
      userId: 'owner-user',
      rootPath: '/var/www/example',
    },
    sslCertificate: null,
    databases: [],
    ...overrides,
  };
}

test('domain validation canonicalizes hostnames and rejects unsafe paths', () => {
  assert.equal(canonicalizeHostname(' ExAmPle.COM. '), 'example.com');
  assert.throws(() => canonicalizeHostname('*.example.com'), /Invalid hostname/);
  assert.throws(() => canonicalizeHostname('localhost'), /Invalid hostname/);

  assert.equal(normalizeFilesRelPath('./www//public'), 'www/public');
  assert.equal(normalizeFilesRelPath('www\\public'), 'www/public');
  assert.throws(() => normalizeFilesRelPath('../outside'), /parent traversal/);
  assert.throws(() => normalizeFilesRelPath('/etc'), /relative path/);
  assert.throws(() => normalizeFilesRelPath('C:\\Windows'), /relative path/);
  assert.throws(() => normalizeFilesRelPath('www/public folder'), /Invalid/);

  const runtimeKey = runtimeKeyForDomain(
    '20000000-0000-4000-8000-000000000001',
  );
  assert.match(runtimeKey, /^d[a-f0-9]{20}$/);
  assert.equal(assertRuntimeKey('legacy-site_1'), 'legacy-site_1');
  assert.throws(() => assertRuntimeKey('Legacy-Site'), /Invalid runtime key/);
});

test('domain alias storage canonicalizes names and preserves redirect flags', () => {
  const service = new SiteDomainsService({}, {}, {});
  assert.deepEqual(
    service.normalizeAliases([
      { domain: ' WWW.Example.COM. ', redirect: true },
      'münich.example',
    ]),
    [
      { domain: 'www.example.com', redirect: true },
      { domain: 'xn--mnich-kva.example', redirect: false },
    ],
  );
  assert.throws(
    () => service.normalizeAliases(['Alias.Example.', 'alias.example']),
    /Duplicate aliases/,
  );
});

test('environment variable validation is bounded and deterministic', () => {
  assert.deepEqual(validateEnvVars({ NODE_ENV: 'production' }), {
    NODE_ENV: 'production',
  });
  assert.throws(() => validateEnvVars({ 'INVALID-KEY': 'x' }), /Invalid/);
  assert.throws(
    () => validateEnvVars({ TOO_LARGE: 'x'.repeat(8193) }),
    /Invalid/,
  );
  assert.throws(
    () =>
      validateEnvVars(
        Object.fromEntries(
          Array.from({ length: 101 }, (_, index) => [`KEY_${index}`, 'x']),
        ),
      ),
    /Invalid/,
  );
});

test('hostname claims atomically normalize canonical domains and aliases', async () => {
  const writes = [];
  const tx = {
    hostnameClaim: {
      deleteMany: async (query) => {
        writes.push(['delete', query]);
        return { count: 2 };
      },
      createMany: async (query) => {
        writes.push(['create', query]);
        return { count: query.data.length };
      },
    },
  };

  await createHostnameClaims(tx, {
    siteDomainId: 'domain-id',
    domain: 'Example.COM.',
    aliases:
      '[{"domain":"WWW.Example.COM.","redirect":true},{"domain":"cdn.example.com","redirect":false}]',
  });
  assert.deepEqual(writes[0], [
    'create',
    {
      data: [
        {
          hostname: 'example.com',
          siteDomainId: 'domain-id',
          kind: 'CANONICAL',
        },
        {
          hostname: 'www.example.com',
          siteDomainId: 'domain-id',
          kind: 'ALIAS',
        },
        {
          hostname: 'cdn.example.com',
          siteDomainId: 'domain-id',
          kind: 'ALIAS',
        },
      ],
    },
  ]);

  writes.length = 0;
  await replaceHostnameClaims(tx, {
    siteDomainId: 'domain-id',
    domain: 'example.com',
    aliases: '[]',
  });
  assert.equal(writes[0][0], 'delete');
  assert.equal(writes[1][0], 'create');

  await assert.rejects(
    () =>
      createHostnameClaims(tx, {
        siteDomainId: 'domain-id',
        domain: 'example.com',
        aliases: '["example.com"]',
      }),
    ConflictException,
  );
});

test('application root rejects lexical and symlink escapes', (t) => {
  assert.equal(
    resolveApplicationRoot('/var/www/example', 'www/public'),
    '/var/www/example/www/public',
  );
  assert.throws(
    () => resolveApplicationRoot('/var/www/example', '../outside'),
    /parent traversal/,
  );

  const fixtureRoot = mkdtempSync(
    path.join(tmpdir(), 'meowbox-domain-validation-'),
  );
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const siteRoot = path.join(fixtureRoot, 'site');
  const outsideRoot = path.join(fixtureRoot, 'outside');
  mkdirSync(siteRoot);
  mkdirSync(outsideRoot);
  symlinkSync(outsideRoot, path.join(siteRoot, 'app'));

  assert.throws(
    () =>
      resolveApplicationRoot(siteRoot, 'app', {
        resolveSymlinks: true,
      }),
    /escapes the Site root/,
  );
});

test('domain context always nests domain lookup under site and enforces owner', async () => {
  let capturedQuery;
  const prisma = {
    siteDomain: {
      findFirst: async (query) => {
        capturedQuery = query;
        return domainFixture();
      },
    },
  };
  const service = new DomainContextService(prisma);
  const context = await service.requireOwnedSiteDomain(
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'owner-user',
    'MANAGER',
  );

  assert.deepEqual(capturedQuery.where, {
    id: '20000000-0000-4000-8000-000000000001',
    siteId: '10000000-0000-4000-8000-000000000001',
  });
  assert.equal(context.applicationRoot, '/var/www/example/www');
  assert.deepEqual(context.envVars, { NODE_ENV: 'production' });
  assert.equal(context.primaryDatabase, null);

  prisma.siteDomain.findFirst = async () =>
    domainFixture({ site: { userId: 'different-user', rootPath: '/var/www/example' } });
  await assert.rejects(
    () =>
      service.requireOwnedSiteDomain(
        '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001',
        'owner-user',
        'MANAGER',
      ),
    ForbiddenException,
  );

  prisma.siteDomain.findFirst = async () => null;
  await assert.rejects(
    () =>
      service.requireOwnedSiteDomain(
        '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001',
        'owner-user',
        'ADMIN',
      ),
    NotFoundException,
  );
});

test('legacy Site-level application routes fail explicitly', () => {
  const controller = new SitesController({}, {});
  const legacyMethods = [
    'changeCmsAdminPassword',
    'updateModxVersion',
    'normalizePermissions',
    'modxDoctor',
    'cleanupSetupDir',
    'getSiteMetrics',
    'getPhpPoolConfig',
    'updatePhpPoolConfig',
  ];

  for (const method of legacyMethods) {
    assert.throws(() => controller[method](), GoneException, method);
  }
});

test('Nginx hostname registry validation fails closed', async () => {
  const offline = new SiteDomainsService(
    {},
    { isAgentConnected: () => false },
    {},
  );
  await assert.rejects(
    () => offline.ensureDomainFreeInNginx(['example.test']),
    ConflictException,
  );

  const collision = new SiteDomainsService(
    {},
    {
      isAgentConnected: () => true,
      emitToAgent: async () => ({
        success: true,
        data: {
          hits: [
            {
              file: 'example.test.conf',
              line: 'server_name example.test;',
            },
          ],
        },
      }),
    },
    {},
  );
  await assert.rejects(
    () => collision.ensureDomainFreeInNginx(['example.test']),
    ConflictException,
  );

  const unavailable = new SiteDomainsService(
    {},
    {
      isAgentConnected: () => true,
      emitToAgent: async () => {
        throw new Error('agent timeout');
      },
    },
    {},
  );
  await assert.rejects(
    () => unavailable.ensureDomainFreeInNginx(['example.test']),
    InternalServerErrorException,
  );
});
