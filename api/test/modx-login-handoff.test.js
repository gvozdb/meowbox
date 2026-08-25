'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.DOTENV_PATH = path.join(os.tmpdir(), 'meowbox-modx-handoff-test-env-does-not-exist');
process.env.MEOWBOX_MASTER_KEY = Buffer.alloc(32, 0x41).toString('base64');

const masterKey = require('../src/common/crypto/master-key');
masterKey._resetMasterKeyCacheForTests();
const { encryptCmsPassword } = require('../src/common/crypto/cms-cipher');
const { DomainApplicationsService } = require('../src/sites/domain-applications.service');
const { validatePublicDelivery } = require('../../shared/src/public-delivery');

const TARGET_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const DOMAIN_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';

function domain() {
  return {
    id: DOMAIN_ID,
    domain: 'site.example',
    preset: 'MODX_REVO',
    appStatus: 'READY',
    appErrorMessage: null,
    filesRelPath: 'www',
    phpVersion: '8.3',
    phpPoolCustom: null,
    runtimeKey: 'fixture',
    gitRepository: null,
    deployBranch: null,
    cmsAdminUser: 'modx-admin-fixture',
    cmsAdminPasswordEnc: encryptCmsPassword('modx-password-fixture'),
    managerPath: 'secure-manager',
    connectorsPath: 'connectors',
    cmsTablePrefix: 'modx_',
    modxVersion: '2.8.8-pl',
    appPort: null,
    sslCertificate: { status: 'ACTIVE' },
  };
}

function fixture() {
  const value = domain();
  const prisma = {
    siteDomain: {
      findFirst: async ({ where }) => where.id === DOMAIN_ID && where.siteId === SITE_ID
        ? value
        : null,
    },
  };
  const domains = {
    requireOwnedSiteDomain: async () => ({
      site: {
        id: SITE_ID,
        name: 'fixture',
        rootPath: '/var/www/fixture',
        systemUser: 'fixture',
      },
      domain: value,
      applicationRoot: '/var/www/fixture/www',
      isModx: true,
      phpEnabled: true,
      primaryDatabase: { id: 'db-fixture', name: 'fixture', type: 'MARIADB' },
    }),
  };
  const identity = {
    getLocalIdentity: async () => ({ installationId: TARGET_ID }),
  };
  const origins = { browserPublicOrigin: () => 'https://target.example:11862' };
  return new DomainApplicationsService(
    prisma,
    {},
    domains,
    {},
    {},
    identity,
    origins,
  );
}

test('T-MODX-001 issues typed target-origin fragment handoff without credential exposure', async () => {
  const service = fixture();
  const delivery = validatePublicDelivery(
    await service.createLoginHandoff(
      SITE_ID,
      DOMAIN_ID,
      USER_ID,
      'ADMIN',
      'modx-login-test-issue',
    ),
  );
  assert.equal(delivery.kind, 'AppHandoff');
  assert.equal(delivery.purpose, 'MODX_LOGIN');
  assert.equal(delivery.targetInstallationId, TARGET_ID);
  assert.deepEqual(delivery.resource, { kind: 'SITE_DOMAIN', id: DOMAIN_ID });
  assert.equal(delivery.browserReachabilityRequired, true);
  assert.match(
    delivery.url,
    /^https:\/\/target\.example:11862\/api\/public\/v1\/modx\/login#handoff=[A-Za-z0-9_-]{43}$/,
  );
  const parsed = new URL(delivery.url);
  assert.equal(parsed.search, '');
  assert.equal(parsed.pathname.includes('modx-admin-fixture'), false);
  assert.equal(JSON.stringify(delivery).includes('modx-password-fixture'), false);
});

test('T-MODX-002 consumes exactly once and posts credentials only from target origin', async () => {
  const service = fixture();
  const delivery = await service.createLoginHandoff(
    SITE_ID,
    DOMAIN_ID,
    USER_ID,
    'ADMIN',
    'modx-login-test-consume',
  );
  const token = new URL(delivery.url).hash.slice('#handoff='.length);
  const results = await Promise.allSettled([
    service.consumeLoginHandoff(token),
    service.consumeLoginHandoff(token),
  ]);
  const success = results.find((result) => result.status === 'fulfilled');
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.match(success.value, /action="https:\/\/site\.example\/secure-manager\/"/);
  assert.match(success.value, /name="username" value="modx-admin-fixture"/);
  assert.match(success.value, /name="password" value="modx-password-fixture"/);
  assert.doesNotMatch(success.value, /target\.document|window\.opener/);
});

test('T-MODX-004 idempotency returns one handoff under concurrent retries', async () => {
  const service = fixture();
  const deliveries = await Promise.all([
    service.createLoginHandoff(
      SITE_ID,
      DOMAIN_ID,
      USER_ID,
      'ADMIN',
      'modx-login-test-replay',
    ),
    service.createLoginHandoff(
      SITE_ID,
      DOMAIN_ID,
      USER_ID,
      'ADMIN',
      'modx-login-test-replay',
    ),
  ]);
  assert.deepEqual(deliveries[0], deliveries[1]);
});

test('T-MODX-003 bootstrap strips fragment before same-origin consume and legacy flow is gone', () => {
  const controller = fs.readFileSync(
    path.resolve(__dirname, '../src/sites/domain-applications.controller.ts'),
    'utf8',
  );
  const page = fs.readFileSync(path.resolve(__dirname, '../../web/pages/sites/[id].vue'), 'utf8');
  assert.match(controller, /history\.replaceState/);
  assert.ok(controller.indexOf('history.replaceState') < controller.indexOf('form.submit()'));
  assert.match(controller, /form\.action = '\/api\/public\/v1\/modx\/login\/consume'/);
  assert.match(controller, /Legacy MODX login handoff is disabled/);
  assert.match(page, /navigateModxHandoff\(handoff, target\)/);
  assert.doesNotMatch(page, /target\.document\.write/);
  assert.doesNotMatch(page, /\/domain-app-login\//);
});
